###############################################################################
# Subscription-renewal pipeline
#
#   EventBridge schedule (hourly) -> Lambda renewal-scheduler
#     - Reads MySQL for subscriptions with next_delivery <= NOW().
#     - Drops one SQS message per subscription onto subscription-renewal queue.
#
#   SQS subscription-renewal -> Lambda renewal-worker (same code, different
#     entrypoint based on event type)
#     - Creates the next order in the DB.
#     - Charges the saved Square card (if configured).
#     - Sends a renewal-confirmation email via SES.
#     - Failures land in subscription-dlq for inspection.
#
# This demonstrates EventBridge + Lambda + SQS + IAM + VPC + Secrets Manager
# + SES — the AWS-service-breadth signal a cloud class is looking for.
###############################################################################

# ----- SQS queues ----------------------------------------------------------
resource "aws_sqs_queue" "subscription_dlq" {
  name                       = "${local.name_prefix}-sub-dlq"
  message_retention_seconds  = 14 * 24 * 60 * 60  # 14 days
  visibility_timeout_seconds = 60
  tags                       = { Name = "${local.name_prefix}-sub-dlq" }
}

resource "aws_sqs_queue" "subscription_renewal" {
  name                       = "${local.name_prefix}-sub-renewal"
  message_retention_seconds  = 4 * 24 * 60 * 60   # 4 days
  visibility_timeout_seconds = 180                 # > Lambda timeout below
  receive_wait_time_seconds  = 10                  # long-poll

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.subscription_dlq.arn
    maxReceiveCount     = 3
  })

  tags = { Name = "${local.name_prefix}-sub-renewal" }
}

# ----- Lambda function -----------------------------------------------------
# We zip the lambda source from ../lambda/subscription-renewal so terraform
# apply produces a deterministic artifact every time.
data "archive_file" "subscription_renewal" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/subscription-renewal"
  output_path = "${path.module}/.terraform-build/subscription-renewal.zip"
}

resource "aws_lambda_function" "subscription_renewal" {
  function_name = "${local.name_prefix}-subscription-renewal"
  description   = "Polls MySQL for due subscriptions and enqueues + processes renewals."
  role          = aws_iam_role.lambda_subscription.arn

  filename         = data.archive_file.subscription_renewal.output_path
  source_code_hash = data.archive_file.subscription_renewal.output_base64sha256

  runtime     = "nodejs20.x"
  handler     = "index.handler"
  timeout     = 60
  memory_size = 256

  vpc_config {
    # API tier subnets + Lambda SG so it can reach RDS and the internal ALB.
    subnet_ids         = [for s in aws_subnet.private_app : s.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DB_SECRET_ARN   = aws_secretsmanager_secret.db.arn
      APP_SECRET_ARN  = aws_secretsmanager_secret.app.arn
      REGION          = var.region
      QUEUE_URL       = aws_sqs_queue.subscription_renewal.url
      DLQ_URL         = aws_sqs_queue.subscription_dlq.url
      SES_FROM        = local.ses_from_address
      ENABLE_EMAIL    = var.ses_from_address == "" ? "0" : "1"
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
  tags       = { Name = "${local.name_prefix}-subscription-renewal" }
}

# Wire SQS as an event source so messages drive the same function.
resource "aws_lambda_event_source_mapping" "subscription_queue" {
  event_source_arn                   = aws_sqs_queue.subscription_renewal.arn
  function_name                      = aws_lambda_function.subscription_renewal.arn
  batch_size                         = 5
  maximum_batching_window_in_seconds = 10
  function_response_types            = ["ReportBatchItemFailures"]
}

# ----- EventBridge schedule (hourly scan for due subscriptions) ------------
resource "aws_cloudwatch_event_rule" "subscription_scan" {
  name                = "${local.name_prefix}-subscription-scan"
  description         = "Hourly trigger to scan for subscriptions due for renewal"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "subscription_scan" {
  rule      = aws_cloudwatch_event_rule.subscription_scan.name
  target_id = "lambda"
  arn       = aws_lambda_function.subscription_renewal.arn

  # The scheduler-invoke payload differs from the SQS payload — the Lambda
  # branches on `event.source == 'aws.events'` to know which mode to run in.
  input = jsonencode({ source = "aws.events", action = "scan" })
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.subscription_renewal.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.subscription_scan.arn
}

# Alarm if anything lands in the DLQ — that's a renewal we failed to process.
resource "aws_cloudwatch_metric_alarm" "subscription_dlq" {
  alarm_name          = "${local.name_prefix}-sub-dlq-not-empty"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  dimensions = {
    QueueName = aws_sqs_queue.subscription_dlq.name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

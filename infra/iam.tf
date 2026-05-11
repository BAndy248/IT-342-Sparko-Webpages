###############################################################################
# IAM roles & policies — least-privilege at the API layer
#
#   ec2_instance_role: attached to every EC2 (web + API) via instance profile.
#     - CloudWatchAgentServerPolicy (logs/metrics)
#     - AmazonSSMManagedInstanceCore (SSM Session Manager — no SSH key required)
#     - Inline: read the Sparko secret + put logs to its own log streams
#
#   lambda_subscription_role:
#     - VPC ENI management (AWSLambdaVPCAccessExecutionRole)
#     - SQS send/receive
#     - Secrets Manager read for DB password
#     - SES send for retry-notification emails
###############################################################################

# --------- EC2 instance role -------------------------------------------------
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_instance" {
  name               = "${local.name_prefix}-ec2"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "cwagent" {
  role       = aws_iam_role.ec2_instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ec2_instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Inline secrets policy — narrow to just the secrets this app needs.
data "aws_iam_policy_document" "ec2_secrets" {
  statement {
    sid     = "ReadAppSecrets"
    actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [
      aws_secretsmanager_secret.app.arn,
      aws_secretsmanager_secret.db.arn
    ]
  }

  # Push custom JSON logs from the app even when the agent isn't configured.
  statement {
    sid = "CloudWatchLogsAppStreams"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams"
    ]
    resources = [
      "${aws_cloudwatch_log_group.api.arn}:*",
      "${aws_cloudwatch_log_group.web.arn}:*"
    ]
  }

  # Let API instances send transactional email via SES.
  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.ses_from_address]
    }
  }
}

resource "aws_iam_role_policy" "ec2_secrets" {
  name   = "${local.name_prefix}-ec2-secrets"
  role   = aws_iam_role.ec2_instance.id
  policy = data.aws_iam_policy_document.ec2_secrets.json
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name_prefix}-ec2"
  role = aws_iam_role.ec2_instance.name
}

# --------- Lambda subscription-renewal role ----------------------------------
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_subscription" {
  name               = "${local.name_prefix}-lambda-sub"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda_subscription.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_subscription.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda_inline" {
  statement {
    sid = "SqsQueue"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl"
    ]
    resources = [
      aws_sqs_queue.subscription_renewal.arn,
      aws_sqs_queue.subscription_dlq.arn
    ]
  }

  statement {
    sid       = "ReadDbSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn, aws_secretsmanager_secret.app.arn]
  }

  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.ses_from_address]
    }
  }
}

resource "aws_iam_role_policy" "lambda_inline" {
  name   = "${local.name_prefix}-lambda-inline"
  role   = aws_iam_role.lambda_subscription.id
  policy = data.aws_iam_policy_document.lambda_inline.json
}

# --------- CI/CD deploy role (assumed by GitHub Actions via OIDC) ------------
# Optional but very class-friendly: shows AWS-side OIDC trust between GitHub
# and AWS so the CI workflow doesn't need long-lived access keys.
data "aws_iam_policy_document" "github_oidc_assume" {
  count = var.github_repo == "" ? 0 : 1

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_repo == "" ? 0 : 1

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"] # GitHub's public thumbprint
}

resource "aws_iam_role" "github_deploy" {
  count              = var.github_repo == "" ? 0 : 1
  name               = "${local.name_prefix}-gha-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_oidc_assume[0].json
}

data "aws_iam_policy_document" "github_deploy" {
  count = var.github_repo == "" ? 0 : 1

  # Trigger ASG instance refreshes (rolling deploy) + read what they need.
  statement {
    sid = "AsgDeploy"
    actions = [
      "autoscaling:StartInstanceRefresh",
      "autoscaling:DescribeAutoScalingGroups",
      "autoscaling:DescribeInstanceRefreshes",
      "ec2:DescribeInstances",
      "ec2:DescribeImages"
    ]
    resources = ["*"]
  }

  # Push frontend builds to the S3 origin bucket + bust CloudFront.
  statement {
    sid       = "FrontendS3"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetObject"]
    resources = [aws_s3_bucket.static_assets.arn, "${aws_s3_bucket.static_assets.arn}/*"]
  }

  statement {
    sid       = "Invalidate"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = ["*"]
  }

  # Update + redeploy Lambda code.
  statement {
    sid = "LambdaDeploy"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:GetFunction",
      "lambda:PublishVersion"
    ]
    resources = [aws_lambda_function.subscription_renewal.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count  = var.github_repo == "" ? 0 : 1
  name   = "${local.name_prefix}-gha-deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}

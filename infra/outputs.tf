###############################################################################
# Outputs — pasted into demo docs, CI workflows, and operator runbooks.
###############################################################################

output "public_url" {
  description = "Public URL to visit. Uses the configured domain if set, otherwise the raw ALB DNS."
  value       = var.domain_name == "" ? "http://${aws_lb.public.dns_name}" : "https://${var.domain_name}"
}

output "public_alb_dns" {
  description = "Public ALB DNS name (in case Route 53 isn't set up)."
  value       = aws_lb.public.dns_name
}

output "internal_alb_dns" {
  description = "Internal ALB DNS the web tier proxies to."
  value       = aws_lb.internal.dns_name
}

output "rds_endpoint" {
  description = "RDS connection endpoint."
  value       = aws_db_instance.main.address
}

output "rds_port" {
  value = aws_db_instance.main.port
}

output "db_name" {
  value = aws_db_instance.main.db_name
}

output "db_secret_arn" {
  description = "ARN of the Secrets Manager secret holding DB credentials."
  value       = aws_secretsmanager_secret.db.arn
}

output "app_secret_arn" {
  description = "ARN of the Secrets Manager secret holding app secrets (JWT, Square)."
  value       = aws_secretsmanager_secret.app.arn
}

output "cloudfront_url" {
  description = "CDN URL for static assets."
  value       = "https://${aws_cloudfront_distribution.static.domain_name}"
}

output "static_assets_bucket" {
  description = "S3 bucket name for static assets (CI uploads here)."
  value       = aws_s3_bucket.static_assets.id
}

output "api_log_group" {
  value = aws_cloudwatch_log_group.api.name
}

output "web_log_group" {
  value = aws_cloudwatch_log_group.web.name
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "dashboard_url" {
  description = "CloudWatch dashboard URL."
  value       = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "asg_api_name" {
  description = "API ASG name — pass to 'aws autoscaling start-instance-refresh' for rolling deploys."
  value       = aws_autoscaling_group.api.name
}

output "asg_web_name" {
  value = aws_autoscaling_group.web.name
}

output "lambda_subscription_name" {
  value = aws_lambda_function.subscription_renewal.function_name
}

output "subscription_queue_url" {
  value = aws_sqs_queue.subscription_renewal.url
}

output "github_deploy_role_arn" {
  description = "Role for GitHub Actions to assume via OIDC. Empty when github_repo isn't set."
  value       = var.github_repo == "" ? "" : aws_iam_role.github_deploy[0].arn
}

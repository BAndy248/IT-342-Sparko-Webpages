###############################################################################
# CloudWatch — log groups, alarms, dashboard, SNS topic for alerts
###############################################################################

resource "aws_cloudwatch_log_group" "api" {
  name              = "/sparko/api"
  retention_in_days = 30
  tags              = { Name = "${local.name_prefix}-api-logs" }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/sparko/web"
  retention_in_days = 30
  tags              = { Name = "${local.name_prefix}-web-logs" }
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name_prefix}-subscription-renewal"
  retention_in_days = 30
}

# ---------- SNS topic for alerts -------------------------------------------
resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ---------- Alarms ---------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name_prefix}-alb-5xx-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  threshold           = 10
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  alarm_description   = "ALB target group is returning 5XXs"
  treat_missing_data  = "notBreaching"
  dimensions = {
    LoadBalancer = aws_lb.public.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_latency_p99" {
  alarm_name          = "${local.name_prefix}-alb-latency-p99"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  threshold           = 1.5
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  extended_statistic  = "p99"
  alarm_description   = "ALB p99 response time > 1.5s for 3 minutes"
  treat_missing_data  = "notBreaching"
  dimensions = {
    LoadBalancer = aws_lb.public.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_healthy_hosts" {
  alarm_name          = "${local.name_prefix}-api-healthy-hosts-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  threshold           = 1
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  alarm_description   = "API target group has < 1 healthy hosts"
  treat_missing_data  = "breaching"
  dimensions = {
    LoadBalancer = aws_lb.internal.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name_prefix}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  threshold           = 80
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${local.name_prefix}-rds-storage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  threshold           = 2 * 1024 * 1024 * 1024  # 2 GiB
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Minimum"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${local.name_prefix}-rds-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  threshold           = 100
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

# ---------- Dashboard ------------------------------------------------------
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name_prefix}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "ALB requests / 5XX"
          region = var.region
          stat   = "Sum"
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.public.arn_suffix],
            [".", "HTTPCode_Target_5XX_Count", ".", "."],
            [".", "HTTPCode_Target_4XX_Count", ".", "."]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12, y = 0, width = 12, height = 6
        properties = {
          title  = "ALB target latency p50/p99"
          region = var.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.public.arn_suffix, { stat = "p50" }],
            ["...", { stat = "p99" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0, y = 6, width = 12, height = 6
        properties = {
          title  = "API healthy hosts"
          region = var.region
          period = 60
          stat   = "Minimum"
          view   = "timeSeries"
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount",   "TargetGroup", aws_lb_target_group.api.arn_suffix, "LoadBalancer", aws_lb.internal.arn_suffix],
            [".",                  "UnHealthyHostCount", ".",           ".",                                ".",            "."]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "RDS CPU / connections"
          region = var.region
          period = 60
          view   = "timeSeries"
          metrics = [
            ["AWS/RDS", "CPUUtilization",     "DBInstanceIdentifier", aws_db_instance.main.id],
            [".",       "DatabaseConnections", ".",                   "."]
          ]
        }
      },
      {
        type   = "log"
        x      = 0, y = 12, width = 24, height = 6
        properties = {
          title  = "Recent API errors"
          region = var.region
          query  = "SOURCE '${aws_cloudwatch_log_group.api.name}' | fields @timestamp, level, message, error, requestId, path | filter level = 'error' | sort @timestamp desc | limit 50"
        }
      }
    ]
  })
}

# ---------- WAF (regional, attached to public ALB) -------------------------
resource "aws_wafv2_web_acl" "main" {
  name        = "${local.name_prefix}-waf"
  description = "Public ALB WAF — common managed rule groups"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "AWS-CommonRuleSet"
    priority = 1
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    override_action { none {} }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "CommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWS-KnownBadInputs"
    priority = 2
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    override_action { none {} }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "KnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimit2000PerMin"
    priority = 3
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    action { block {} }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimit2000PerMin"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-waf"
    sampled_requests_enabled   = true
  }

  tags = { Name = "${local.name_prefix}-waf" }
}

resource "aws_wafv2_web_acl_association" "public_alb" {
  resource_arn = aws_lb.public.arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}

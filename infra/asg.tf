###############################################################################
# Launch templates + Auto Scaling Groups for both the web and API tiers.
#
# Both ASGs:
#   - Span private_app subnets across AZs.
#   - Use IMDSv2 only (http_tokens = required).
#   - Have a target tracking scaling policy on average CPU.
#   - Use instance_refresh so a Launch Template revision rolls out instances
#     one at a time without dropping the ALB target group below 90% capacity.
###############################################################################

# ---------------- API tier --------------------------------------------------
locals {
  api_user_data = base64encode(templatefile("${path.module}/user_data_api.sh.tpl", {
    repo_url             = var.repo_url
    repo_branch          = var.repo_branch
    db_secret_arn        = aws_secretsmanager_secret.db.arn
    app_secret_arn       = aws_secretsmanager_secret.app.arn
    region               = var.region
    cloudwatch_log_group = aws_cloudwatch_log_group.api.name
    frontend_url         = local.effective_frontend_url
  }))

  web_user_data = base64encode(templatefile("${path.module}/user_data_web.sh.tpl", {
    repo_url             = var.repo_url
    repo_branch          = var.repo_branch
    internal_alb_dns     = aws_lb.internal.dns_name
    server_name          = var.domain_name == "" ? "_" : var.domain_name
    region               = var.region
    cloudwatch_log_group = aws_cloudwatch_log_group.web.name
  }))
}

resource "aws_launch_template" "api" {
  name_prefix   = "${local.name_prefix}-api-"
  image_id      = data.aws_ssm_parameter.al2023_ami.value
  instance_type = var.api_instance_type

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2.name
  }

  vpc_security_group_ids = [aws_security_group.api.id]

  key_name = var.ssh_key_name == "" ? null : var.ssh_key_name

  # Force IMDSv2. EC2 metadata is reachable only with a 1-hop signed token.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 20
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = local.api_user_data

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "${local.name_prefix}-api"
      Tier = "api"
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "api" {
  name                      = "${local.name_prefix}-api"
  vpc_zone_identifier       = [for s in aws_subnet.private_app : s.id]
  target_group_arns         = [aws_lb_target_group.api.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 180
  min_size                  = var.api_min_size
  max_size                  = var.api_max_size
  desired_capacity          = var.api_min_size

  launch_template {
    id      = aws_launch_template.api.id
    version = "$Latest"
  }

  # Rolling deploys — replace instances with 90% minimum healthy so the API
  # never drops below 1 healthy host during a refresh.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 90
      instance_warmup        = 180
    }
  }

  tag {
    key                 = "Name"
    value               = "${local.name_prefix}-api"
    propagate_at_launch = true
  }
  tag {
    key                 = "Tier"
    value               = "api"
    propagate_at_launch = true
  }
}

# Scale on average CPU — keeps the tier sized to load without manual fiddling.
resource "aws_autoscaling_policy" "api_cpu" {
  name                   = "${local.name_prefix}-api-cpu"
  autoscaling_group_name = aws_autoscaling_group.api.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
  }
}

# ---------------- Web tier --------------------------------------------------
resource "aws_launch_template" "web" {
  name_prefix   = "${local.name_prefix}-web-"
  image_id      = data.aws_ssm_parameter.al2023_ami.value
  instance_type = var.web_instance_type

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2.name
  }

  vpc_security_group_ids = [aws_security_group.web.id]
  key_name               = var.ssh_key_name == "" ? null : var.ssh_key_name

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 10
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = local.web_user_data

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "${local.name_prefix}-web"
      Tier = "web"
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "web" {
  name                      = "${local.name_prefix}-web"
  vpc_zone_identifier       = [for s in aws_subnet.private_app : s.id]
  target_group_arns         = [aws_lb_target_group.web.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 180
  min_size                  = var.web_min_size
  max_size                  = var.web_max_size
  desired_capacity          = var.web_min_size

  launch_template {
    id      = aws_launch_template.web.id
    version = "$Latest"
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 90
      instance_warmup        = 120
    }
  }

  tag {
    key                 = "Name"
    value               = "${local.name_prefix}-web"
    propagate_at_launch = true
  }
  tag {
    key                 = "Tier"
    value               = "web"
    propagate_at_launch = true
  }
}

resource "aws_autoscaling_policy" "web_cpu" {
  name                   = "${local.name_prefix}-web-cpu"
  autoscaling_group_name = aws_autoscaling_group.web.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
  }
}

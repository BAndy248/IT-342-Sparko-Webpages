###############################################################################
# Two Application Load Balancers
#
#   public ALB  - internet-facing - target group: web tier  (nginx, port 80)
#   internal ALB- VPC-private    - target group: API tier  (Node, port 3000)
#
# Why two? The web tier proxies static + dynamic; the internal ALB lets the
# web tier address the API by a stable DNS name regardless of how many API
# nodes are running. nginx points at internal-ALB DNS and gets transparent
# load-balancing + health-aware routing for free.
###############################################################################

# ------------------ public ALB ----------------------------------------------
resource "aws_lb" "public" {
  name               = "${local.name_prefix}-public"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb_public.id]
  subnets            = [for s in aws_subnet.public : s.id]

  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "prod"
  idle_timeout               = 60

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "public"
    enabled = true
  }

  tags = { Name = "${local.name_prefix}-public" }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web"
  port        = 80
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = aws_vpc.main.id

  health_check {
    path                = "/nginx-health"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
    matcher             = "200"
  }

  deregistration_delay = 30
  tags                 = { Name = "${local.name_prefix}-web" }
}

# Plain HTTP listener — redirects to HTTPS when a domain is configured;
# otherwise serves traffic directly (class-demo mode without a real domain).
resource "aws_lb_listener" "public_http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = var.domain_name == "" ? "forward" : "redirect"

    dynamic "forward" {
      for_each = var.domain_name == "" ? [1] : []
      content {
        target_group {
          arn = aws_lb_target_group.web.arn
        }
      }
    }

    dynamic "redirect" {
      for_each = var.domain_name == "" ? [] : [1]
      content {
        status_code = "HTTP_301"
        port        = "443"
        protocol    = "HTTPS"
        host        = "#{host}"
        path        = "/#{path}"
        query       = "#{query}"
      }
    }
  }
}

resource "aws_lb_listener" "public_https" {
  count = var.domain_name == "" ? 0 : 1

  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2+ only; AWS-managed policy keeps cipher list current.
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.public[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# ------------------ internal ALB --------------------------------------------
resource "aws_lb" "internal" {
  name               = "${local.name_prefix}-internal"
  load_balancer_type = "application"
  internal           = true
  security_groups    = [aws_security_group.alb_internal.id]
  subnets            = [for s in aws_subnet.private_app : s.id]
  idle_timeout       = 60

  tags = { Name = "${local.name_prefix}-internal" }
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = aws_vpc.main.id

  health_check {
    # /readyz returns 503 when the DB is unreachable, so the ALB drains a node
    # that can't actually serve traffic — that's the redundancy contract.
    path                = "/readyz"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
    matcher             = "200"
  }

  deregistration_delay = 30
  tags                 = { Name = "${local.name_prefix}-api" }
}

resource "aws_lb_listener" "internal_http" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

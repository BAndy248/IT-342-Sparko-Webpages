###############################################################################
# Security group tiering — least-privilege at the network layer
#
#   internet --> alb_public_sg (80/443)
#   alb_public_sg --> web_sg (80)
#   web_sg --> api_sg (3000)
#   api_sg --> db_sg (3306)
#
# Lambda for subscription renewal also sits in api_sg via VPC config so the
# function can reach the API health endpoint over the same path.
###############################################################################

# Public ALB — accepts 80/443 from anywhere.
resource "aws_security_group" "alb_public" {
  name        = "${local.name_prefix}-alb-public"
  description = "Public ALB ingress from internet"
  vpc_id      = aws_vpc.main.id

  ingress {
    description      = "HTTP from anywhere"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTPS from anywhere"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    description = "ALB outbound to web tier"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-alb-public" }
}

# Web tier (nginx) — only the public ALB may hit it on port 80.
resource "aws_security_group" "web" {
  name        = "${local.name_prefix}-web"
  description = "Web (nginx) tier"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTP from public ALB only"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_public.id]
  }

  dynamic "ingress" {
    for_each = var.ssh_ingress_cidr == "" ? [] : [1]
    content {
      description = "SSH from operator/bastion CIDR"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [var.ssh_ingress_cidr]
    }
  }

  egress {
    description = "all outbound (NPM, CloudWatch, etc.)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-web" }
}

# Internal ALB — only the web tier may hit it. This is the redundancy seam
# that lets the web nginx instances find healthy API instances.
resource "aws_security_group" "alb_internal" {
  name        = "${local.name_prefix}-alb-internal"
  description = "Internal ALB sitting in front of the API tier"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTP from web tier"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id]
  }

  egress {
    description = "internal ALB outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-alb-internal" }
}

# API tier (Node) — only the internal ALB may hit port 3000.
resource "aws_security_group" "api" {
  name        = "${local.name_prefix}-api"
  description = "API tier (Node.js on port 3000)"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "API port from internal ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_internal.id]
  }

  # Lambda subscription-renewal sits in lambda_sg and can call the internal
  # ALB; defining its access here keeps the route closed to all other sources.
  ingress {
    description     = "API port from Lambda (subscription renewal)"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  dynamic "ingress" {
    for_each = var.ssh_ingress_cidr == "" ? [] : [1]
    content {
      description = "SSH from operator/bastion CIDR"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [var.ssh_ingress_cidr]
    }
  }

  egress {
    description = "all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-api" }
}

# Database tier — only API + Lambda may speak MySQL.
resource "aws_security_group" "db" {
  name        = "${local.name_prefix}-db"
  description = "RDS MySQL"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "MySQL from API tier"
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }

  ingress {
    description     = "MySQL from Lambda"
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  egress {
    description = "no outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["127.0.0.1/32"]
  }

  tags = { Name = "${local.name_prefix}-db" }
}

# Lambda SG — needs outbound to RDS + the internal ALB.
resource "aws_security_group" "lambda" {
  name        = "${local.name_prefix}-lambda"
  description = "Subscription-renewal Lambda"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "all outbound (Lambda needs DNS, AWS APIs, RDS)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-lambda" }
}

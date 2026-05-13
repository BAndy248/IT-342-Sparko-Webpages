###############################################################################
# Route 53 record + ACM certificate
#
# Only created when var.domain_name + var.route53_zone_id are set, so the
# stack still applies cleanly without a real domain (class demo using the
# ALB's *.elb.amazonaws.com URL).
###############################################################################

# ACM cert for the public ALB. Must live in the same region as the ALB.
resource "aws_acm_certificate" "public" {
  count = var.domain_name == "" ? 0 : 1

  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name_prefix}-public" }
}

# CloudFront cert for the static-assets domain. CloudFront *only* trusts
# us-east-1 certificates regardless of the rest of the stack's region.
resource "aws_acm_certificate" "cloudfront" {
  count    = var.domain_name == "" ? 0 : 1
  provider = aws.us_east_1

  domain_name       = "cdn.${var.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records — Route 53 auto-creates the _<token>.acm-validations
# entries that ACM needs to confirm we own the domain.
resource "aws_route53_record" "public_validation" {
  for_each = var.domain_name == "" ? {} : {
    for dvo in aws_acm_certificate.public[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "public" {
  count                   = var.domain_name == "" ? 0 : 1
  certificate_arn         = aws_acm_certificate.public[0].arn
  validation_record_fqdns = [for r in aws_route53_record.public_validation : r.fqdn]
}

# Apex + www A records pointing at the ALB.
resource "aws_route53_record" "apex" {
  count   = var.domain_name == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "www" {
  count   = var.domain_name == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

# cdn.<domain> -> CloudFront (defined in s3_cloudfront.tf).
resource "aws_route53_record" "cdn" {
  count   = var.domain_name == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = "cdn.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.static.domain_name
    zone_id                = aws_cloudfront_distribution.static.hosted_zone_id
    evaluate_target_health = false
  }
}

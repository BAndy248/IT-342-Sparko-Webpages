locals {
  name_prefix = "${var.project}-${var.environment}"

  # Pick the first N AZs from the region. Using slice() keeps the AZ choice
  # deterministic across plans rather than depending on AWS account ordering.
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # /16 VPC carved into /20 chunks (4096 IPs each):
  #   public_subnets:  ALB sits here, needs public IPs
  #   private_app:     EC2 (web + API tier)
  #   private_data:    RDS only
  # cidrsubnet(prefix, newbits, netnum) — 4 newbits = /20 inside a /16.
  public_subnet_cidrs       = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_app_subnet_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 4)]
  private_data_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  # Effective FRONTEND_URL for the API: explicit override > Route 53 alias > ALB DNS.
  effective_frontend_url = coalesce(
    var.frontend_url,
    var.domain_name != "" ? "https://${var.domain_name}" : null,
    "http://${aws_lb.public.dns_name}"
  )

  # IAM policies want a literal string for ses:FromAddress. If the operator
  # didn't set one, fall back to a placeholder that won't match anything —
  # which is the correct outcome (no SES send allowed).
  ses_from_address = coalesce(
    var.ses_from_address,
    var.domain_name != "" ? "noreply@${var.domain_name}" : "noreply@invalid.local"
  )
}

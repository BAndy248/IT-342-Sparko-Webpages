###############################################################################
# Identity / tagging
###############################################################################
variable "project" {
  type        = string
  default     = "sparko"
  description = "Short project slug used in resource names and tags."
}

variable "environment" {
  type        = string
  default     = "prod"
  description = "Environment name (prod, staging, dev). Used in tags and resource names."
}

variable "owner" {
  type        = string
  default     = "sparko-team"
  description = "Owner tag on every resource — useful for cost allocation reports."
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "Primary AWS region for the stack."
}

###############################################################################
# Networking
###############################################################################
variable "vpc_cidr" {
  type        = string
  default     = "10.20.0.0/16"
  description = "VPC CIDR. /16 gives plenty of room for the 4-subnet layout."
}

variable "az_count" {
  type        = number
  default     = 2
  description = "Number of AZs to span. 2 gives Multi-AZ redundancy; 3 is overkill for a class demo."
}

variable "single_nat_gateway" {
  type        = bool
  default     = true
  description = "Use one NAT GW shared across AZs. Saves ~\\$32/mo; tradeoff is one NAT-GW outage drops outbound for both AZs. Acceptable for a class demo."
}

###############################################################################
# DNS / TLS
###############################################################################
variable "domain_name" {
  type        = string
  default     = ""
  description = "Apex domain (e.g. sparkowater.example.com). Leave blank to skip Route 53 + ACM and use the raw ALB DNS name."
}

variable "route53_zone_id" {
  type        = string
  default     = ""
  description = "Existing Route 53 hosted zone id. Required when domain_name is set. Terraform does not create the zone itself — domains typically pre-exist."
}

###############################################################################
# Compute
###############################################################################
variable "web_instance_type" {
  type        = string
  default     = "t3.micro"
  description = "EC2 instance type for the nginx tier. t3.micro stays in free tier."
}

variable "api_instance_type" {
  type        = string
  default     = "t3.small"
  description = "EC2 instance type for the API tier. t3.small gives Node.js a bit more headroom."
}

variable "web_min_size" {
  type    = number
  default = 2
}

variable "web_max_size" {
  type    = number
  default = 4
}

variable "api_min_size" {
  type    = number
  default = 2
}

variable "api_max_size" {
  type    = number
  default = 6
}

variable "ssh_key_name" {
  type        = string
  default     = ""
  description = "Existing EC2 keypair name. Empty = no SSH key (use SSM Session Manager instead)."
}

variable "ssh_ingress_cidr" {
  type        = string
  default     = ""
  description = "If you want raw SSH (port 22) open to a bastion or office IP, set its CIDR here. Empty = no port 22 ingress (SSM only)."
}

###############################################################################
# Database
###############################################################################
variable "db_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "sparko_water"
}

variable "db_username" {
  type        = string
  default     = "sparko_admin"
  description = "Master DB username. Password is generated and stored in Secrets Manager."
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

###############################################################################
# Source / deployment
###############################################################################
variable "repo_url" {
  type        = string
  default     = "https://github.com/BAndy248/IT-342-Sparko-Webpages.git"
  description = "Public git URL the EC2 user-data clones from."
}

variable "repo_branch" {
  type    = string
  default = "main"
}

###############################################################################
# Square / app config
###############################################################################
variable "square_environment" {
  type    = string
  default = "sandbox"
}

variable "square_access_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Square API token written to Secrets Manager on first apply. Rotate in the console afterward; Terraform won't overwrite it (lifecycle.ignore_changes)."
}

variable "square_location_id" {
  type    = string
  default = ""
}

variable "frontend_url" {
  type        = string
  default     = ""
  description = "Public URL the API trusts for CORS. Defaults to the ALB DNS if left blank."
}

###############################################################################
# Alerts
###############################################################################
variable "alarm_email" {
  type        = string
  default     = ""
  description = "Email subscribed to the alerts SNS topic. Leave blank to skip subscription (you can subscribe later from the console)."
}

###############################################################################
# Email (SES)
###############################################################################
variable "ses_from_address" {
  type        = string
  default     = ""
  description = "Email address SES sends transactional mail from (e.g. noreply@sparkowater.example.com). Empty = no@-anchored sender, restricts policy to nothing."
}

###############################################################################
# CI/CD (GitHub OIDC)
###############################################################################
variable "github_repo" {
  type        = string
  default     = ""
  description = "GitHub repo slug like 'BAndy248/IT-342-Sparko-Webpages'. Empty = skip OIDC role provisioning."
}

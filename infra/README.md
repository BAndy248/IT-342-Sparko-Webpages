# `infra/` — Sparko Terraform

End-to-end IaC for the Sparko stack. One `terraform apply` provisions:

- VPC with public / private-app / private-data subnets across N AZs
- Public ALB (with WAF + ACM cert + Route 53 record) and internal ALB
- Auto Scaling Groups for the web (nginx) and API (Node.js) tiers
- RDS MySQL 8 Multi-AZ with backups, Performance Insights, slow query export
- S3 + CloudFront for static assets (CSS/JS/Fonts/Images)
- Secrets Manager (DB credentials + JWT + Square keys)
- CloudWatch log groups, dashboard, and alarms wired to an SNS topic
- Lambda + EventBridge + SQS subscription-renewal pipeline
- SES domain + email identity for transactional mail
- IAM OIDC role for GitHub Actions deploys (optional)

## Quickstart

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars

# (recommended) bootstrap remote state once
aws s3 mb s3://sparko-tfstate-<random> --region us-east-1
aws dynamodb create-table --table-name sparko-tflock \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
# then un-comment the `backend "s3"` block in versions.tf and:
#   terraform init -reconfigure

terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

First apply takes ~15 min (RDS Multi-AZ is the slow part).

## Outputs you'll need next

```bash
terraform output public_url        # what users hit
terraform output rds_endpoint      # for one-off DB admin via bastion
terraform output dashboard_url     # CloudWatch dashboard
terraform output cloudfront_url    # CDN
terraform output asg_api_name      # for `aws autoscaling start-instance-refresh`
```

## Deploying a new version of the app

Two paths:

1. **Push to `main`** — the GitHub Actions workflow in
   [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
   assumes the OIDC role and triggers an ASG instance refresh on both
   target groups. New nodes pull the latest commit in user-data.

2. **Manually**:
   ```bash
   aws autoscaling start-instance-refresh --auto-scaling-group-name "$(terraform output -raw asg_api_name)"
   aws autoscaling start-instance-refresh --auto-scaling-group-name "$(terraform output -raw asg_web_name)"
   ```

## Updating Lambda

The Lambda source lives in [`lambda/subscription-renewal/`](../lambda/subscription-renewal/).
Terraform zips and uploads it on each `apply`. To deploy just the function
without re-applying the whole stack:

```bash
cd lambda/subscription-renewal && zip -r function.zip .
aws lambda update-function-code \
    --function-name "$(terraform -chdir=../../infra output -raw lambda_subscription_name)" \
    --zip-file fileb://function.zip
```

## Destroying

```bash
terraform destroy
```

RDS final-snapshot defaults to on in prod. Override with
`-var environment=staging` for a no-snapshot teardown.

## Files

| File | Purpose |
|---|---|
| [versions.tf](versions.tf) | Provider versions, default tags, optional remote state |
| [variables.tf](variables.tf) | Input variables (everything tunable) |
| [locals.tf](locals.tf) | Derived names + subnet CIDR math |
| [data.tf](data.tf) | AMI + AZ + account lookups |
| [vpc.tf](vpc.tf) | VPC, subnets, IGW, NAT, route tables, S3 endpoint |
| [security_groups.tf](security_groups.tf) | Tiered SGs (ALB→web→api→db) |
| [iam.tf](iam.tf) | EC2 instance profile, Lambda role, GitHub OIDC role |
| [secrets.tf](secrets.tf) | Secrets Manager (db + app) |
| [rds.tf](rds.tf) | RDS MySQL 8 Multi-AZ with logging |
| [alb.tf](alb.tf) | Public + internal ALBs, listeners, target groups |
| [asg.tf](asg.tf) | Launch templates + ASGs for web/api tiers |
| [route53_acm.tf](route53_acm.tf) | DNS records + ACM certs |
| [s3_cloudfront.tf](s3_cloudfront.tf) | Static assets bucket + CloudFront + ALB logs bucket |
| [cloudwatch.tf](cloudwatch.tf) | Log groups, dashboard, alarms, WAF, SNS |
| [lambda_subscription.tf](lambda_subscription.tf) | EventBridge → Lambda → SQS pipeline |
| [ses.tf](ses.tf) | SES email + domain identity |
| [outputs.tf](outputs.tf) | Outputs used by the deploy workflow + docs |
| [user_data_api.sh.tpl](user_data_api.sh.tpl) | EC2 cloud-init for API tier |
| [user_data_web.sh.tpl](user_data_web.sh.tpl) | EC2 cloud-init for web tier |

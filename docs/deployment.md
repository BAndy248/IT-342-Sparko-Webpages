# Deployment

End-to-end deploy from zero, plus the post-deploy verification checklist.

## Prerequisites

- AWS account with admin (or close to it) credentials configured locally
  (`aws sts get-caller-identity` must work).
- Terraform 1.7+.
- A Route 53 hosted zone (if you want a custom domain — the demo works
  fine without one against the raw ALB DNS).
- Optional: a GitHub repo + `secrets.AWS_DEPLOY_ROLE_ARN` set after the
  first Terraform apply.

## Step 1 — One-time backend state bootstrap (optional but recommended)

Skip this if you're happy with local `.tfstate` for the demo.

```bash
# S3 bucket and DynamoDB lock table for remote state.
RAND=$(openssl rand -hex 4)
aws s3 mb s3://sparko-tfstate-$RAND --region us-east-1
aws s3api put-bucket-versioning --bucket sparko-tfstate-$RAND --versioning-configuration Status=Enabled
aws dynamodb create-table \
    --table-name sparko-tflock \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
```

Then edit [`infra/versions.tf`](../infra/versions.tf) and un-comment the
`backend "s3"` block with the bucket name from above.

## Step 2 — Configure variables

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`. Minimum for a class demo (no domain):

```hcl
region      = "us-east-1"
alarm_email = "you@example.com"
github_repo = "BAndy248/IT-342-Sparko-Webpages"   # if using GHA deploys
```

For a real domain, also set:

```hcl
domain_name      = "sparkowater.example.com"
route53_zone_id  = "Z0123456789ABCDEF"
ses_from_address = "noreply@sparkowater.example.com"
```

## Step 3 — Provision

```bash
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

First apply takes about 12-18 minutes. RDS Multi-AZ is the slow part.

## Step 4 — Seed the database

The ASGs come up empty until the schema is loaded. Use Session Manager to
hop onto an API instance and run the seed:

```bash
# Get any API instance id from the ASG.
ASG=$(terraform output -raw asg_api_name)
INSTANCE=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$ASG" \
    --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)

# Open a shell via SSM (no SSH key, no bastion needed).
aws ssm start-session --target "$INSTANCE"
```

Once on the instance:

```bash
sudo su -
cd /opt/sparko-src
# The setup script reads DB creds from the env; user-data already set them.
source <(sudo cat /opt/sparko/Back-End/.env | grep -E '^(DB_|JWT_)' | sed 's/^/export /')

# Initial schema + sample data.
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < Database/schema.sql
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < Database/seed.sql
```

(For a managed alternative, deploy the seed step as a one-shot CodeBuild
project that runs in the VPC. Out of scope for the class demo.)

## Step 5 — Verify

```bash
# Public health
URL=$(terraform output -raw public_url)
curl -fsS  "$URL/nginx-health"   # 200 ok
curl -fsS  "$URL/healthz"        # API liveness
curl -fsS  "$URL/readyz"         # API + DB readiness
curl -fsS  "$URL/api/products"   # API actually returns data

# Static assets via CloudFront
CDN=$(terraform output -raw cloudfront_url)
curl -fsS  "$CDN/css/sparkoTemplate.css" -o /dev/null && echo "CDN reachable"

# Dashboard
open "$(terraform output -raw dashboard_url)"
```

You should see `Healthy host count` ≥ 2 for both target groups within a
few minutes of apply finishing.

## Step 6 — Wire up the GitHub Actions deploy role

After the first apply, copy the OIDC role ARN into GitHub:

```bash
terraform output github_deploy_role_arn
# Settings → Secrets and variables → Actions → New repository secret
#   Name:  AWS_DEPLOY_ROLE_ARN
#   Value: <paste>
```

From then on:
- Push to `main` triggers `.github/workflows/deploy.yml` which syncs
  static assets to S3, invalidates CloudFront, updates the Lambda, and
  starts a rolling refresh on both ASGs.
- PRs touching `infra/` trigger `.github/workflows/terraform.yml` which
  posts the plan as a PR comment.

## Step 7 — Verify SES (if using a domain)

```bash
# Check that the DKIM CNAMEs are live + the identity is verified.
aws sesv2 get-email-identity --email-identity sparkowater.example.com
# DkimAttributes.Status should be "SUCCESS".

# In sandbox, you can only send TO addresses you've verified. To exit sandbox:
# Open SES console -> Account dashboard -> Request production access.
```

## Manual deploy (when you don't want to wait for CI)

```bash
# 1. Static assets
BUCKET=$(terraform output -raw static_assets_bucket)
aws s3 sync Front-End/css/    s3://$BUCKET/css/    --delete
aws s3 sync Front-End/js/     s3://$BUCKET/js/     --delete
aws s3 sync Front-End/Fonts/  s3://$BUCKET/Fonts/  --delete
aws s3 sync Front-End/Images/ s3://$BUCKET/Images/ --delete

# 2. CloudFront invalidate
CF=$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='sparko-prod static asset CDN'].Id | [0]" \
    --output text)
aws cloudfront create-invalidation --distribution-id "$CF" --paths "/*"

# 3. EC2 rolling refresh
aws autoscaling start-instance-refresh \
    --auto-scaling-group-name "$(terraform output -raw asg_api_name)"
aws autoscaling start-instance-refresh \
    --auto-scaling-group-name "$(terraform output -raw asg_web_name)"

# 4. Lambda
cd lambda/subscription-renewal && npm install --omit=dev && zip -qr ../function.zip .
cd ..
aws lambda update-function-code \
    --function-name "$(terraform -chdir=../infra output -raw lambda_subscription_name)" \
    --zip-file fileb://function.zip
```

## Destroy

```bash
cd infra
terraform destroy
```

For prod, RDS will create a final snapshot. For `environment = "staging"`
or below the snapshot is skipped to make teardown faster.

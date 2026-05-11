#!/bin/bash
# Sparko API user-data — runs once on each EC2 boot via cloud-init.
# Pulls the repo, pulls secrets from Secrets Manager, then hands off to the
# existing setup/backend-setup.sh idempotent installer.

set -euxo pipefail
exec > >(tee -a /var/log/sparko-userdata.log) 2>&1

# ----- packages we need at boot ---------------------------------------------
dnf install -y git jq aws-cli

# ----- pull the repo --------------------------------------------------------
REPO_DIR=/opt/sparko-src
if [[ -d $REPO_DIR/.git ]]; then
    git -C "$REPO_DIR" fetch --depth 1 origin "${repo_branch}"
    git -C "$REPO_DIR" reset --hard "origin/${repo_branch}"
else
    git clone --depth 1 -b "${repo_branch}" "${repo_url}" "$REPO_DIR"
fi

# ----- pull secrets from Secrets Manager -----------------------------------
DB_SECRET=$(aws secretsmanager get-secret-value --secret-id "${db_secret_arn}" --region "${region}" --query SecretString --output text)
APP_SECRET=$(aws secretsmanager get-secret-value --secret-id "${app_secret_arn}" --region "${region}" --query SecretString --output text)

export DB_HOST=$(echo "$DB_SECRET" | jq -r .host)
export DB_PORT=$(echo "$DB_SECRET" | jq -r .port)
export DB_USER=$(echo "$DB_SECRET" | jq -r .username)
export DB_PASSWORD=$(echo "$DB_SECRET" | jq -r .password)
export DB_NAME=$(echo "$DB_SECRET" | jq -r .dbname)
export DB_SSL=relaxed

export JWT_SECRET=$(echo "$APP_SECRET" | jq -r .JWT_SECRET)
export SQUARE_ACCESS_TOKEN=$(echo "$APP_SECRET" | jq -r .SQUARE_ACCESS_TOKEN)
export SQUARE_LOCATION_ID=$(echo "$APP_SECRET" | jq -r .SQUARE_LOCATION_ID)
export SQUARE_ENVIRONMENT=$(echo "$APP_SECRET" | jq -r .SQUARE_ENVIRONMENT)

# ----- app config -----------------------------------------------------------
export AWS_REGION="${region}"
export CLOUDWATCH_LOG_GROUP="${cloudwatch_log_group}"
export FRONTEND_URL="${frontend_url}"
export NODE_ENV=production
export PORT=3000

# Use the EC2 instance ID as the log stream suffix so every line in CloudWatch
# is attributable to one node behind the ALB.
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
export INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)

# ----- hand off to the tier-specific installer ------------------------------
cd "$REPO_DIR"
bash setup/backend-setup.sh

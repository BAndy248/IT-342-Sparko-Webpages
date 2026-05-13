#!/bin/bash
# Sparko web (nginx) user-data — runs once on each EC2 boot via cloud-init.
# Pulls the repo and runs setup/frontend-setup.sh pointed at the internal ALB.

set -euxo pipefail
exec > >(tee -a /var/log/sparko-userdata.log) 2>&1

dnf install -y git jq aws-cli

REPO_DIR=/opt/sparko-src
if [[ -d $REPO_DIR/.git ]]; then
    git -C "$REPO_DIR" fetch --depth 1 origin "${repo_branch}"
    git -C "$REPO_DIR" reset --hard "origin/${repo_branch}"
else
    git clone --depth 1 -b "${repo_branch}" "${repo_url}" "$REPO_DIR"
fi

# The internal ALB exposes the API on port 80; nginx upstream points at it.
# Using the ALB DNS (rather than baked-in instance IPs) is what gives the web
# tier transparent failover when an API node disappears.
export BACKEND_HOST="${internal_alb_dns}:80"
export SERVER_NAME="${server_name}"
export AWS_REGION="${region}"
export CLOUDWATCH_LOG_GROUP="${cloudwatch_log_group}"

cd "$REPO_DIR"
bash setup/frontend-setup.sh

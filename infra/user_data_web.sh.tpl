#!/bin/bash
# Sparko web (nginx) user-data — runs once on each EC2 boot via cloud-init.
# Pulls the repo and runs setup/frontend-setup.sh pointed at the internal ALB.

set -euxo pipefail
exec > >(tee -a /var/log/sparko-userdata.log) 2>&1

# aws-cli is preinstalled on AL2023; only install missing tools.
# --allowerasing lets dnf swap curl-minimal for full curl without aborting.
dnf install -y --allowerasing git jq

REPO_DIR=/opt/sparko-src
if [[ -d $REPO_DIR/.git ]]; then
    git -C "$REPO_DIR" fetch --depth 1 origin "${repo_branch}"
    git -C "$REPO_DIR" reset --hard "origin/${repo_branch}"
else
    git clone --depth 1 -b "${repo_branch}" "${repo_url}" "$REPO_DIR"
fi

# Patch setup/common.sh's PKG_INSTALL to include --allowerasing on AL2023.
# The repo's main branch may not yet have this fix; this patch is applied
# inline so the deploy succeeds regardless of upstream state. Idempotent.
sed -i 's|PKG_INSTALL="dnf install -y"|PKG_INSTALL="dnf install -y --allowerasing"|' "$REPO_DIR/setup/common.sh"

# The internal ALB exposes the API on port 80; nginx upstream points at it.
# Using the ALB DNS (rather than baked-in instance IPs) is what gives the web
# tier transparent failover when an API node disappears.
export BACKEND_HOST="${internal_alb_dns}:80"
export SERVER_NAME="${server_name}"
export AWS_REGION="${region}"
export CLOUDWATCH_LOG_GROUP="${cloudwatch_log_group}"

cd "$REPO_DIR"
bash setup/frontend-setup.sh

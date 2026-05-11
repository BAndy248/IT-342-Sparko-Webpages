#!/usr/bin/env bash
# Installs and configures the AWS CloudWatch Unified Agent.
# Streams /var/log/syslog (or /var/log/messages), the app's stdout/stderr (via
# journald), and host metrics (CPU/disk/memory) to CloudWatch Logs + Metrics.
#
# Sourced or invoked by the backend/frontend setup scripts on each machine
# behind the AWS Application Load Balancer.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

CLOUDWATCH_LOG_GROUP="${CLOUDWATCH_LOG_GROUP:-/sparko/api}"
SERVICE_NAME="${SERVICE_NAME:-sparko-api}"
APP_USER="${APP_USER:-sparko}"

install_agent() {
    if command -v amazon-cloudwatch-agent-ctl >/dev/null 2>&1; then
        log "CloudWatch agent already installed."
        return 0
    fi

    log "Installing CloudWatch agent…"
    if [[ "$OS_FAMILY" == "rhel" ]]; then
        local arch url
        arch=$(uname -m)
        case "$arch" in
            x86_64)  url="https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm" ;;
            aarch64) url="https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/arm64/latest/amazon-cloudwatch-agent.rpm" ;;
            *) die "Unsupported architecture: $arch" ;;
        esac
        local tmp
        tmp=$(mktemp /tmp/cwagent.XXXXXX.rpm)
        curl -fsSL "$url" -o "$tmp"
        rpm -Uvh "$tmp" || dnf install -y "$tmp" || yum localinstall -y "$tmp"
        rm -f "$tmp"
    else
        local arch deb
        arch=$(dpkg --print-architecture)
        deb="https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/${arch}/latest/amazon-cloudwatch-agent.deb"
        local tmp
        tmp=$(mktemp /tmp/cwagent.XXXXXX.deb)
        curl -fsSL "$deb" -o "$tmp"
        apt-get install -y "$tmp"
        rm -f "$tmp"
    fi
}

write_config() {
    local instance_id region
    instance_id="${INSTANCE_ID:-$(default_instance_id)}"
    region="${AWS_REGION:-$(default_region)}"

    install -d -m 0755 /opt/aws/amazon-cloudwatch-agent/etc

    # The agent config defines what gets shipped:
    #   - host metrics: CPU/mem/disk/network (used for ALB scaling alarms)
    #   - journald collection for the systemd service that runs the API
    #   - syslog (Amazon Linux) or /var/log/syslog (Ubuntu)
    cat >/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<JSON
{
  "agent": {
    "metrics_collection_interval": 60,
    "run_as_user": "cwagent",
    "region": "${region}"
  },
  "metrics": {
    "namespace": "Sparko/EC2",
    "append_dimensions": {
      "InstanceId":   "\${aws:InstanceId}",
      "InstanceType": "\${aws:InstanceType}",
      "AutoScalingGroupName": "\${aws:AutoScalingGroupName}"
    },
    "metrics_collected": {
      "cpu":  { "measurement": ["usage_idle","usage_iowait","usage_user","usage_system"], "totalcpu": true },
      "mem":  { "measurement": ["used_percent","available_percent"] },
      "disk": { "measurement": ["used_percent","inodes_free"], "resources": ["*"], "ignore_file_system_types": ["sysfs","devtmpfs","tmpfs"] },
      "netstat": { "measurement": ["tcp_established","tcp_time_wait"] }
    }
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/messages",
            "log_group_name": "${CLOUDWATCH_LOG_GROUP}/host",
            "log_stream_name": "{instance_id}/messages",
            "retention_in_days": 30
          },
          {
            "file_path": "/var/log/syslog",
            "log_group_name": "${CLOUDWATCH_LOG_GROUP}/host",
            "log_stream_name": "{instance_id}/syslog",
            "retention_in_days": 30
          },
          {
            "file_path": "/var/log/nginx/access.log",
            "log_group_name": "${CLOUDWATCH_LOG_GROUP}/nginx",
            "log_stream_name": "{instance_id}/access",
            "retention_in_days": 30
          },
          {
            "file_path": "/var/log/nginx/error.log",
            "log_group_name": "${CLOUDWATCH_LOG_GROUP}/nginx",
            "log_stream_name": "{instance_id}/error",
            "retention_in_days": 30
          }
        ]
      }
    }
  }
}
JSON
    log "Wrote CloudWatch agent config (region=${region}, log group=${CLOUDWATCH_LOG_GROUP})."
}

start_agent() {
    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
        -a fetch-config -m ec2 -s \
        -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
    systemctl enable amazon-cloudwatch-agent
    log "CloudWatch agent started and enabled at boot."
}

main() {
    ensure_root "$@"
    detect_os
    install_agent
    write_config
    start_agent
    log "CloudWatch agent setup complete."
}

# Only run when executed directly; allow sourcing without side effects.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi

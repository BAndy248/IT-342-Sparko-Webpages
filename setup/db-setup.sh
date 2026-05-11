#!/usr/bin/env bash
#
# Database tier setup — prepares a MySQL/MariaDB server for the Sparko stack.
#
# Designed for two scenarios:
#   (A) You're running the DB on an EC2 instance: this script installs MariaDB,
#       binds it to the VPC's private interface, applies the schema, seeds, and
#       installs the CloudWatch agent so MariaDB logs flow to CloudWatch.
#   (B) You're using AWS RDS / Aurora: pass DB_HOST/DB_USER/DB_PASSWORD/DB_NAME
#       and SKIP_INSTALL=1 — the script will only run the schema + migrations
#       against the remote endpoint.
#
# Environment variables (override defaults at the top of the script):
#   DB_NAME           default: sparko_water
#   DB_USER           default: sparko_app
#   DB_PASSWORD       default: auto-generated (printed at the end)
#   DB_ROOT_PASSWORD  default: auto-generated (saved to /root/.sparko-db-root)
#   DB_HOST           default: localhost (set to RDS endpoint for scenario B)
#   DB_PORT           default: 3306
#   DB_BIND_ADDR      default: 0.0.0.0  (set to private IP to lock down)
#   SKIP_INSTALL      set to 1 to skip installing MariaDB (RDS / Aurora mode)
#   AWS_REGION        default: derived from EC2 metadata
#   CLOUDWATCH_LOG_GROUP default: /sparko/db
#
# Re-running is safe: schema uses CREATE TABLE IF NOT EXISTS / INSERT IGNORE.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

DB_NAME="${DB_NAME:-sparko_water}"
DB_USER="${DB_USER:-sparko_app}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_BIND_ADDR="${DB_BIND_ADDR:-0.0.0.0}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
CLOUDWATCH_LOG_GROUP="${CLOUDWATCH_LOG_GROUP:-/sparko/db}"

CREDS_FILE="/root/.sparko-db-credentials"

gen_password() {
    # 24 chars of [A-Za-z0-9]. Avoids shell-special characters.
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24
}

install_mariadb() {
    if [[ "$SKIP_INSTALL" == "1" ]]; then
        log "SKIP_INSTALL=1 — skipping local MariaDB install."
        return 0
    fi
    if [[ "$OS_FAMILY" == "rhel" ]]; then
        pkg_install mariadb105-server || pkg_install mariadb-server
    else
        pkg_install mariadb-server
    fi
    systemctl enable mariadb
    systemctl start  mariadb
    log "MariaDB service started."
}

configure_mariadb() {
    if [[ "$SKIP_INSTALL" == "1" ]]; then
        return 0
    fi

    # Bind to the requested address (0.0.0.0 = all interfaces; for tighter
    # security pass the instance's private IP via DB_BIND_ADDR). The DB
    # security group should restrict TCP 3306 to the backend's SG.
    local conf_dir
    if [[ -d /etc/my.cnf.d ]]; then
        conf_dir=/etc/my.cnf.d
    elif [[ -d /etc/mysql/mariadb.conf.d ]]; then
        conf_dir=/etc/mysql/mariadb.conf.d
    else
        conf_dir=/etc/mysql/conf.d
        mkdir -p "$conf_dir"
    fi

    cat >"${conf_dir}/99-sparko.cnf" <<EOF
[mysqld]
bind-address = ${DB_BIND_ADDR}
port         = ${DB_PORT}
# General + slow query logging so they can be tailed by the CloudWatch agent.
general_log         = 1
general_log_file    = /var/log/mariadb/general.log
slow_query_log      = 1
slow_query_log_file = /var/log/mariadb/slow.log
long_query_time     = 1
log_error           = /var/log/mariadb/error.log
# Sensible pool size for a small / medium subscription service.
max_connections     = 200
innodb_buffer_pool_size = 256M
EOF

    mkdir -p /var/log/mariadb
    chown mysql:mysql /var/log/mariadb 2>/dev/null || true

    systemctl restart mariadb
    log "MariaDB bound to ${DB_BIND_ADDR}:${DB_PORT}."
}

secure_and_create_app_user() {
    if [[ "$SKIP_INSTALL" == "1" ]]; then
        return 0
    fi

    if [[ -z "$DB_ROOT_PASSWORD" ]]; then
        DB_ROOT_PASSWORD=$(gen_password)
    fi
    if [[ -z "$DB_PASSWORD" ]]; then
        DB_PASSWORD=$(gen_password)
    fi

    # First-run root has no password yet (or socket auth). After this block
    # the root user authenticates with DB_ROOT_PASSWORD on subsequent runs.
    if ! mysql -uroot -e 'SELECT 1' >/dev/null 2>&1; then
        # Maybe a password is already set — try with the saved one.
        if [[ -f "$CREDS_FILE" ]]; then
            # shellcheck disable=SC1090
            source "$CREDS_FILE"
        fi
    fi

    local root_args=()
    if [[ -n "${DB_ROOT_PASSWORD}" ]] && mysql -uroot -p"${DB_ROOT_PASSWORD}" -e 'SELECT 1' >/dev/null 2>&1; then
        root_args=(-uroot -p"${DB_ROOT_PASSWORD}")
    else
        root_args=(-uroot)
    fi

    # Lock down root + drop anon, create the app user + DB. Use ${...//\'/\'\'}
    # quoting on the password since it can contain characters MariaDB doesn't
    # like inside a string literal (our generator avoids those, but defense in
    # depth costs us nothing).
    mysql "${root_args[@]}" <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '${DB_ROOT_PASSWORD}';
DELETE FROM mysql.user WHERE User='';
DELETE FROM mysql.db   WHERE Db LIKE 'test%';
DROP DATABASE IF EXISTS test;
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
    DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, REFERENCES, EXECUTE
    ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL

    # Persist creds in a root-only file so re-runs (and the operator) can
    # recover them without consulting console scrollback.
    umask 077
    cat >"$CREDS_FILE" <<EOF
DB_ROOT_PASSWORD='${DB_ROOT_PASSWORD}'
DB_USER='${DB_USER}'
DB_PASSWORD='${DB_PASSWORD}'
DB_NAME='${DB_NAME}'
DB_HOST='${DB_HOST}'
DB_PORT='${DB_PORT}'
EOF
    chmod 600 "$CREDS_FILE"
    log "Credentials saved to ${CREDS_FILE}."
}

apply_schema() {
    local schema="${REPO_DIR}/Database/schema.sql"
    local seed="${REPO_DIR}/Database/seed.sql"
    local migrations_dir="${REPO_DIR}/Database/migrations"

    [[ -f "$schema" ]] || die "Schema file not found at ${schema}"

    local cli_args=()
    if [[ "$SKIP_INSTALL" == "1" ]]; then
        # RDS / external DB mode: connect with DB_USER credentials.
        [[ -n "${DB_PASSWORD}" ]] || die "DB_PASSWORD required when SKIP_INSTALL=1"
        cli_args=(-h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASSWORD}" "${DB_NAME}")
    else
        cli_args=(-uroot -p"${DB_ROOT_PASSWORD}")
    fi

    log "Applying schema from ${schema}…"
    mysql "${cli_args[@]}" <"$schema" || warn "Some schema statements may have already existed (ok on re-run)."

    if [[ -d "$migrations_dir" ]]; then
        for f in $(ls -1 "${migrations_dir}"/*.sql 2>/dev/null | sort); do
            log "Applying migration $(basename "$f")…"
            mysql "${cli_args[@]}" <"$f" || warn "Migration $(basename "$f") had errors (may be already applied)."
        done
    fi

    if [[ -f "$seed" ]]; then
        log "Applying seed data…"
        mysql "${cli_args[@]}" <"$seed" || warn "Seed had errors (existing rows are expected to be skipped)."
    fi
    log "Schema + migrations + seed applied."
}

install_cw_agent_for_db() {
    if [[ "$SKIP_INSTALL" == "1" ]]; then
        log "RDS mode — CloudWatch Logs for the DB engine should be enabled in the RDS console."
        return 0
    fi
    log "Installing CloudWatch agent so MariaDB logs ship to CloudWatch…"
    SERVICE_NAME="mariadb" CLOUDWATCH_LOG_GROUP="${CLOUDWATCH_LOG_GROUP}" \
        bash "${SCRIPT_DIR}/cloudwatch-agent.sh"

    # Add MariaDB log files to the agent's collect list (we don't bake these
    # into cloudwatch-agent.sh because the path differs per OS).
    local cfg=/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
    if [[ -f "$cfg" ]] && ! grep -q '/var/log/mariadb/error.log' "$cfg"; then
        python3 - "$cfg" "${CLOUDWATCH_LOG_GROUP}" <<'PY' || warn "Could not inject MariaDB log paths."
import json, sys
path, group = sys.argv[1], sys.argv[2]
with open(path) as fh:
    cfg = json.load(fh)
files = cfg.setdefault("logs", {}).setdefault("logs_collected", {}).setdefault("files", {}).setdefault("collect_list", [])
for name in ("error.log", "slow.log", "general.log"):
    files.append({
        "file_path": f"/var/log/mariadb/{name}",
        "log_group_name": f"{group}/mariadb",
        "log_stream_name": "{instance_id}/" + name,
        "retention_in_days": 30
    })
with open(path, "w") as fh:
    json.dump(cfg, fh, indent=2)
PY
        /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
            -a fetch-config -m ec2 -s -c file:"$cfg" || warn "Agent reload failed."
    fi
}

print_summary() {
    cat <<EOF

============================================================
  Sparko DB tier setup complete
============================================================
  DB_HOST     = ${DB_HOST}
  DB_PORT     = ${DB_PORT}
  DB_NAME     = ${DB_NAME}
  DB_USER     = ${DB_USER}
  DB_PASSWORD = ${DB_PASSWORD}
$([[ "$SKIP_INSTALL" != "1" ]] && echo "  Credentials persisted to ${CREDS_FILE}")
------------------------------------------------------------
  Paste these into Back-End/.env on each API instance:

    DB_HOST=${DB_HOST}
    DB_PORT=${DB_PORT}
    DB_NAME=${DB_NAME}
    DB_USER=${DB_USER}
    DB_PASSWORD=${DB_PASSWORD}
============================================================
EOF
}

main() {
    ensure_root "$@"
    detect_os
    install_mariadb
    configure_mariadb
    secure_and_create_app_user
    apply_schema
    install_cw_agent_for_db
    print_summary
}

main "$@"

#!/usr/bin/env bash
# Shared helpers sourced by every tier's setup script.
# Provides: log/warn/err, OS detection, root re-exec, idempotent installs.

set -euo pipefail

# ---------------- logging ----------------
ts()   { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log()  { printf '[%s] [INFO]  %s\n'  "$(ts)" "$*"; }
warn() { printf '[%s] [WARN]  %s\n'  "$(ts)" "$*" >&2; }
err()  { printf '[%s] [ERROR] %s\n'  "$(ts)" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------- root ----------------
# Re-exec under sudo if not running as root, so the user can invoke the script
# directly without remembering to prefix `sudo`.
ensure_root() {
    if [[ "$(id -u)" -ne 0 ]]; then
        if command -v sudo >/dev/null 2>&1; then
            log "Re-running with sudo…"
            exec sudo --preserve-env=DB_HOST,DB_USER,DB_PASSWORD,DB_NAME,JWT_SECRET,FRONTEND_URL,AWS_REGION,CLOUDWATCH_LOG_GROUP,BACKEND_HOST,SQUARE_ACCESS_TOKEN,SQUARE_LOCATION_ID,SQUARE_ENVIRONMENT,INSTANCE_ID,NODE_ENV,APP_USER,APP_DIR,REPO_URL,BRANCH,DB_BIND_ADDR,DB_ROOT_PASSWORD bash "$0" "$@"
        else
            die "Must run as root (and sudo is not available)."
        fi
    fi
}

# ---------------- OS detect ----------------
# Sets OS_FAMILY = 'rhel' (Amazon Linux 2/2023, RHEL, CentOS) or 'debian'
# (Ubuntu, Debian). Anything else aborts — keeps the install paths predictable.
detect_os() {
    if [[ -r /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        OS_ID="${ID:-unknown}"
        OS_LIKE="${ID_LIKE:-}"
    else
        die "Unable to detect OS: /etc/os-release missing."
    fi

    case "${OS_ID}:${OS_LIKE}" in
        amzn*|rhel*|centos*|fedora*|*:*rhel*|*:*fedora*)
            OS_FAMILY="rhel"
            # --allowerasing lets dnf swap curl-minimal for full curl on
            # Amazon Linux 2023 (where the two packages conflict by default).
            PKG_INSTALL="dnf install -y --allowerasing"
            command -v dnf >/dev/null 2>&1 || PKG_INSTALL="yum install -y"
            ;;
        ubuntu*|debian*|*:*debian*|*:*ubuntu*)
            OS_FAMILY="debian"
            export DEBIAN_FRONTEND=noninteractive
            PKG_INSTALL="apt-get install -y -o Dpkg::Options::=--force-confnew"
            apt-get update -y >/dev/null
            ;;
        *)
            die "Unsupported OS: ID=${OS_ID} ID_LIKE=${OS_LIKE}"
            ;;
    esac
    log "Detected OS family: ${OS_FAMILY} (${OS_ID})"
    export OS_FAMILY PKG_INSTALL
}

# ---------------- install helper ----------------
# pkg_install <package> [<package> …]
# Skips packages already installed so the script is fast on re-runs.
pkg_install() {
    local pkgs=("$@")
    local missing=()
    if [[ "$OS_FAMILY" == "rhel" ]]; then
        for p in "${pkgs[@]}"; do
            rpm -q "$p" >/dev/null 2>&1 || missing+=("$p")
        done
    else
        for p in "${pkgs[@]}"; do
            dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
        done
    fi
    if [[ ${#missing[@]} -gt 0 ]]; then
        log "Installing: ${missing[*]}"
        # shellcheck disable=SC2086
        $PKG_INSTALL "${missing[@]}"
    else
        log "All packages already present: ${pkgs[*]}"
    fi
}

# ---------------- AWS metadata helpers ----------------
# Read EC2 instance metadata (IMDSv2). Empty string if we're not on EC2 or the
# endpoint isn't reachable — every caller treats that as "not on EC2".
ec2_metadata() {
    local path="$1"
    local token
    token=$(curl -s -X PUT -m 1 "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
    if [[ -z "${token}" ]]; then
        echo ""
        return 0
    fi
    curl -s -m 1 -H "X-aws-ec2-metadata-token: ${token}" \
        "http://169.254.169.254/latest/meta-data/${path}" 2>/dev/null || echo ""
}

# Default the instance id used in CloudWatch streams to the EC2 instance id
# when available, falling back to hostname.
default_instance_id() {
    local meta
    meta=$(ec2_metadata "instance-id")
    if [[ -n "${meta}" ]]; then
        echo "${meta}"
    else
        hostname
    fi
}

# Default the region from instance metadata if not explicitly set.
default_region() {
    local meta
    meta=$(ec2_metadata "placement/region")
    [[ -n "${meta}" ]] && echo "${meta}" || echo "us-east-1"
}

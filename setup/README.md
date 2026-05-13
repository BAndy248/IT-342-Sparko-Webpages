# Sparko Setup Scripts

One-shot, idempotent shell scripts to bring up each tier of the Sparko
stack on AWS EC2. They target both **Amazon Linux 2 / 2023** and
**Ubuntu / Debian**.

| Script | Run on | What it does |
|---|---|---|
| [`db-setup.sh`](db-setup.sh) | Database EC2 (or any host with mysql CLI) | Installs MariaDB, creates the `sparko_water` DB + app user, applies `schema.sql` + every file in `Database/migrations/`, seeds bundles, ships MariaDB logs to CloudWatch. Supports RDS / Aurora via `SKIP_INSTALL=1`. |
| [`backend-setup.sh`](backend-setup.sh) | API EC2 (1..N nodes) | Installs Node.js 20, creates the `sparko` user, deploys the app to `/opt/sparko`, runs `npm ci`, writes `.env`, registers the `sparko-api` systemd service, installs the CloudWatch agent, and tails the journal to CloudWatch. Health-check ready for the ALB. |
| [`frontend-setup.sh`](frontend-setup.sh) | Web / nginx EC2 (1..N nodes) | Installs nginx, deploys `Front-End/`, configures a reverse-proxy to one or more backends with health-aware upstreams + retries, ships access/error logs to CloudWatch. |
| [`cloudwatch-agent.sh`](cloudwatch-agent.sh) | Any | Helper used by the other scripts; can be run standalone to install the AWS CloudWatch Unified Agent. |
| [`common.sh`](common.sh) | (sourced) | Shared logging + OS-detect + sudo re-exec helpers. |

---

## Recommended AWS topology

```
                            ┌──────────────────┐
   Internet ──── ALB ───────┤ Frontend nginx 1 │──┐
              (public)      │   AZ a           │  │  ┌──────────────────┐
                            └──────────────────┘  ├──┤  Backend API 1   │──┐
                            ┌──────────────────┐  │  │   AZ a           │  │
                            │ Frontend nginx 2 │──┤  └──────────────────┘  │
                            │   AZ b           │  │  ┌──────────────────┐  ├──── RDS / Aurora MySQL
                            └──────────────────┘  └──┤  Backend API 2   │──┘     (multi-AZ)
                                                     │   AZ b           │
                                                     └──────────────────┘
```

- The **public ALB** points at the frontend nginx target group on port 80.
- An **internal ALB** (or direct nginx upstreams) point at the backend target group on port 3000.
- Both tiers register `/nginx-health` and `/healthz` respectively for health checks.
- The DB is **RDS Multi-AZ** (preferred) or an EC2 with `db-setup.sh`.

Redundancy comes from:
1. **Two or more instances** in each tier across at least two AZs.
2. **ALB target-group health checks** at `/nginx-health` (web) and `/healthz` (API).
3. **nginx passive ejection** of bad backends (`max_fails=3 fail_timeout=30s`).
4. **`/readyz`** on each API node — if the DB is unreachable it returns 503 and the ALB drains the node.
5. **SIGTERM graceful shutdown** so deploys / scale-in events don't drop in-flight requests.

---

## Order of operations

### 1. Database

Either provision **RDS / Aurora MySQL 8** in the AWS console and skip the
local install, or run the script on a dedicated EC2.

```bash
# Option A — local MariaDB on EC2
sudo ./setup/db-setup.sh
# Look at the printed summary for the generated DB_PASSWORD.

# Option B — point at existing RDS / Aurora
DB_HOST=sparko-prod.xxxx.us-east-1.rds.amazonaws.com \
DB_USER=admin DB_PASSWORD='from-secrets-manager' DB_NAME=sparko_water \
SKIP_INSTALL=1 \
sudo -E ./setup/db-setup.sh
```

Outputs the DB connection info you'll paste into the API instances.

### 2. Backend API instances

Run this on every API node. Pass DB info in the environment.

```bash
DB_HOST=10.0.5.20 DB_USER=sparko_app DB_PASSWORD='from-step-1' DB_NAME=sparko_water \
FRONTEND_URL=https://sparkowater.example.com \
AWS_REGION=us-east-1 \
CLOUDWATCH_LOG_GROUP=/sparko/api \
SQUARE_ACCESS_TOKEN='sq0atp-…' SQUARE_LOCATION_ID='L…' SQUARE_ENVIRONMENT=production \
sudo -E ./setup/backend-setup.sh
```

After this completes:
- `systemctl status sparko-api` — should be `active (running)`.
- `curl http://127.0.0.1:3000/healthz` — returns `{"status":"ok"}`.
- Logs flow to **CloudWatch Logs → /sparko/api**.

Register the instance with the API target group:
- **Health check path**: `/healthz`
- **Port**: `3000`

### 3. Frontend / nginx instances

Run this on every web node. Point it at one or more backend nodes (or at
the internal API ALB DNS name).

```bash
# Direct multi-node upstream
BACKEND_HOSTS="10.0.5.20:3000,10.0.5.21:3000" \
SERVER_NAME=sparkowater.example.com \
AWS_REGION=us-east-1 \
sudo -E ./setup/frontend-setup.sh

# Or via an internal ALB
BACKEND_HOST=internal-sparko-api-12345.us-east-1.elb.amazonaws.com:3000 \
sudo -E ./setup/frontend-setup.sh
```

After this completes:
- `curl http://127.0.0.1/nginx-health` — returns `ok`.
- `curl http://127.0.0.1/healthz` — proxies to backend, returns API health.
- Access logs appear in **CloudWatch Logs → /sparko/web/nginx**.

Register with the public ALB:
- **Health check path**: `/nginx-health`
- **Port**: `80`

---

## EC2 IAM requirements

Attach an instance profile with **`CloudWatchAgentServerPolicy`** to every
EC2. Without it, the agent can't push metrics or logs.

For Square / Secrets Manager-managed env vars, also grant the relevant
`secretsmanager:GetSecretValue` on the secrets the instance reads at boot
(e.g. via `user-data` that exports them before invoking the setup script).

## Security group ground rules

| Source | Destination | Port | Protocol |
|---|---|---|---|
| Public ALB SG | Web tier SG | 80 | TCP |
| Web tier SG | API tier SG | 3000 | TCP |
| API tier SG | DB tier SG | 3306 | TCP |
| Operator IP | Bastion SG | 22 | TCP |
| Bastion SG | Web/API/DB SGs | 22 | TCP |

The setup scripts open ports on the host firewall when `firewalld` is
running. The AWS Security Groups remain the authoritative gate.

## Re-running

Every script is safe to re-run:
- DB setup uses `CREATE TABLE IF NOT EXISTS` and `INSERT IGNORE`.
- Backend setup overwrites `.env` (preserving the existing `JWT_SECRET` if
  one is already present) and `systemctl restart`s the service.
- Frontend setup re-`rsync`s the static files and `nginx -t && systemctl
  restart nginx`.

So they double as **deploy** scripts: ship a new build, re-run the
relevant tier.

## Troubleshooting

```bash
# Backend
sudo systemctl status sparko-api
sudo journalctl -fu sparko-api

# Frontend
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log

# DB
sudo journalctl -fu mariadb
sudo tail -f /var/log/mariadb/error.log

# CloudWatch agent
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status
```

# Security

How the Sparko stack handles authentication, secrets, network isolation,
IAM, and what AWS controls cover the rest.

## Network isolation

Subnet tiering inside the VPC:

| Subnet | Routes outbound? | What lives there |
|---|---|---|
| `public_*`       | IGW (full internet)             | Public ALB, NAT GW                |
| `private_app_*`  | NAT GW (egress-only)            | nginx + Node EC2, Lambda          |
| `private_data_*` | none                            | RDS only                          |

Security groups form a strict chain. Each SG accepts traffic ONLY from the
upstream SG, never from CIDR ranges (except for the public ALB on 80/443):

```
internet ──► alb_public_sg(80,443) ──► web_sg(80) ──► alb_internal_sg(80) ──► api_sg(3000) ──► db_sg(3306)
                                                                                   ▲
                                                                         lambda_sg ┘
```

This means a leak at any one tier doesn't grant the attacker access to the
tier below it; they'd have to compromise the next SG-source first.

## Authentication & passwords

- **Passwords**: PBKDF2-HMAC-SHA512, 210k iterations, 16-byte random salt,
  64-byte derived key. Format: `pbkdf2_sha512$210000$<salt-hex>$<hash-hex>`.
  See [Back-End/utils/password.js](../Back-End/utils/password.js).
- **JWT**: 24-hour expiry by default (`JWT_EXPIRES_IN`). Secret loaded from
  Secrets Manager at boot — never committed to the repo.
- **Password reset**: hashed token (sha256) in `password_reset_tokens`,
  single-use, 1-hour expiry, sent via SES.
- **Constant-time compare**: PBKDF2 verify uses `crypto.timingSafeEqual`
  on equal-length buffers.

## Application-layer protections

- **Parameterized SQL** everywhere — never string concatenation.
- **Input sanitization** middleware HTML-escapes every string in `req.body`,
  `req.query`, and `req.params`.
- **CORS** restricted to `FRONTEND_URL`.
- **Helmet** sets `X-Content-Type-Options`, `X-Frame-Options`, etc. nginx
  emits the same headers as a belt-and-suspenders layer for static responses.
- **Rate limiting**: 100 req / 15min per IP on `/api/*`, 15 req / 15min on
  `/api/auth/*`. Enforces above WAF's 2000/min rate-based rule.
- **Body size limit**: 10 KiB on JSON request bodies.

## Secrets

All sensitive config lives in **AWS Secrets Manager**:

| Secret | Contents | Read by |
|---|---|---|
| `${project}-${env}/db`  | RDS master username/password/host/port/dbname | EC2 API tier, Lambda |
| `${project}-${env}/app` | `JWT_SECRET`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT` | EC2 API tier, Lambda |

IAM policies on the instance role + Lambda role are scoped to those two
specific secret ARNs (no `*` resource).

The EC2 user-data fetches the secret at boot, populates env vars, then
hands off to `setup/backend-setup.sh`. Lambda fetches at cold start and
caches the connection pool.

The secrets are created once at stack setup and rotated independently in
the Secrets Manager console afterward — applications pick up the new value
on next cold start.

## IAM

| Role | Purpose | Notable grants |
|---|---|---|
| `ec2-instance` | Attached to every EC2 via instance profile | `CloudWatchAgentServerPolicy`, `AmazonSSMManagedInstanceCore`, inline scoped to the 2 secrets + 2 log groups + `ses:SendEmail` with `FromAddress` condition |
| `lambda-subscription` | Renewal Lambda | `AWSLambdaVPCAccessExecutionRole`, `AWSLambdaBasicExecutionRole`, inline scoped to renewal SQS queues + 2 secrets + `ses:SendEmail` |
| `rds-monitoring` | Enhanced Monitoring | `AmazonRDSEnhancedMonitoringRole` (AWS-managed) |
| `github-deploy` (optional) | GitHub Actions OIDC | `autoscaling:StartInstanceRefresh`, `s3:PutObject` on static bucket, `cloudfront:CreateInvalidation`, `lambda:UpdateFunctionCode` on the renewal function |

No role uses `*` in resources except where AWS requires it (SES `*` is
narrowed by the `ses:FromAddress` condition key).

## Operator access

- **No SSH keys** by default. Operators connect via **SSM Session Manager**,
  which is encrypted in transit, logged to CloudWatch, and uses IAM rather
  than shared keys.
- If a bastion is needed, set `ssh_ingress_cidr` to a single operator/VPN
  CIDR — the SGs open port 22 only from that range.

## Data at rest

- **EBS volumes** encrypted (`encrypted = true` on every block device
  mapping in the launch templates).
- **RDS storage** encrypted with the AWS-managed KMS key for RDS.
- **S3 buckets** encrypted with SSE-S3 (AES-256).
- **Secrets Manager** encrypts secret material with AWS KMS automatically.

## Data in transit

- **Public ALB**: HTTPS only when `domain_name` is set. ALB TLS policy
  `ELBSecurityPolicy-TLS13-1-2-2021-06` (TLS 1.2 and 1.3, modern ciphers).
- **ACM**: certificates rotated automatically by AWS, no manual cert ops.
- **RDS**: TLS supported; Lambda + API connect with TLS (the Lambda uses
  `rejectUnauthorized: false` to skip the CA bundle, accepting the
  encrypted-but-not-CA-pinned tradeoff for class demo).
- **EC2 → Secrets Manager / SES / SQS**: all AWS APIs are TLS-only.

## Web Application Firewall

Public ALB is protected by AWS WAF v2 with three rules:

1. `AWSManagedRulesCommonRuleSet` — OWASP top 10 patterns.
2. `AWSManagedRulesKnownBadInputsRuleSet` — known exploit signatures.
3. `RateLimit2000PerMin` — block any IP exceeding 2k requests/min.

Sampled requests visible in the WAF console; aggregate metrics in CloudWatch.

## EC2 instance metadata

All launch templates require **IMDSv2** (`http_tokens = required`). This
prevents SSRF attacks from reaching `169.254.169.254` to steal the instance
profile credentials, which is a common exploitation path for misconfigured
web apps.

## Audit trail

- **CloudTrail** is enabled by default at the account level — every API
  call is logged.
- **ALB access logs** stream to a dedicated S3 bucket (90-day lifecycle).
- **CloudWatch Logs** keeps API + Web + Lambda logs 30 days.
- Application logger embeds `requestId`, `userId`, and `instanceId` in
  every line so a forensic search across tiers correlates cleanly.

## Threat model — what the stack does and doesn't defend against

| Threat | Defense |
|---|---|
| SQL injection | Parameterized queries everywhere; sanitizer overlays HTML-escape |
| XSS | HTML escape on every input; CSP via Helmet |
| CSRF | JWT in localStorage (read by JS) — **NOT** protected against CSRF; offset by SameSite cookies on the OIDC session, but the app should move to httpOnly cookies + CSRF tokens for a production launch |
| Bot abuse | WAF rate limit + per-IP express-rate-limit |
| Brute force on /login | express-rate-limit 15/15min + WAF |
| Compromised EC2 → DB | DB SG only allows API/Lambda SGs; DB has no internet route |
| Compromised CI credentials | OIDC role is scoped to ASG refresh + S3/CDN/Lambda; can't read secrets or create new IAM |
| Lost SSH key | None used — Session Manager only |
| Stolen cookie | Short JWT expiry (24h) limits blast radius; logout invalidates client-side only (no server-side denylist yet) |
| Data exfil from RDS | RDS in private subnets, no public endpoint, encryption at rest, encrypted backups |

Known gaps the launch-checklist would address: email verification at
registration, multi-factor auth, move JWT to httpOnly cookies, server-side
session denylist on logout.

## Compliance posture

- **PCI**: Card data never touches our servers — Square Web Payments SDK
  tokenizes in the browser, we only see the opaque `sourceId`.
- **GDPR / CCPA**: Pending — no data-export or delete-account endpoints
  yet.
- **HIPAA**: Not applicable.

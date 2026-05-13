# Architecture

Sparko Water is a 3-tier subscription / e-commerce platform deployed on AWS,
provisioned end-to-end by Terraform.

## High-level diagram

```
                                            ┌──────────────────────┐
                       ┌────────────────────┤   Route 53 + ACM     │
                       │                    └──────────────────────┘
                       │ DNS+TLS
                  ┌────▼──────┐
   Internet ─────►│  AWS WAF  │
                  └────┬──────┘
                       │
                  ┌────▼──────────┐
                  │  Public ALB   │  (port 80/443, S3 access logs)
                  └────┬──────────┘
                       │
                ┌──────┴──────┐
                │             │
       ┌────────▼───┐ ┌───────▼────┐         ┌──────────────────────┐
       │ Web ASG    │ │ Web ASG    │ ───────►│  CloudFront + S3     │
       │ (nginx) AZa│ │ (nginx) AZb│         │  static assets (CDN) │
       └────────┬───┘ └───────┬────┘         └──────────────────────┘
                │             │
                ▼             ▼
            ┌──────── Internal ALB ────────┐
            │     (port 80, VPC-private)   │
            └──────┬────────────────┬──────┘
                   │                │
       ┌───────────▼───┐  ┌─────────▼───────┐
       │  API ASG AZa  │  │  API ASG AZb    │       ┌─────────────────────┐
       │  (Node.js)    │  │  (Node.js)      │ ◄────►│ Secrets Manager     │
       └─────┬─────────┘  └────────┬────────┘       │  db / app secrets   │
             │                     │                └─────────────────────┘
             └──────────┬──────────┘                ┌─────────────────────┐
                        ▼                            │ CloudWatch          │
                  ┌──────────────┐                  │  log groups          │
                  │ RDS MySQL 8  │                  │  alarms → SNS → email│
                  │  Multi-AZ    │ ─────────────────│  dashboard           │
                  └──────────────┘                  └─────────────────────┘

       ┌────────────────────────── async pipeline ───────────────────────┐
       │  EventBridge (hourly)                                            │
       │       │                                                          │
       │       ▼                                                          │
       │  Lambda subscription-renewal  ◄─────  SQS subscription-renewal   │
       │       │                                                          │
       │       └─► (creates orders, awards points, sends SES email)        │
       │       │                                                          │
       │       └─► failures → SQS DLQ → CloudWatch alarm                  │
       └──────────────────────────────────────────────────────────────────┘
```

(See [`architecture.svg`](architecture.svg) for the formatted version when
the SVG export is in the repo.)

## No-domain mode

When `domain_name = ""` in `terraform.tfvars`, the stack runs in **HTTP-only
mode** suitable for a class demo without a registered domain name:

- The public ALB serves HTTP only on port 80; no Route 53, no ACM cert.
- Users access the site via the raw `*.elb.amazonaws.com` URL.
- HSTS is disabled in the API (see `ENABLE_HSTS` env var) so browsers don't
  cache an HTTPS-only pin that would brick future HTTP requests.
- SES email is effectively disabled (no verified sender domain). The
  password-reset endpoint returns the reset URL directly in its response so
  operators can hand it to the user manually.
- The Lambda subscription-renewal flow still runs but does not email customers.
- CloudFront is provisioned but unused (no `cdn.<domain>` alias). It serves
  static assets via its default `*.cloudfront.net` URL; the frontend doesn't
  link to it. Cost ≈ \$1/mo. Remove [`s3_cloudfront.tf`](../infra/s3_cloudfront.tf)
  if you want to skip it.
- Square stays in **sandbox** mode regardless of credentials, because
  Square's production card-tokenization requires HTTPS on the caller's origin.

To upgrade to HTTPS later: register a domain, set `domain_name` + `route53_zone_id`
in `terraform.tfvars`, also set `ENABLE_HSTS=true` in the API instance env, and
re-apply.

## Layers

### Edge
- **AWS WAF** (regional) attached to the public ALB with managed rule groups
  (`AWSManagedRulesCommonRuleSet`, `KnownBadInputs`) + a 2000 req/min/IP rate
  limit.
- **ACM** issues a public-trusted TLS cert validated via DNS in Route 53.
- **Route 53** hosts the apex, `www`, and `cdn.` records (alias to the
  public ALB and CloudFront respectively).

### Web tier (nginx)
- Auto Scaling Group across two AZs in private app subnets.
- Reverse-proxies `/api/`, `/healthz`, `/readyz` to the internal ALB.
- Serves static assets directly (and CloudFront caches them at the edge).
- ALB target group health check: `GET /nginx-health`.

### API tier (Node.js)
- Auto Scaling Group across two AZs in private app subnets.
- Behind an internal-only ALB so the web tier addresses it by a stable DNS
  name; the internal ALB also does the health-aware load balancing.
- ALB target group health check: `GET /readyz` (returns 503 when the DB is
  unreachable so the ALB drains the node automatically).
- SIGTERM-aware graceful shutdown so deploys / scale-in don't drop in-flight
  requests.

### Data tier (RDS MySQL 8)
- Multi-AZ deployment in private data subnets (no internet route).
- Storage encrypted with the AWS-managed KMS key for RDS.
- Daily automated backups + 7-day point-in-time recovery.
- Slow query + general logs exported to CloudWatch Logs.
- Performance Insights enabled.

### Async / subscription renewal
- **EventBridge** scheduled rule fires once an hour.
- **Lambda** scans MySQL for subscriptions whose `next_delivery` ≤ today,
  enqueues one SQS message per subscription.
- The same Lambda is also the SQS consumer — it creates the next order
  inside a transaction, awards rewards points, advances `next_delivery`,
  and emails the customer via SES.
- Failed renewals retry up to 3 times then land in a DLQ that triggers
  an alarm.

### Observability
- Three CloudWatch log groups: `/sparko/api`, `/sparko/web`, and the Lambda
  log group. The application logger (Winston) writes JSON to stdout with
  `requestId`, `instanceId`, `userId` on every line.
- CloudWatch dashboard with widgets for ALB request rate, 5xx, latency
  percentiles, healthy host count, RDS CPU / connections, and a Logs
  Insights panel for recent API errors.
- CloudWatch alarms wired to an SNS topic that emails an operator address.

### Security
- Tiered Security Groups: `alb_public → web → alb_internal → api → db`.
- IAM instance profiles with least-privilege inline policies (Secrets
  Manager read scoped to the two specific secrets; SES send scoped to a
  specific `FromAddress`).
- IMDSv2 required on every EC2.
- All EBS volumes encrypted.
- GitHub OIDC trust relationship for CI deploys — no long-lived AWS keys
  in the repo.
- Application sanitizes input (escapes HTML on every request), parameterized
  SQL throughout, PBKDF2-HMAC-SHA512 password hashing, JWT auth.

## Redundancy summary

| Layer | Redundancy |
|---|---|
| DNS | Route 53 — globally redundant by design |
| Edge | ALB lives in two AZs; AWS replaces failed nodes within minutes |
| Web tier | ≥2 nginx instances across 2 AZs in an ASG with rolling refresh |
| API tier | ≥2 Node.js instances across 2 AZs in an ASG with rolling refresh |
| Data tier | RDS Multi-AZ — synchronous standby in another AZ, automatic failover |
| Static assets | CloudFront edge caches + versioned S3 bucket |
| Async | SQS retains messages across DLQ; Lambda scales horizontally without operator action |

## Request flow (happy path)

1. Browser resolves `sparkowater.example.com` → ALB DNS via Route 53.
2. HTTPS terminates at the public ALB (cert from ACM).
3. WAF inspects the request, blocks if it matches a managed rule.
4. ALB forwards to a healthy web (nginx) target.
5. nginx serves static files from disk, or `proxy_pass`es `/api/*` to the
   internal ALB.
6. Internal ALB picks a healthy API node.
7. Node.js queries RDS, fetches/stores data, returns JSON.
8. Response flows back: API → internal ALB → nginx → public ALB → browser.

## Subscription renewal flow

1. Every hour, EventBridge invokes the renewal Lambda with `action: "scan"`.
2. Lambda queries RDS for `subscriptions WHERE next_delivery <= CURDATE()`.
3. Each due subscription is enqueued onto SQS with an idempotency key
   `sub-{id}-{date}`.
4. SQS triggers the same Lambda in consumer mode (batch size 5).
5. For each message, Lambda creates the order, advances the subscription's
   `next_delivery`, awards reward points, and sends a confirmation email
   via SES.
6. Failures retry up to 3 times then move to the DLQ, which triggers a
   CloudWatch alarm → SNS → email.

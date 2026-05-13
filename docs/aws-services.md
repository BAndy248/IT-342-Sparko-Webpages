# AWS Services Used

Every AWS service in the Sparko stack, what it does, and why we picked it
over alternatives.

| Service | Role in stack | Why this over alternatives |
|---|---|---|
| **VPC** | Network isolation: public / private-app / private-data subnets across 2 AZs | The standard 3-tier layout. NACL + SGs give defense in depth. |
| **EC2 + ASG** | Web (nginx) and API (Node.js) tiers, each with rolling refresh | ECS/Fargate would be the next step at higher scale; for a 2-tier ASG the EC2 setup is simpler to demonstrate. |
| **Application Load Balancer** (×2) | Public ALB terminates TLS for the internet; internal ALB lets the web tier address the API by stable DNS | Splitting public + internal lets us run the API in private subnets while still presenting a single endpoint per tier. NLB would skip the L7 features we use (health-aware routing, X-Forwarded-* headers). |
| **AWS WAF v2** | Managed rule groups + IP rate limit on the public ALB | Single-resource attachment + AWS-curated rules cover OWASP top-10 without writing custom logic. |
| **Auto Scaling Groups** | Min/desired/max for web (2/2/4) and API (2/2/6) tiers | Target-tracking on CPU keeps the tier sized to load; instance refresh gives zero-downtime rolling deploys. |
| **RDS MySQL 8 (Multi-AZ)** | Primary data store | Multi-AZ gives a synchronous standby in a second AZ with automatic failover. Aurora MySQL is the next tier (cheaper at scale, more expensive at small scale) — RDS MySQL fits a class demo. |
| **Secrets Manager** | DB credentials + JWT secret + Square keys | Versioning, automatic rotation hooks (if we add Lambda rotation later), and IAM-scoped access. Parameter Store would work for non-sensitive config, but Secrets Manager's audit story is better for credentials. |
| **CloudFront** | Edge caching for static assets (CSS/JS/Fonts/Images) | Cuts ALB load; pushed under a `cdn.` subdomain with its own ACM cert (must be in us-east-1). PriceClass_100 keeps it cheap. |
| **S3** | Static-asset origin for CloudFront + ALB access logs | Versioned + encrypted; Origin Access Control means only CloudFront (not the public internet) can read objects. |
| **Route 53** | DNS — apex, `www`, `cdn`, ACM validation, SES DKIM CNAMEs | A-records use AWS alias to the ALB so there's no `dig` round-trip to an IP. Hosted zone is operator-managed and referenced by id. |
| **ACM** | Public ALB cert (`example.com` + SAN) and CloudFront cert (`cdn.example.com`, must be us-east-1) | DNS validation auto-creates the records in Route 53 — no manual ops. |
| **CloudWatch Logs** | Three log groups (`/sparko/api`, `/sparko/web`, Lambda) | Application logger writes structured JSON; the unified agent on each EC2 ships log files; Lambda automatically gets its own group. |
| **CloudWatch Metrics + Alarms** | ALB 5xx, p99 latency, healthy host count, RDS CPU/storage/connections, SQS DLQ depth | Each alarm targets a specific failure mode so operator gets a precise signal, not "something is wrong". |
| **CloudWatch Dashboard** | Single-pane overview of ALB, healthy hosts, RDS, recent errors | Built in Terraform so it's reproducible and not a manual console artifact. |
| **SNS** | Single `alerts` topic; alarms publish here; email subscription notifies operator | Topic is the indirection point — we can add Slack / PagerDuty / Opsgenie subscriptions later without touching the alarms. |
| **EventBridge** | Hourly schedule that invokes the renewal Lambda | Native AWS cron — no extra infra. Decoupled from Lambda so we could route to Step Functions later. |
| **Lambda** | Subscription renewal (scan + consumer in one function) | Tiny footprint; scales by SQS depth; no idle cost. Runs inside the VPC to reach RDS. |
| **SQS (×2)** | Renewal queue + DLQ | Buffers between EventBridge fan-out and per-subscription processing. Visibility-timeout + redrive policy give automatic retry-with-backoff. |
| **SES v2** | Transactional email (password reset, renewal confirmations) | One IAM permission, one verified identity. Domain identity auto-publishes DKIM via Route 53 records Terraform manages. |
| **IAM** | EC2 instance profile, Lambda execution role, GitHub OIDC deploy role | Each role has an inline policy limited to the specific resources it touches. No `*` ARNs except where AWS requires (`ses:SendEmail`). |
| **Systems Manager** | Session Manager for shell access; AMI lookup via `/aws/service/...` SSM parameter | Replaces SSH keys for operator access. Works in private subnets without a bastion. |
| **GitHub OIDC → AWS STS** | CI assumes a role to deploy without storing AWS keys in repo | Industry best practice for keyless CI deploys. |

## Services we considered but rejected (for now)

- **ECS / Fargate** — Would replace the EC2 + ASG tier. At our scale, the
  operational complexity isn't worth it; revisit at 10+ instances.
- **Cognito** — Built-in user pools, MFA, hosted UI. Sparko has its own
  PBKDF2-based auth already; migrating would be a separate project.
- **API Gateway + Lambda** — Serverless-only API. Would require a heavier
  rewrite (no Express middleware); the EC2-based API is fine for class.
- **DynamoDB** — NoSQL store. The data model (orders, addresses, items, joins)
  is relational; a key-value store would force denormalization.
- **CloudFormation / CDK** — Equally valid IaC choices. Picked Terraform for
  multi-cloud familiarity and the broader ecosystem.

## Cost-saving choices

- `single_nat_gateway = true` — one NAT GW instead of one per AZ (~$32/mo saved).
- `db.t3.micro` RDS — fits the small-instance free tier window.
- `t3.micro` / `t3.small` EC2 — burstable instances cover demo traffic for free
  or near-free.
- CloudFront `PriceClass_100` — only NA + EU edges; reduces request cost by ~30%.
- ALB access logs S3 bucket: 90-day lifecycle expiration so logs don't pile up.
- CloudWatch log retention capped at 30 days per group.

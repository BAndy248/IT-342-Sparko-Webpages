# Runbook

Operator playbook for the most common incidents. Each section is "what you
see → why → what to do".

---

## Alarm: `sparko-prod-alb-5xx-high`

**You see:** SNS email — ALB target group is returning 5XX errors.

**Most likely causes (in order):**
1. The API tier is throwing unhandled exceptions (deploy regression).
2. The RDS instance is unreachable (failover, network blip).
3. The Node process is OOM-killed.

**Triage:**

```bash
# 1. Quick health snapshot.
curl -fsS ""$SPARKO_URL"/readyz" || true
curl -fsS ""$SPARKO_URL"/healthz" || true

# 2. Look at the most recent errors.
aws logs tail /sparko/api --since 10m --filter-pattern 'level = "error"' --format short

# 3. Healthy host counts in the API target group.
aws elbv2 describe-target-health \
    --target-group-arn $(aws elbv2 describe-target-groups \
        --names sparko-prod-api --query 'TargetGroups[0].TargetGroupArn' --output text)
```

**Fix paths:**
- **Deploy regression**: roll back by triggering an instance refresh on the
  previous Launch Template version:
  ```bash
  aws autoscaling start-instance-refresh \
      --auto-scaling-group-name sparko-prod-api \
      --desired-configuration "LaunchTemplate={LaunchTemplateName=sparko-prod-api,Version=<previous-version>}"
  ```
- **RDS unreachable**: see `RDS-CPU` / `RDS-storage-low` runbook entries.
- **OOM**: edit the API tier launch template + ASG instance type in the EC2 console, then trigger an instance refresh.

---

## Alarm: `sparko-prod-api-healthy-hosts-low`

**You see:** SNS email — fewer than 1 healthy API host.

This is the canary for "the API is down". It usually fires alongside
`alb-5xx-high`.

**Triage:**

```bash
# Check which instances exist in the ASG and what state they're in.
aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names sparko-prod-api \
    --query 'AutoScalingGroups[0].Instances[].{Id:InstanceId,Az:AvailabilityZone,State:HealthStatus,Lifecycle:LifecycleState}'

# Drop into the first one via SSM.
aws ssm start-session --target <instance-id>
sudo journalctl -u sparko-api -n 100
```

**Common findings:**
- `Failed to connect to DB`: see the RDS section below.
- `Missing required environment variables`: Secrets Manager read failed.
  Check the IAM role has `secretsmanager:GetSecretValue` on the secret ARN
  (it should — but a manual edit might have removed it).
- `EADDRINUSE`: a hung previous process — kill it and let systemd restart.

**Mitigation while you investigate:**

```bash
# Force-replace all instances in the ASG. New instances bootstrap cleanly.
aws autoscaling start-instance-refresh --auto-scaling-group-name sparko-prod-api
```

---

## Alarm: `sparko-prod-rds-cpu-high`

**You see:** RDS CPU > 80% for 3 minutes.

**Triage:**

1. Look at Performance Insights for the top SQL statements in the last hour.
   [Performance Insights console](https://console.aws.amazon.com/rds/home#performance-insights).
2. Check whether a specific endpoint just got hot:
   ```bash
   aws logs start-query --log-group-name /sparko/api \
       --start-time $(($(date +%s) - 600)) --end-time $(date +%s) \
       --query-string 'fields path, durationMs | stats avg(durationMs) by path | sort by avg desc | limit 10'
   ```

**Fix paths:**
- **Slow query**: index it, then deploy. EXPLAIN against RDS via Session
  Manager on an API instance.
- **Sudden traffic spike**: the ASG should auto-scale; if it's already at
  `max_size`, bump `api_max_size` and re-apply.
- **Connection storm**: check `DatabaseConnections` metric. If we're near
  100, we need PgBouncer/ProxySQL or just a larger instance class.

---

## Alarm: `sparko-prod-rds-storage-low`

**You see:** RDS free storage < 2 GiB.

**Fix:**

```bash
# Bump storage. RDS supports online resize (gp3 auto-storage-scaling is
# enabled by default, but we cap at the allocated_storage configured in the RDS console).
# Quick fix:
aws rds modify-db-instance \
    --db-instance-identifier sparko-prod-mysql \
    --allocated-storage 50 \
    --apply-immediately

# Then keep the change in the AWS console (or wherever you track infra config).
#    db_allocated_storage = 50
```

If storage is filling fast, audit log tables — `password_reset_tokens` and
`reward_history` accumulate but are rarely pruned.

---

## Alarm: `sparko-prod-sub-dlq-not-empty`

**You see:** a subscription-renewal message landed in the DLQ.

```bash
# Peek the message (does not delete).
aws sqs receive-message --queue-url ""$SPARKO_QUEUE_URL"" \
    --visibility-timeout 0 --message-attribute-names All --max-number-of-messages 5
# Or look at the DLQ specifically:
aws sqs receive-message --queue-url <DLQ URL from console>
```

The message body has the original `subscription_id`. Cross-reference the
Lambda logs:

```bash
aws logs tail /aws/lambda/sparko-prod-subscription-renewal --since 1h --filter-pattern 'renewal_failed'
```

**Fix paths:**
- **Card declined**: customer needs to update payment method. Email them.
- **Data integrity** (sub references a deleted product): patch the
  subscription, then re-drive the DLQ message:
  ```bash
  aws sqs start-message-move-task --source-arn <dlq-arn> \
      --destination-arn $(aws sqs get-queue-attributes \
          --queue-url <main queue url> --attribute-names QueueArn \
          --query 'Attributes.QueueArn' --output text)
  ```

---

## Deploy went sideways

Symptom: deploy workflow finished, but `/healthz` returns 503 or new code
isn't visible.

```bash
# 1. Is an instance refresh still in flight?
aws autoscaling describe-instance-refreshes \
    --auto-scaling-group-name sparko-prod-api \
    --query 'InstanceRefreshes[0].{Status:Status,Pct:PercentageComplete,Status:Status,StatusReason:StatusReason}'

# 2. Cancel a stuck refresh, then start a new one.
aws autoscaling cancel-instance-refresh --auto-scaling-group-name sparko-prod-api
aws autoscaling start-instance-refresh --auto-scaling-group-name sparko-prod-api

# 3. Roll back to the previous Launch Template version.
aws ec2 describe-launch-template-versions \
    --launch-template-name sparko-prod-api \
    --query 'LaunchTemplateVersions[].{V:VersionNumber,Created:CreateTime}'
aws autoscaling start-instance-refresh \
    --auto-scaling-group-name sparko-prod-api \
    --desired-configuration "LaunchTemplate={LaunchTemplateName=sparko-prod-api,Version=<n-1>}"
```

For frontend: re-sync the previous commit's `Front-End/` and invalidate
CloudFront.

---

## Restoring RDS from a snapshot

Triggered when the DB is unrecoverably corrupt or hit by a destructive bug.

```bash
# 1. Find the most recent automated snapshot.
aws rds describe-db-snapshots \
    --db-instance-identifier sparko-prod-mysql \
    --snapshot-type automated \
    --query 'reverse(sort_by(DBSnapshots, &SnapshotCreateTime))[0].DBSnapshotIdentifier'

# 2. Restore as a new instance.
aws rds restore-db-instance-from-db-snapshot \
    --db-instance-identifier sparko-prod-mysql-restore \
    --db-snapshot-identifier <snapshot-id> \
    --multi-az \
    --db-subnet-group-name sparko-prod-db \
    --vpc-security-group-ids <db-sg-id>

# 3. Wait, validate, then cut over by editing the Secrets Manager 'db'
#    secret to point at the restore endpoint. Existing API instances will
#    pick it up on next pool refresh / on next restart:
aws autoscaling start-instance-refresh --auto-scaling-group-name sparko-prod-api

# 4. Drop the old instance once the cutover is verified.
```

**Drill this regularly.** An untested restore is a wish.

---

## Rotating a secret

```bash
# 1. Pick a new value (let AWS generate it).
aws secretsmanager get-random-password --password-length 32 --exclude-punctuation

# 2. For the DB password, run an in-place RDS modify with the new master
#    password; subsequent rotation in the Secrets Manager console is independent of the original creation.
aws rds modify-db-instance --db-instance-identifier sparko-prod-mysql \
    --master-user-password <new-password> --apply-immediately

# 3. Update the secret.
aws secretsmanager put-secret-value --secret-id sparko-prod/db \
    --secret-string "$(aws secretsmanager get-secret-value --secret-id sparko-prod/db \
        --query SecretString --output text | \
        jq --arg pw "<new-password>" '.password = $pw')"

# 4. Roll the API tier so new processes pick up the rotated secret.
aws autoscaling start-instance-refresh --auto-scaling-group-name sparko-prod-api
```

---

## A user emailed support saying their order didn't arrive

```bash
# 1. Find them.
aws ssm start-session --target <any-api-instance>
mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME"
mysql> SELECT id, email, first_name FROM users WHERE email = 'them@example.com';

# 2. Look at their orders + subscriptions.
mysql> SELECT o.id, o.status, o.total, o.created_at, s.frequency, s.next_delivery
       FROM orders o LEFT JOIN subscriptions s ON o.subscription_id = s.id
       WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 10;

# 3. If the renewal Lambda failed, the order won't exist — check the DLQ.
# 4. If it succeeded but they didn't get the email, check SES SendStatistics
#    or look in CloudWatch Logs for the lambda's "email_send_failed" entries.
```

---

## Common AWS CLI shortcuts

```bash
# All ASGs at a glance.
aws autoscaling describe-auto-scaling-groups \
    --query 'AutoScalingGroups[].{N:AutoScalingGroupName,Min:MinSize,Des:DesiredCapacity,Max:MaxSize}'

# Tail logs from a tier.
aws logs tail /sparko/api --follow --filter-pattern 'level = "error"'

# Get a one-line health summary.
URL="$SPARKO_URL"
echo "nginx:   $(curl -sw '%{http_code}' -o /dev/null $URL/nginx-health)"
echo "healthz: $(curl -sw '%{http_code}' -o /dev/null $URL/healthz)"
echo "readyz:  $(curl -sw '%{http_code}' -o /dev/null $URL/readyz)"
```

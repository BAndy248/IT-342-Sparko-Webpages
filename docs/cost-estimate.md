# Cost Estimate

All figures are **us-east-1**, on-demand pricing as of early 2026. Real bills
will vary with traffic, NAT-GW byte counts, and CloudWatch ingest volume.
Use the [AWS Pricing Calculator](https://calculator.aws/) for an exact quote.

## Demo footprint (single-AZ, t3.micro everywhere)

Designed to stay under ~$70/month so a class demo doesn't burn budget.

| Service | Quantity / config | Est. monthly cost |
|---|---|---|
| **EC2 web**       | 2 × t3.micro (~$7.50 each) | $15 |
| **EC2 API**       | 2 × t3.small (~$15 each) | $30 |
| **EBS volumes**   | 4 × ~15 GB gp3 | $5 |
| **Public ALB**    | 1 ALB + ~2 LCU avg | $20 |
| **Internal ALB**  | 1 ALB + ~1 LCU avg | $16 |
| **RDS**           | db.t3.micro Multi-AZ + 20 GB gp3 | $30 |
| **NAT gateway**   | 1 × NAT GW (~$32) + ~3 GB egress | $35 |
| **CloudFront**    | ~10 GB transfer + ~100k requests | $1 |
| **S3**            | 2 buckets, <1 GB each | $0.10 |
| **CloudWatch**    | 5 GB logs ingest + 10 custom metrics | $5 |
| **SNS + EventBridge + SQS** | Minimal volume | $0.10 |
| **Lambda**        | 24 invocations/day × ~500ms × 256 MB | $0.10 |
| **SES**           | Sandbox mode | $0 |
| **WAF**           | 1 web ACL + 3 rule groups | $9 |
| **Secrets Manager** | 2 secrets | $0.80 |
| **Route 53**      | 1 hosted zone + ~1M queries | $1 |
| **Data transfer out** | ~10 GB/mo | $1 |
| | | **~$170/month** |

That's higher than the "~$70" target — the **NAT gateway** and **ALBs**
are the two big-ticket items. Quick optimizations:

| Change | Savings | Tradeoff |
|---|---|---|
| Drop the internal ALB; point nginx upstream straight at API instance IPs in user-data | -$16/mo | Loss of health-aware routing; nginx has to discover instances via the ASG describe API |
| Single ALB with path-based routing (one target group per tier) | -$16/mo | Simpler but mixes tiers behind one ALB; demonstrates fewer cloud concepts |
| Multi-AZ off on RDS | -$15/mo | Loses standby failover — would only fit a dev environment |
| Use a VPC interface endpoint for Secrets Manager + skip NAT for the API tier | -$30/mo on NAT | +$15/mo for endpoints; net win above ~5 GB egress |
| Use Spot for the web ASG | -50% web cost | Class demo: probably not worth the complexity |

## Scaled footprint (~10× traffic)

If the same stack served ~1M requests/day instead of ~10k:

| Service | Change | New est. monthly |
|---|---|---|
| EC2 web | scale to 4 × t3.small | $60 |
| EC2 API | scale to 6 × t3.medium | $135 |
| ALB | +20 LCU | +$30 each |
| RDS | db.t3.medium Multi-AZ + 100 GB | $130 |
| NAT GW | +50 GB egress | +$5 |
| CloudFront | 200 GB transfer + ~10M requests | $25 |
| CloudWatch | 50 GB logs | $30 |
| | | **~$500-600/month** |

The cost shape is dominated by EC2 + RDS at this size. Moving to Aurora
Serverless v2 starts to make sense.

## Free-tier eligibility (new accounts)

For the first 12 months, an AWS account gets free tier on:
- 750 hrs/mo of t3.micro EC2
- 750 hrs/mo of db.t3.micro RDS (single-AZ)
- 5 GB S3
- 1 M Lambda requests
- 10 custom CloudWatch metrics
- 100 SNS notifications

If you run the demo with `db_multi_az = false` and `web_instance_type =
"t3.micro"`, much of the EC2 + RDS cost vanishes inside the free tier.

## Tags drive cost-allocation reports

Apply `Project`, `Environment`, and `Owner` tags to every resource at
creation time. Activate them as Cost Allocation Tags in
Billing → Cost allocation tags so reports group cleanly.

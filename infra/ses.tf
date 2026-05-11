###############################################################################
# SES — transactional email
#
# Two artifacts:
#   1. Domain identity (when var.domain_name is set) for from-addresses like
#      noreply@<domain>. SES will publish DKIM CNAMEs to Route 53 automatically.
#   2. Email identity for the explicit ses_from_address (works without a domain
#      while you're still in the SES sandbox).
#
# After apply, you must (a) verify the address by clicking the confirmation
# link SES emails you, then (b) request a sending-quota increase / sandbox
# exit before SES will deliver to addresses you haven't pre-verified.
###############################################################################

resource "aws_sesv2_email_identity" "from_address" {
  count          = var.ses_from_address == "" ? 0 : 1
  email_identity = var.ses_from_address
}

resource "aws_sesv2_email_identity" "domain" {
  count          = var.domain_name == "" ? 0 : 1
  email_identity = var.domain_name
}

# Auto-publish the DKIM CNAMEs that SES generates for the domain identity.
# Without these in DNS, SES sets the identity status to "Failed".
resource "aws_route53_record" "ses_dkim" {
  for_each = (var.domain_name == "" || var.route53_zone_id == "") ? {} : {
    for token in aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens :
    token => token
  }

  zone_id = var.route53_zone_id
  name    = "${each.value}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 300
  records = ["${each.value}.dkim.amazonses.com"]
}

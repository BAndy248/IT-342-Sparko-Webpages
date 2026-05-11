data "aws_availability_zones" "available" {
  state = "available"
}

# Always pull the latest Amazon Linux 2023 x86_64 AMI so re-applies don't get
# stuck on an old image. Pinning by SSM parameter is the AWS-recommended way.
data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

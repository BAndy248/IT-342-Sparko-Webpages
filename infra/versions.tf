terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Uncomment when you've created the S3 bucket + DynamoDB lock table that
  # the bootstrap step below describes. Keeping state remote means multiple
  # operators (and CI) can run terraform without clobbering each other.
  #
  # backend "s3" {
  #   bucket         = "sparko-tfstate-CHANGEME"
  #   key            = "prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "sparko-tflock-CHANGEME"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = var.owner
    }
  }
}

# CloudFront certificates must live in us-east-1 regardless of where the
# rest of the stack runs. This aliased provider exists for that one resource.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = var.owner
    }
  }
}

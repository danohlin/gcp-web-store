terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # Configured at init time from the persistent stack's output:
  #   terraform init -backend-config=backend.hcl
  #
  # use_lockfile is native S3 state locking, added in Terraform 1.10. It
  # removes the DynamoDB table the old pattern required — one less resource to
  # create, pay for and clean up.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Stack     = "ephemeral"
      # Makes it obvious in the console that this is safe to destroy.
      Lifecycle = "ephemeral"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# Only AZs that can actually take the instance types we ask for. Some regions
# have AZs where a given type simply is not offered, and a node group targeting
# one fails minutes into the apply.
data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  name       = "${var.project}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

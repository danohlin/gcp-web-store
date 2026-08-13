terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # State lives in the bucket this stack itself creates, so no state file sits
  # on local disk. That matters because state records the AWS account id and,
  # for the other stack, generated passwords in plaintext.
  #
  # Configured at init time rather than inline, because the bucket name embeds
  # the account id and this file is committed to a public repository:
  #   terraform init -backend-config=backend.hcl
  # The up and down scripts derive it automatically.
  #
  # Bootstrapping from nothing is a two-step dance, since the bucket cannot
  # hold the state that creates it:
  #   terraform init -backend=false
  #   terraform apply                       # creates the bucket
  #   terraform init -backend-config=backend.hcl -migrate-state
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Stack     = "persistent"
      Lifecycle = "permanent"
    }
  }
}

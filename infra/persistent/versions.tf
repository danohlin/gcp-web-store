terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # State lives in the bucket this stack itself creates, so no state file sits
  # on local disk. That matters because state records the project id and, for
  # the other stack, generated passwords in plaintext.
  #
  # Configured at init time rather than inline, because the bucket name embeds
  # the project id and this file is committed to a public repository:
  #   terraform init -backend-config=backend.hcl
  # The up and down scripts derive it automatically.
  #
  # Bootstrapping from nothing is a two-step dance, since the bucket cannot
  # hold the state that creates it:
  #   terraform init -backend=false
  #   terraform apply                       # creates the bucket
  #   terraform init -backend-config=backend.hcl -migrate-state
  #
  # Unlike S3 there is no `encrypt` or `use_lockfile` to set: GCS encrypts at
  # rest unconditionally and locks natively with a .tflock object.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region

  # GCP has no default_tags equivalent. Labels are applied per resource, and
  # only on the resource types that support them — networks, subnetworks and
  # forwarding rules do not.
  default_labels = {
    project    = var.project
    managed-by = "terraform"
    stack      = "persistent"
    lifecycle  = "permanent"
  }
}

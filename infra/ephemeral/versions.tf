terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Configured at init time rather than inline, because the bucket name embeds
  # the project id and this file is committed to a public repository:
  #   terraform init -backend-config=backend.hcl
  # The up and down scripts derive it automatically.
  #
  # State for this stack holds the generated database password in plaintext,
  # which is why the bucket has public access prevention enforced and why CI is
  # never granted read access to it.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = {
    project    = var.project
    managed-by = "terraform"
    stack      = "ephemeral"
    lifecycle  = "ephemeral"
  }
}

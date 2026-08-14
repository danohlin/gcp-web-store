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
  # Bootstrapping from nothing needs a detour, since the bucket cannot hold the
  # state that creates it. `terraform init -backend=false` is not enough on its
  # own: it leaves no backend record at all, and plan and apply then both refuse
  # to run with "Backend initialization required".
  #
  # Use an override file instead — override.tf and *_override.tf are gitignored
  # precisely so this is throwaway:
  #
  #   echo 'terraform { backend "local" {} }' > backend_override.tf
  #   terraform init -reconfigure
  #   terraform apply                       # creates the bucket, state is local
  #   rm backend_override.tf
  #   terraform init -migrate-state -force-copy -backend-config=backend.hcl
  #
  # Read the bucket name before deleting the override; once it is gone,
  # `terraform output` cannot reach the state to tell you.
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

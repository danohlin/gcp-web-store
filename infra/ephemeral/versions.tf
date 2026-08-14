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

  # Send X-Goog-User-Project on API calls that require a quota project.
  #
  # billingbudgets is one of them, and under user Application Default
  # Credentials it refuses outright without it:
  #
  #   Error 403: Your application is authenticating by using local Application
  #   Default Credentials. The billingbudgets.googleapis.com API requires a
  #   quota project, which is not set by default.
  #
  # `gcloud auth application-default set-quota-project` alone is not enough —
  # the provider only sends the header when this is on.
  user_project_override = true
  billing_project       = var.project_id

  default_labels = {
    project    = var.project
    managed-by = "terraform"
    stack      = "ephemeral"
    lifecycle  = "ephemeral"
  }
}

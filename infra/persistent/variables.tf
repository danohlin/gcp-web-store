variable "project_id" {
  description = <<-EOT
    GCP project id. Deliberately has no default: this repository is public, and
    the project id must never be committed. Supply it through the gitignored
    terraform.tfvars, or export TF_VAR_project_id.

    The project *number* is never needed by hand — it is read at plan time from
    the google_project data source.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id (6-30 chars, lowercase letters, digits and hyphens)."
  }
}

variable "project" {
  description = "Name prefix for every resource in this stack."
  type        = string
  default     = "web-store"
}

variable "region" {
  description = "GCP region."
  type        = string
  default     = "us-central1"
}

variable "github_repository" {
  description = "GitHub repository whose workflows may impersonate the CI service account, as owner/name."
  type        = string
  default     = "danohlin/gcp-web-store"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be in owner/name form."
  }
}

variable "github_allowed_ref" {
  description = <<-EOT
    Git ref permitted to impersonate the CI service account.

    The main branch only, because that is the only ref that deploys. Pull
    request builds run tests and need no cloud access at all.

    This is enforced in the provider's attribute_condition rather than in the
    principalSet binding. A principalSet on the ref alone would match that ref
    in *any* repository, which is the mirror image of the AWS trust-policy trap
    the previous stack documented.
  EOT
  type        = string
  default     = "refs/heads/main"
}

variable "image_retention_count" {
  description = "How many tagged images to keep per component before the oldest are expired."
  type        = number
  default     = 10
}

output "state_bucket" {
  description = "GCS bucket holding Terraform state. Feed this to the ephemeral stack's backend config."
  value       = google_storage_bucket.state.name
}

output "region" {
  description = "Region these resources live in."
  value       = var.region
}

output "artifact_registry_host" {
  description = "Registry hostname to authenticate docker against."
  value       = "${var.region}-docker.pkg.dev"
}

output "image_repos" {
  description = "Fully qualified image names, keyed by component. Used by CI and by the Helm values."
  value = {
    for c in local.components :
    c => "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.this.repository_id}/${c}"
  }
}

output "workload_identity_provider" {
  description = <<-EOT
    Set as the GCP_WORKLOAD_IDENTITY_PROVIDER repository variable in GitHub.

    Not a secret — it grants nothing without a matching OIDC token from the
    trusted repository and ref. It does embed the project number, so it belongs
    in a repository variable rather than in a committed file.
  EOT
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_actions_service_account" {
  description = "Set as the GCP_SERVICE_ACCOUNT repository variable in GitHub."
  value       = google_service_account.github_actions.email
}

output "backend_config" {
  description = "Ready-made -backend-config values for the ephemeral stack."
  value = {
    bucket = google_storage_bucket.state.name
    prefix = "ephemeral"
  }
}

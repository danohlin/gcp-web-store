#
# Workload Identity Federation for GitHub Actions.
#
# This lives in the persistent stack because CI has to keep working while the
# ephemeral environment is torn down.
#
# The shape is: GitHub's OIDC token -> a federated identity in the pool -> it
# impersonates a dedicated service account -> that account has exactly three
# permissions. Impersonation rather than direct federation, because federated
# principalSet tokens are capped at ten minutes and are not accepted everywhere
# in GCP. It is also the closer analogue of sts:AssumeRoleWithWebIdentity,
# which keeps the mental model unchanged from the AWS version.
#

locals {
  github_owner = split("/", var.github_repository)[0]
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "Federated identities for ${var.github_repository} workflows"

  depends_on = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions OIDC"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  # Only the claims actually used in the binding and the condition below.
  # Mapping more than is needed widens the attack surface for nothing.
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Mandatory for a GitHub provider — creation fails with INVALID_ARGUMENT
  # without it — and it must reference a mapped claim.
  #
  # This is where the ref restriction belongs. Putting it in the principalSet
  # binding instead would match that ref in any repository at all.
  #
  # Unlike the AWS trust policy this replaces, no numeric owner/repo ids are
  # needed: GitHub's `repository` claim is plain owner/name, and GCP verifies
  # the issuer's JWKS itself rather than pinning a CA thumbprint.
  attribute_condition = join(" && ", [
    "assertion.repository_owner == '${local.github_owner}'",
    "assertion.repository == '${var.github_repository}'",
    "assertion.ref == '${var.github_allowed_ref}'",
  ])
}

resource "google_service_account" "github_actions" {
  account_id   = "${var.project}-github-actions"
  display_name = "GitHub Actions CI for ${var.project}"
  description  = "Impersonated by workflows in ${var.github_repository} via Workload Identity Federation"

  depends_on = [google_project_service.this]
}

# The federated identity may impersonate the CI account, but only from the
# repository named above and only on the allowed ref.
resource "google_service_account_iam_member" "github_wif" {
  service_account_id = google_service_account.github_actions.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# ---------------------------------------------------------- CI's permissions
#
# Push images, and talk to a cluster that already exists. Deliberately no
# Terraform, no Secret Manager, no Cloud SQL: a compromised workflow therefore
# cannot create or destroy infrastructure, and cannot read the database
# password. Provisioning is a human-run operation through up.ps1.

resource "google_artifact_registry_repository_iam_member" "ci_push" {
  location   = google_artifact_registry_repository.this.location
  repository = google_artifact_registry_repository.this.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_actions.email}"
}

# container.developer allows helm to manage objects inside the cluster.
resource "google_project_iam_member" "ci_gke_developer" {
  project = var.project_id
  role    = "roles/container.developer"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# clusterViewer is what `gcloud container clusters get-credentials` and the
# existence check need. Without it the deploy fails at kubeconfig, not at the
# first kubectl call, which is a confusing place to land.
resource "google_project_iam_member" "ci_gke_viewer" {
  project = var.project_id
  role    = "roles/container.clusterViewer"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

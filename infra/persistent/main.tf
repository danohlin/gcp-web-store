#
# Everything that must survive a nightly teardown, and nothing else.
#
# Cost when the ephemeral stack is destroyed: a few kilobytes of GCS state plus
# whatever the container images occupy in Artifact Registry. Roughly ten cents
# a month.
#
# Rebuilding the registry daily would mean re-pushing every image each morning,
# which costs far more in time than the storage costs in money — hence keeping
# it here rather than in the ephemeral stack.
#

data "google_project" "this" {}

locals {
  # The project number is read from the project rather than hardcoded, so it
  # never appears in the repository. It is needed for the Workload Identity
  # principal:// strings in the ephemeral stack and for the default compute
  # service account below.
  project_number = data.google_project.this.number

  # GCS bucket names are globally unique, and project ids already are, so this
  # is both unique and derivable without being committed anywhere.
  state_bucket = "${var.project}-tfstate-${var.project_id}"

  components = ["backend", "frontend", "migrator"]
}

# ------------------------------------------------------------------- services
#
# Enabled here rather than in the ephemeral stack on purpose. A nightly destroy
# must never disable an API: re-enabling one takes up to a couple of minutes to
# propagate, and the morning apply would race it and fail somewhere in the
# middle, having already built half the environment.
resource "google_project_service" "this" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "sts.googleapis.com",
  ])

  service = each.key

  # Never disable on destroy. Other things in the project may depend on these,
  # and disabling an API can cascade into deleting its resources.
  disable_on_destroy = false
}

# ---------------------------------------------------------------- state store

resource "google_storage_bucket" "state" {
  name     = local.state_bucket
  location = var.region

  # Refuse to delete a bucket that still holds state. Losing it means losing
  # Terraform's record of every ephemeral resource.
  force_destroy = false

  # Versioning is what makes a corrupted or truncated state recoverable.
  versioning {
    enabled = true
  }

  # Uniform access: no per-object ACLs, so the IAM policy is the only thing
  # that governs who can read state. State holds the database password.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Soft delete defaults to 7 days and *bills for deleted-object storage*. On a
  # bucket that writes a new state version twice a day, that is a slow-growing
  # line item nobody thinks to look for. Zero disables it; versioning above is
  # the recovery mechanism that actually matters here.
  soft_delete_policy {
    retention_duration_seconds = 0
  }

  # A daily create/destroy cycle generates a new version on every apply, so old
  # versions are pruned to stop the bucket growing without bound.
  lifecycle_rule {
    condition {
      num_newer_versions = 10
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.this]
}

# There is no GCS analogue of the S3 DenyInsecureTransport bucket policy: GCS
# has no plaintext endpoint to deny.

# ------------------------------------------------------------ image registry
#
# One repository, not three. Artifact Registry repositories hold many packages,
# so backend/frontend/migrator are three images inside this one repo rather
# than three separate repositories as they were in ECR.
resource "google_artifact_registry_repository" "this" {
  location      = var.region
  repository_id = var.project
  format        = "DOCKER"
  description   = "Container images for ${var.project}"

  # Tags are mutable, which is the default and is therefore left unset rather
  # than stated. CI tags by commit SHA — already effectively immutable — and
  # turning immutable_tags on would make a re-run of the same commit fail on
  # push instead of succeeding idempotently.
  #
  # Setting it explicitly to false produces a perpetual diff: the API omits
  # docker_config when it holds only defaults, so every plan proposes adding
  # the block back.

  # Expire untagged images quickly; they are build leftovers.
  #
  # Note this is exactly why images are pushed with --provenance=false. Buildx
  # attestations create untagged child manifests, and a rule like this will
  # happily delete the children of a live tag, corrupting an image that is
  # still in use.
  cleanup_policies {
    id     = "expire-untagged"
    action = "DELETE"

    condition {
      tag_state  = "UNTAGGED"
      older_than = "86400s"
    }
  }

  # Keep only the most recent tagged images, per component.
  dynamic "cleanup_policies" {
    for_each = toset(local.components)

    content {
      id     = "keep-recent-${cleanup_policies.key}"
      action = "KEEP"

      most_recent_versions {
        package_name_prefixes = [cleanup_policies.key]
        keep_count            = var.image_retention_count
      }
    }
  }

  depends_on = [google_project_service.this]
}

# GKE Autopilot nodes run as the default compute service account, and setting a
# custom one is currently broken under enable_autopilot — the provider
# oscillates on node_config.service_account and forces cluster replacement on
# every plan (hashicorp/terraform-provider-google#23550). So rather than fight
# it, grant the default account read access to the registry.
#
# Without this, every pod sits in ImagePullBackOff on projects that enforce
# constraints/iam.automaticIamGrantsForDefaultServiceAccounts, with an error
# that reads like a registry outage rather than a permissions problem.
resource "google_artifact_registry_repository_iam_member" "nodes_pull" {
  location   = google_artifact_registry_repository.this.location
  repository = google_artifact_registry_repository.this.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${local.project_number}-compute@developer.gserviceaccount.com"
}

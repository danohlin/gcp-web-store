variable "project_id" {
  description = <<-EOT
    GCP project id. Deliberately has no default: this repository is public, and
    the project id must never be committed. Supply it through the gitignored
    terraform.tfvars, or export TF_VAR_project_id.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id (6-30 chars, lowercase letters, digits and hyphens)."
  }
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "web-store"
}

variable "environment" {
  description = "Environment name, used in resource names and secret ids."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "GCP region."
  type        = string
  default     = "us-central1"
}

variable "k8s_namespace" {
  description = <<-EOT
    Namespace the application is deployed into.

    This is baked into the Workload Identity principal:// bindings, so changing
    it here without changing the Helm release namespace breaks secret access
    with an opaque PermissionDenied from the CSI driver.
  EOT
  type        = string
  default     = "web-store"
}

variable "subnet_cidr" {
  description = "Primary CIDR for the subnet the nodes sit in."
  type        = string
  default     = "10.42.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary range for pod IPs. Autopilot is VPC-native, so pods get real routable addresses."
  type        = string
  default     = "10.42.16.0/20"
}

variable "services_cidr" {
  description = "Secondary range for ClusterIP services."
  type        = string
  default     = "10.42.32.0/20"
}

# ------------------------------------------------------------------ cost dials

variable "enable_cloud_nat" {
  description = <<-EOT
    Give pods a route to the public internet via Cloud NAT.

    Left off for the throwaway environment. Cloud NAT costs about $0.044/hr per
    gateway plus $0.045/GB processed, and nothing in this application needs it:
    Artifact Registry, Secret Manager and the Cloud SQL PSC endpoint are all
    reachable through Private Google Access, which is enabled on the subnet.
    `prisma migrate deploy` resolves from local node_modules with bundled
    engines and makes no network call either.

    The failure mode if something *does* reach for the internet is worth
    knowing: it fails with a DNS or connect timeout, not a permission error, so
    it reads like a broken dependency rather than a missing route.

    Turn it on for anything resembling production.
  EOT
  type        = bool
  default     = false
}

variable "use_spot_pods" {
  description = <<-EOT
    Schedule application pods onto Spot capacity, 60-91% cheaper than standard.

    This is the Autopilot equivalent of the node_capacity_type dial the EKS
    stack had, but it is applied through the Helm values rather than here:
    Autopilot has no node groups, so "spot" is a nodeSelector on the pod
    (cloud.google.com/gke-spot) instead of a property of a node pool. This
    variable only feeds the helm_values output.

    Two cautions carried into the chart: Spot Pods get a 25-second eviction
    grace period against terminationGracePeriodSeconds of 30, so pods are
    SIGKILLed part-way through draining; and the migration Job must never run
    on spot.
  EOT
  type        = bool
  default     = true
}

# ------------------------------------------------------------------------ gke

variable "release_channel" {
  description = <<-EOT
    GKE release channel. Replaces the pinned control plane version the EKS
    stack carried.

    Channels auto-upgrade, so there is no equivalent of the EKS "past end of
    standard support and silently billing six times as much" trap that pin
    existed to avoid. REGULAR is the default balance of currency and stability.

    Check what each channel currently serves with:
      gcloud container get-server-config --region=REGION \
        --format='value(channels.channel,channels.defaultVersion)'
  EOT
  type        = string
  default     = "REGULAR"

  validation {
    condition     = contains(["RAPID", "REGULAR", "STABLE"], var.release_channel)
    error_message = "release_channel must be RAPID, REGULAR or STABLE."
  }
}

variable "cluster_authorized_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach the Kubernetes API.

    Defaults to the whole internet because the endpoint still requires IAM
    authentication, and locking it to a home IP breaks whenever that IP changes
    and blocks GitHub Actions runners entirely. Narrow it if you can.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ------------------------------------------------------------------- cloud sql

variable "db_tier" {
  description = "Cloud SQL machine type. db-f1-micro is the cheapest shared-core tier; it carries no SLA, which is correct here."
  type        = string
  default     = "db-f1-micro"
}

variable "db_database_version" {
  description = <<-EOT
    Postgres major version.

    Unlike RDS, Cloud SQL takes an exact major and manages minors itself, so
    the "a pinned 16.6 silently becomes uncreatable" problem the EKS stack
    documented does not exist here.

    Keep this in step with the postgres image in ci.yml and docker-compose.yml.
    version-audit.yml asserts all three agree.

    List what is available with:
      gcloud sql flags list --format='value(appliesTo)' | Select-String POSTGRES
  EOT
  type        = string
  default     = "POSTGRES_17"
}

variable "db_disk_size_gb" {
  description = "Cloud SQL's smallest disk is 10 GB. Autoresize is off: it is a one-way ratchet, and this database is rebuilt daily."
  type        = number
  default     = 10
}

variable "db_name" {
  type    = string
  default = "webstore"
}

variable "db_username" {
  description = "Application database user. The password is generated by Terraform and written straight to Secret Manager."
  type        = string
  default     = "webstore"
}

variable "db_deletion_protection" {
  description = <<-EOT
    Must stay false, or terraform destroy cannot remove the database.

    Note this feeds *two* separate fields. The provider-level
    deletion_protection defaults to true, and settings.deletion_protection_enabled
    is a different, API-level flag. Missing either one fails the destroy at the
    very end of a several-minute run, every single evening.
  EOT
  type        = bool
  default     = false
}

# -------------------------------------------------------------------- budget

variable "budget_limit_usd" {
  description = "Monthly budget. Alerts fire at 80% and 100% of this. Set budget_notification_email to receive them."
  type        = number
  default     = 50
}

variable "budget_notification_email" {
  description = "Where budget alerts go. Leave empty to skip creating the budget."
  type        = string
  default     = ""
}

variable "billing_account_id" {
  description = <<-EOT
    Billing account the budget is attached to.

    No default, and never committed: like project_id this is an account
    identifier. Only needed when budget_notification_email is set.

    Creating a budget needs roles/billing.costsManager on the *billing account*,
    which is a higher bar than anything else in this stack — project-level
    permissions are not enough.
  EOT
  type        = string
  default     = ""
}

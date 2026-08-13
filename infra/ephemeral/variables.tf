variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "web-store"
}

variable "environment" {
  description = "Environment name, used in resource names and secret paths."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "k8s_namespace" {
  description = <<-EOT
    Namespace the application is deployed into.

    This is baked into the IRSA trust policies, so changing it here without
    changing the Helm release namespace breaks secret access with an opaque
    AccessDenied from the CSI driver.
  EOT
  type        = string
  default     = "web-store"
}

variable "vpc_cidr" {
  description = "CIDR for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "az_count" {
  description = "Availability zones to spread across. RDS needs a subnet group spanning at least two."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2
    error_message = "At least two availability zones are required for the RDS subnet group."
  }
}

# ------------------------------------------------------------------ cost dials

variable "enable_nat_gateway" {
  description = <<-EOT
    Place nodes in private subnets behind a NAT gateway.

    Left off for the throwaway environment: a NAT gateway costs about $0.045/hr
    plus data processing, adds several minutes to both apply and destroy, and is
    a frequent cause of a destroy hanging on lingering network interfaces. With
    it off, nodes sit in public subnets with no inbound access from the
    internet, while the database stays private with no route out at all.

    Turn it on for anything resembling production.
  EOT
  type        = bool
  default     = false
}

variable "node_capacity_type" {
  description = "ON_DEMAND or SPOT. Spot cuts node cost by roughly 70% and is fine for a environment that is rebuilt daily."
  type        = string
  default     = "SPOT"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.node_capacity_type)
    error_message = "node_capacity_type must be ON_DEMAND or SPOT."
  }
}

variable "node_instance_types" {
  description = "Candidate instance types. Several are listed so Spot can fall back rather than fail to place capacity."
  type        = list(string)
  default     = ["t3.medium", "t3a.medium", "t2.medium"]
}

variable "node_desired_size" {
  description = "Nodes to run."
  type        = number
  default     = 2
}

variable "node_min_size" {
  type    = number
  default = 1
}

variable "node_max_size" {
  type    = number
  default = 4
}

variable "node_disk_size_gb" {
  description = "Root volume per node."
  type        = number
  default     = 20
}

# ------------------------------------------------------------------------ eks

variable "kubernetes_version" {
  description = <<-EOT
    EKS control plane version.

    Keep this inside standard support. A cluster on a version past that date
    still runs, but silently moves to extended support at $0.60/hr instead of
    $0.10/hr — six times the control plane cost, and roughly four times the
    total bill for this environment. Nothing fails; the invoice just grows.

    Check current dates with:
      aws eks describe-cluster-versions --region us-east-1 \
        --query 'clusterVersions[].[clusterVersion,endOfStandardSupportDate]'

    Prefer the newest available rather than the smallest bump. This environment
    is destroyed and rebuilt daily, so there is no in-place upgrade risk to
    trade against a longer support window. The add-on versions are resolved
    from the cluster version rather than pinned, so they follow automatically.

    1.36 has standard support until 2027-08-01.
  EOT
  type        = string
  default     = "1.36"
}

variable "cluster_public_access_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach the Kubernetes API.

    Defaults to the whole internet because the endpoint still requires IAM
    authentication, and locking it to a home IP breaks whenever that IP changes
    and blocks GitHub Actions runners entirely. Narrow it if you can.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "cluster_admin_principals" {
  description = "Extra IAM role or user ARNs to grant cluster admin, beyond whoever runs the apply."
  type        = list(string)
  default     = []
}

variable "cluster_log_retention_days" {
  description = "CloudWatch retention for control plane logs. Short by design: these accumulate and outlive the cluster."
  type        = number
  default     = 1
}

variable "enabled_cluster_log_types" {
  description = "Control plane log types. Ingestion is billed, so the default is deliberately minimal."
  type        = list(string)
  default     = ["api", "audit"]
}

# ---------------------------------------------------------------------- rds

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro is the cheapest that runs Postgres 16."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_engine_version" {
  description = <<-EOT
    Postgres version.

    Major-only on purpose. RDS retires minor versions steadily, so a pinned
    "16.6" silently becomes uncreatable — the apply then fails at the database,
    after the VPC and cluster have already been built and billed for. Giving
    just "16" lets RDS select the current minor, and the provider compares by
    prefix so this does not produce a perpetual diff.

    Check what exists with:
      aws rds describe-db-engine-versions --engine postgres \
        --query 'DBEngineVersions[].EngineVersion'
  EOT
  type        = string
  default     = "16"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_multi_az" {
  description = "Multi-AZ roughly doubles database cost. Off for a throwaway environment."
  type        = bool
  default     = false
}

variable "db_name" {
  type    = string
  default = "webstore"
}

variable "db_username" {
  description = "Master username. The password is generated by Terraform and written straight to Secrets Manager."
  type        = string
  default     = "webstore"
}

variable "db_deletion_protection" {
  description = "Must stay false, or terraform destroy cannot remove the database."
  type        = bool
  default     = false
}

variable "db_skip_final_snapshot" {
  description = <<-EOT
    Skip the final snapshot on destroy.

    True for a throwaway environment whose data is reseeded on every deploy.
    Set false to keep data across teardowns; snapshot storage is a few cents a
    month, and the up script can restore from the newest one.
  EOT
  type        = bool
  default     = true
}

# -------------------------------------------------------------------- budget

variable "budget_limit_usd" {
  description = "Monthly budget. An alert fires at 80% and 100% of this. Set notification_email to receive them."
  type        = number
  default     = 50
}

variable "budget_notification_email" {
  description = "Where budget alerts go. Leave empty to skip creating the budget."
  type        = string
  default     = ""
}

#
# One VPC, one subnet, and optionally a NAT gateway.
#
# Much smaller than the AWS equivalent it replaces, for two reasons. GCP
# subnets are regional rather than zonal, so there is no per-AZ fan-out and no
# minimum of two for the database. And GCP firewall rules deny ingress by
# default, so the "database security group that must source from the cluster's
# own managed security group" dance has no counterpart: the Cloud SQL endpoint
# is only reachable from inside this VPC, and default egress covers the rest.
#

locals {
  name = "${var.project}-${var.environment}"
}

resource "google_compute_network" "main" {
  name                    = local.name
  auto_create_subnetworks = false
  description             = "VPC for ${local.name}"
}

resource "google_compute_subnetwork" "main" {
  name          = local.name
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = var.subnet_cidr

  # Reach Google APIs — Artifact Registry, Secret Manager, Cloud Logging — from
  # instances with no external IP and no NAT. This is what lets enable_cloud_nat
  # default to false without breaking image pulls or secret mounts.
  private_ip_google_access = true

  # Autopilot is VPC-native: pods and services get real addresses from these
  # secondary ranges rather than being NATed behind the node.
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }
}

# ------------------------------------------------------------------ cloud nat

resource "google_compute_router" "main" {
  count = var.enable_cloud_nat ? 1 : 0

  name    = local.name
  network = google_compute_network.main.id
  region  = var.region
}

resource "google_compute_router_nat" "main" {
  count = var.enable_cloud_nat ? 1 : 0

  name   = local.name
  router = google_compute_router.main[0].name
  region = var.region

  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = false
    filter = "ERRORS_ONLY"
  }
}

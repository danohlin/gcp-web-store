#
# GKE Autopilot.
#
# This file replaces roughly 250 lines of EKS: cluster, node group, three
# add-ons with resolved versions, two IAM roles with five policy attachments,
# an OIDC provider, a CloudWatch log group and two access entries. Autopilot
# manages nodes, and the pieces that had to be bolted on to EKS are either
# built in or unnecessary:
#
#   AWS Load Balancer Controller  -> the GKE Ingress controller is part of the
#                                    control plane
#   Secrets Store CSI driver      -> secret_manager_config below. The upstream
#      + AWS provider chart          driver cannot run on Autopilot at all: its
#                                    DaemonSet needs privileged write-mode
#                                    hostPath mounts, which Autopilot forbids.
#   IRSA roles and trust policies -> Workload Identity Federation, on by
#                                    default, binding straight to the pod's
#                                    Kubernetes service account. See secrets.tf.
#
resource "google_container_cluster" "main" {
  name     = local.name
  location = var.region

  enable_autopilot = true

  # Defaults to true since provider 5.0. Left true, the nightly destroy fails
  # at the very end of a several-minute run.
  deletion_protection = false

  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.main.id

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  release_channel {
    channel = var.release_channel
  }

  # The managed Secret Manager CSI component. Gives the cluster the `gke`
  # SecretProviderClass provider and the secrets-store-gke.csi.k8s.io driver,
  # which the chart mounts secrets through.
  secret_manager_config {
    enabled = true
  }

  private_cluster_config {
    # Nodes have no external IPs; egress to Google APIs goes through Private
    # Google Access on the subnet.
    enable_private_nodes = true

    # The control plane endpoint stays public, gated by
    # master_authorized_networks below. A private endpoint would need a bastion
    # or a VPN to run helm from a laptop, and would block GitHub Actions
    # runners outright.
    enable_private_endpoint = false
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = toset(var.cluster_authorized_cidrs)

      content {
        cidr_block   = cidr_blocks.key
        display_name = "authorized-${replace(cidr_blocks.key, "/[./]/", "-")}"
      }
    }
  }

  # Autopilot turns on SYSTEM_COMPONENTS and WORKLOADS logging and monitoring
  # by default. Workload logs bill past the 50 GiB monthly free tier and, unlike
  # the CloudWatch log group this replaces, they are not deleted by terraform
  # destroy — they outlive the cluster in Cloud Logging.
  #
  # SYSTEM_COMPONENTS is the minimum Autopilot accepts; dropping WORKLOADS is
  # the direct equivalent of the old cluster_log_retention_days = 1 dial.
  # Application logs still go to stdout and are readable with kubectl logs.
  logging_config {
    enable_components = ["SYSTEM_COMPONENTS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
  }

  resource_labels = {
    project     = var.project
    environment = var.environment
  }
}

#
# Consumed by scripts/up.ps1 to build the helm command line.
#
# No secret values are exposed here. Terraform state does contain the generated
# passwords in plaintext, which is why the state bucket enforces uniform access
# and public access prevention — but nothing sensitive is printed.
#

output "cluster_name" {
  value       = google_container_cluster.main.name
  description = "Feed to: gcloud container clusters get-credentials <this> --region <region>"
}

output "cluster_location" {
  value = google_container_cluster.main.location
}

output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "namespace" {
  value = var.k8s_namespace
}

output "network_name" {
  value = google_compute_network.main.name
}

output "secret_prefix" {
  description = "Secret Manager id prefix. Pass as secrets.prefix."
  value       = local.secret_prefix
}

output "database_host" {
  description = "Private Service Connect endpoint. Not reachable from outside the VPC."
  value       = google_compute_address.db.address
}

output "database_instance" {
  description = "Cloud SQL instance name. Randomised per build, so read it here rather than deriving it."
  value       = google_sql_database_instance.main.name
}

output "helm_values" {
  description = "Everything the chart needs, ready to splat onto a helm command."
  value = {
    "secrets.projectId" = var.project_id
    "secrets.prefix"    = local.secret_prefix
  }
}

output "use_spot_pods" {
  description = "Whether the chart should pin application pods to Spot capacity."
  value       = var.use_spot_pods
}

output "estimated_hourly_usd" {
  description = "Rough running cost while this stack exists. Zero once destroyed."
  value = format(
    "~$%.3f/hr (Autopilot cluster fee $0.10 — often $0 under the $74.40/month free tier, pods ~$%.3f %s, Cloud SQL %s ~$0.017, external ALB ~$0.025, Secret Manager ~$0.001%s)",
    0.10 + (var.use_spot_pods ? 0.003 : 0.008) + 0.017 + 0.025 + 0.001
    + (var.enable_cloud_nat ? 0.044 : 0),
    var.use_spot_pods ? 0.003 : 0.008,
    var.use_spot_pods ? "on spot" : "on demand",
    var.db_tier,
    var.enable_cloud_nat ? ", Cloud NAT $0.044" : ", no NAT"
  )
}

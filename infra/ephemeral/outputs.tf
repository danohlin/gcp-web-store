#
# Consumed by scripts/up.ps1 to build the helm command line.
#
# No secret values are exposed here. Terraform state does contain the generated
# passwords in plaintext, which is why the state bucket blocks public access,
# enforces TLS and is encrypted at rest — but nothing sensitive is printed.
#

output "cluster_name" {
  value       = aws_eks_cluster.main.name
  description = "Feed to: aws eks update-kubeconfig --name <this>"
}

output "cluster_endpoint" {
  value = aws_eks_cluster.main.endpoint
}

output "region" {
  value = var.region
}

output "namespace" {
  value = var.k8s_namespace
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.cluster.arn
}

output "alb_controller_role_arn" {
  description = "IRSA role for the aws-load-balancer-controller service account."
  value       = aws_iam_role.alb_controller.arn
}

output "csi_driver_role_arn" {
  description = "IRSA role for the Secrets Store CSI driver's AWS provider."
  value       = aws_iam_role.csi_driver.arn
}

output "app_role_arn" {
  description = "IRSA role for the application. Pass as serviceAccount.roleArn."
  value       = aws_iam_role.app.arn
}

output "database_secret_name" {
  description = "Secrets Manager name. Pass as secrets.databaseSecretName."
  value       = aws_secretsmanager_secret.database.name
}

output "app_secret_name" {
  description = "Secrets Manager name. Pass as secrets.appSecretName."
  value       = aws_secretsmanager_secret.app.name
}

output "database_endpoint" {
  description = "Private address; not reachable from outside the VPC."
  value       = aws_db_instance.main.address
}

output "helm_values" {
  description = "Everything the chart needs, ready to splat onto a helm command."
  value = {
    "secrets.region"             = var.region
    "secrets.databaseSecretName" = aws_secretsmanager_secret.database.name
    "secrets.appSecretName"      = aws_secretsmanager_secret.app.name
    "serviceAccount.roleArn"     = aws_iam_role.app.arn
  }
}

output "estimated_hourly_usd" {
  description = "Rough running cost while this stack exists. Zero once destroyed."
  value = format(
    "~$%.2f/hr (EKS control plane $0.10, %d x %s nodes %s, RDS %s, ALB ~$0.023%s)",
    0.10
    + (var.node_desired_size * (var.node_capacity_type == "SPOT" ? 0.0125 : 0.0416))
    + 0.016
    + 0.023
    + (var.enable_nat_gateway ? 0.045 : 0),
    var.node_desired_size,
    var.node_instance_types[0],
    lower(var.node_capacity_type),
    var.db_instance_class,
    var.enable_nat_gateway ? ", NAT $0.045" : ", no NAT"
  )
}

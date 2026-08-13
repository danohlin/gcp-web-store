#
# EKS control plane, managed node group, and the OIDC provider that IRSA needs.
#
# The cluster uses API authentication mode rather than the old aws-auth
# ConfigMap. Access entries are real IAM-backed resources, so a broken entry can
# be fixed with Terraform instead of requiring cluster access to repair the very
# ConfigMap that grants cluster access.
#

# ------------------------------------------------------------------ iam roles

data "aws_iam_policy_document" "cluster_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name_prefix        = "${local.name}-cluster-"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume_role.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

data "aws_iam_policy_document" "node_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name_prefix        = "${local.name}-node-"
  assume_role_policy = data.aws_iam_policy_document.node_assume_role.json
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "AmazonEKSWorkerNodePolicy",
    "AmazonEKS_CNI_Policy",
    # Nodes pull the application images from ECR.
    "AmazonEC2ContainerRegistryReadOnly",
    # Lets Systems Manager reach a node for debugging without opening SSH.
    "AmazonSSMManagedInstanceCore",
  ])

  role       = aws_iam_role.node.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value}"
}

# ------------------------------------------------------------------- logging

# Terraform-managed so `destroy` removes it. Left to EKS, the log group
# outlives the cluster, keeps accruing storage charges, and then collides with
# the next cluster of the same name.
resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${local.name}/cluster"
  retention_in_days = var.cluster_log_retention_days

  tags = {
    Name = "${local.name}-cluster-logs"
  }
}

# ------------------------------------------------------------------- cluster

resource "aws_eks_cluster" "main" {
  name     = local.name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  enabled_cluster_log_types = var.enabled_cluster_log_types

  vpc_config {
    # Nodes live in public subnets when NAT is disabled, so both tiers are
    # given to the control plane for ENI placement.
    subnet_ids              = concat(aws_subnet.public[*].id, aws_subnet.private[*].id)
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.cluster_public_access_cidrs
  }

  access_config {
    authentication_mode = "API"
    # Whoever runs the apply gets admin, so kubectl works immediately after.
    bootstrap_cluster_creator_admin_permissions = true
  }

  # No KMS envelope encryption. A customer-managed key costs $1/month and, more
  # importantly, carries a mandatory 7-30 day deletion window — so a cluster
  # rebuilt daily would leave a trail of pending-deletion keys. Secrets here
  # come from Secrets Manager, not from Kubernetes Secrets.

  tags = {
    Name = local.name
  }

  depends_on = [
    aws_iam_role_policy_attachment.cluster,
    aws_cloudwatch_log_group.cluster,
  ]
}

# ---------------------------------------------------------------------- oidc

data "tls_certificate" "cluster" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.cluster.certificates[0].sha1_fingerprint]

  tags = {
    Name = "${local.name}-oidc"
  }
}

# ---------------------------------------------------------------- node group

resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.name}-ng"
  node_role_arn   = aws_iam_role.node.arn

  # Public subnets when there is no NAT, because nodes must reach ECR and the
  # EKS endpoint somehow.
  subnet_ids = var.enable_nat_gateway ? aws_subnet.private[*].id : aws_subnet.public[*].id

  capacity_type  = var.node_capacity_type
  instance_types = var.node_instance_types
  disk_size      = var.node_disk_size_gb

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  # No taint on Spot capacity.
  #
  # A spot=true:NoSchedule taint was tried and broke the cluster: CoreDNS
  # tolerates only CriticalAddonsOnly, so its pods stayed Pending forever, the
  # coredns add-on never reached ACTIVE, and terraform apply hung for 17 minutes
  # with two healthy but unusable nodes.
  #
  # The taint also bought nothing. It exists to make workloads opt in to
  # interruptible capacity, which only matters in a mixed cluster. Every node
  # here is Spot, so there is nothing to opt out of. Reintroduce it only
  # alongside an on-demand group, and then give CoreDNS a matching toleration
  # through the add-on's configuration_values.
  labels = {
    "capacity-type" = lower(var.node_capacity_type)
  }

  tags = {
    Name = "${local.name}-ng"
  }

  lifecycle {
    # The autoscaler adjusts this; Terraform should not fight it on the next apply.
    ignore_changes = [scaling_config[0].desired_size]
  }

  depends_on = [aws_iam_role_policy_attachment.node]
}

# ------------------------------------------------------------------- add-ons

# Resolved rather than pinned, so a cluster version bump does not require
# hunting down matching add-on versions by hand.
data "aws_eks_addon_version" "this" {
  for_each = toset(["vpc-cni", "kube-proxy", "coredns"])

  addon_name         = each.key
  kubernetes_version = aws_eks_cluster.main.version
  most_recent        = true
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name  = aws_eks_cluster.main.name
  addon_name    = "vpc-cni"
  addon_version = data.aws_eks_addon_version.this["vpc-cni"].version

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name  = aws_eks_cluster.main.name
  addon_name    = "kube-proxy"
  addon_version = data.aws_eks_addon_version.this["kube-proxy"].version

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}

# CoreDNS schedules real pods, so it cannot install until nodes exist.
resource "aws_eks_addon" "coredns" {
  cluster_name  = aws_eks_cluster.main.name
  addon_name    = "coredns"
  addon_version = data.aws_eks_addon_version.this["coredns"].version

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.main]
}

# ------------------------------------------------------------- access entries

resource "aws_eks_access_entry" "admins" {
  for_each = toset(var.cluster_admin_principals)

  cluster_name  = aws_eks_cluster.main.name
  principal_arn = each.value
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "admins" {
  for_each = toset(var.cluster_admin_principals)

  cluster_name  = aws_eks_cluster.main.name
  principal_arn = each.value
  policy_arn    = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.admins]
}

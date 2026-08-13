#
# GitHub Actions authentication without long-lived keys.
#
# GitHub mints a short-lived OIDC token for each workflow run; AWS trades it for
# temporary credentials via sts:AssumeRoleWithWebIdentity. Nothing durable is
# stored in the repository, so there is no key to leak, rotate, or revoke.
#
# This lives in the persistent stack because CI has to keep working while the
# ephemeral environment is torn down.
#

resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  # The audience GitHub requests when configure-aws-credentials runs.
  client_id_list = ["sts.amazonaws.com"]

  # GitHub's published root CA thumbprints, both of them.
  #
  # Derived thumbprints were tried first and did not work: tls_certificate
  # returns the chain leaf-first, so the widely-copied `certificates[0]` gives
  # the endpoint's own leaf certificate, and the chain root as observed from a
  # given machine is not necessarily the CA AWS expects either.
  #
  # AWS documents that it no longer verifies this value for GitHub's endpoint,
  # but supplying the correct pair costs nothing and removes the variable.
  # Both are listed because GitHub serves from two CAs and rotates between them.
  thumbprint_list = var.github_oidc_thumbprints

  tags = {
    Name = "github-actions-oidc"
  }
}

# ---------------------------------------------------------------- trust policy

data "aws_iam_policy_document" "github_actions_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The single most important line in this file.
    #
    # Without a `sub` condition, the trust policy would accept a token from ANY
    # repository on GitHub — anyone could assume this role from a workflow in
    # their own repo. Scoping it to specific refs of a specific repository is
    # what makes OIDC safe.
    #
    # Deploys only happen from main, so that is the only ref trusted by default.
    # Pull request builds run tests and need no AWS access at all.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_subjects
    }
  }
}

# ------------------------------------------------------------------ ci policy

data "aws_iam_policy_document" "github_actions" {
  # The token endpoint is not resource-scoped; this action only ever grants the
  # ability to request an ECR login, which the statements below then constrain.
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPushPull"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
    ]

    # Limited to this project's repositories, not every repository in the account.
    resources = [for r in aws_ecr_repository.this : r.arn]
  }

  # Enough to run `aws eks update-kubeconfig`. What the role may then do inside
  # the cluster is governed separately, by an EKS access entry — IAM alone
  # grants no Kubernetes permissions.
  statement {
    sid     = "EksDescribe"
    effect  = "Allow"
    actions = ["eks:DescribeCluster", "eks:ListClusters"]
    resources = [
      "arn:aws:eks:${var.region}:${local.account_id}:cluster/${var.project}-*"
    ]
  }
}

resource "aws_iam_policy" "github_actions" {
  name_prefix = "${var.project}-gha-"
  description = "Push images to ECR and reach the EKS API for ${var.project}"
  policy      = data.aws_iam_policy_document.github_actions.json
}

resource "aws_iam_role" "github_actions" {
  name               = "${var.project}-github-actions"
  description        = "Assumed by GitHub Actions via OIDC. No static credentials exist for this role."
  assume_role_policy = data.aws_iam_policy_document.github_actions_trust.json

  # Deliberately not granted permission to run Terraform. Infrastructure is
  # applied deliberately from a workstation; CI only builds images and deploys
  # the chart. A compromised workflow therefore cannot create or destroy
  # infrastructure.
  max_session_duration = 3600

  tags = {
    Name = "${var.project}-github-actions"
  }
}

resource "aws_iam_role_policy_attachment" "github_actions" {
  role       = aws_iam_role.github_actions.name
  policy_arn = aws_iam_policy.github_actions.arn
}

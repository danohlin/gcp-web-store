#
# Everything that must survive a nightly teardown, and nothing else.
#
# Cost when the ephemeral stack is destroyed: a few kilobytes of S3 state plus
# whatever the container images occupy in ECR. Roughly ten cents a month.
#
# Rebuilding ECR daily would mean re-pushing every image each morning, which
# costs far more in time than the storage costs in money — hence keeping it here
# rather than in the ephemeral stack.
#

data "aws_caller_identity" "current" {}

locals {
  # The account id is read from the caller rather than hardcoded, so it never
  # appears in the repository.
  account_id   = data.aws_caller_identity.current.account_id
  state_bucket = "${var.project}-tfstate-${local.account_id}"

  repositories = ["backend", "frontend", "migrator"]

  # GitHub presents an immutable subject claim of the form
  #   repo:OWNER@OWNERID/REPO@REPOID:ref:refs/heads/main
  # not the name-only "repo:OWNER/REPO:ref:..." that most documentation shows.
  # Matching the name-only form fails with a bare "Not authorized to perform
  # sts:AssumeRoleWithWebIdentity" and a trust policy that looks correct.
  github_owner      = split("/", var.github_repository)[0]
  github_repo       = split("/", var.github_repository)[1]
  github_subject_id = "repo:${local.github_owner}@${var.github_owner_id}/${local.github_repo}@${var.github_repository_id}"

  # Main branch only unless explicitly overridden.
  github_subjects = coalesce(
    var.github_allowed_subjects,
    ["${local.github_subject_id}:ref:refs/heads/main"],
  )
}

# ---------------------------------------------------------------- state store

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  # Refuse to delete a bucket that still holds state. Losing it means losing
  # Terraform's record of every ephemeral resource.
  force_destroy = false

  tags = {
    Name        = local.state_bucket
    Description = "Terraform remote state"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Versioning is what makes a corrupted or truncated state recoverable.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# State contains database passwords in plaintext. This bucket must never be
# reachable from the internet.
resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  # A daily create/destroy cycle generates a new version on every apply, so old
  # versions are pruned to stop the bucket growing without bound.
  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

# Reject any plaintext request outright.
resource "aws_s3_bucket_policy" "state_tls_only" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.state.arn,
        "${aws_s3_bucket.state.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}

# ------------------------------------------------------------------------ ecr

resource "aws_ecr_repository" "this" {
  for_each = toset(local.repositories)

  name = "${var.project}/${each.key}"

  # Mutable on purpose. CI tags by commit SHA, which is already effectively
  # immutable, and IMMUTABLE would make a re-run of the same commit fail on
  # push rather than succeed idempotently.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = "${var.project}/${each.key}"
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images quickly; they are build leftovers."
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the most recent tagged images."
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.image_retention_count
        }
        action = { type = "expire" }
      },
    ]
  })
}

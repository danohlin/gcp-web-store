variable "project" {
  description = "Name prefix for every resource in this stack."
  type        = string
  default     = "web-store"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the CI role, as owner/name."
  type        = string
  default     = "danohlin/web-store"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be in owner/name form."
  }
}

variable "github_owner_id" {
  description = <<-EOT
    Numeric GitHub account id of the repository owner.

    GitHub embeds immutable ids in the OIDC subject claim, which reads
    "repo:OWNER@OWNERID/REPO@REPOID:ref:...", not the name-only form most
    examples still show. The ids are what make the claim immutable: renaming or
    transferring a repository cannot be used to impersonate the old one.

    Find with: gh api repos/OWNER/REPO --jq .owner.id
  EOT
  type        = number
  default     = 8661324
}

variable "github_repository_id" {
  description = "Numeric GitHub repository id. Find with: gh api repos/OWNER/REPO --jq .id"
  type        = number
  default     = 1317833055
}

variable "github_allowed_subjects" {
  description = <<-EOT
    OIDC subjects permitted to assume the CI role. Overrides the default built
    from github_repository and the numeric ids.

    Defaults to the main branch only, because that is the only ref that deploys.
    Pull request builds run tests and need no AWS access at all.

    Never widen this to a bare "repo:*" — the subject condition is the only
    thing stopping a workflow in someone else's repository from assuming this
    role.
  EOT
  type        = list(string)
  default     = null
}

variable "github_oidc_thumbprints" {
  description = <<-EOT
    Root CA thumbprints for token.actions.githubusercontent.com.

    Both of GitHub's published values, since it serves from two CAs and rotates
    between them. If GitHub ever changes CA entirely, refresh with:
      openssl s_client -servername token.actions.githubusercontent.com \
        -showcerts -connect token.actions.githubusercontent.com:443
    and take the fingerprint of the LAST certificate in the chain.
  EOT
  type        = list(string)
  default = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

variable "image_retention_count" {
  description = "How many tagged images to keep per repository before the oldest are expired."
  type        = number
  default     = 10
}

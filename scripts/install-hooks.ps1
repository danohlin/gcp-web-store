<#
.SYNOPSIS
  Points git at the tracked hooks in .githooks/.

.DESCRIPTION
  Git does not share .git/hooks, so hooks live in .githooks/ and are activated
  by setting core.hooksPath. This is a per-clone setting, so run it once after
  cloning.

  The pre-commit hook blocks credentials, private keys and hardcoded AWS
  account identifiers.
#>

$ErrorActionPreference = 'Stop'

$repoRoot = git rev-parse --show-toplevel
if (-not $?) { throw 'Not inside a git repository.' }

Set-Location $repoRoot
git config core.hooksPath .githooks

# Git for Windows honours the executable bit from the index.
git update-index --chmod=+x .githooks/pre-commit 2>$null

Write-Host 'Hooks enabled. core.hooksPath = .githooks' -ForegroundColor Green
Write-Host 'Pre-commit will now block .env files, tfvars, tfstate, private keys,'
Write-Host 'AWS access keys and hardcoded account ids in ARNs or ECR URIs.'

<#
.SYNOPSIS
  Builds the whole environment in GCP: infrastructure and the application.

.DESCRIPTION
  Expect roughly 15 minutes, dominated by the GKE control plane and Cloud SQL.
  Run down.ps1 when finished for the day; nothing here survives that.

  Notably shorter than its AWS predecessor, which had a whole "cluster add-ons"
  stage installing three Helm charts imperatively. None of that survives:

    AWS Load Balancer Controller  the GKE Ingress controller is part of the
                                  control plane
    Secrets Store CSI driver      replaced by secret_manager_config in the
       + AWS provider chart       Terraform cluster resource. The upstream
                                  driver cannot run on Autopilot at all — its
                                  DaemonSet needs privileged write-mode
                                  hostPath mounts, which Autopilot forbids.

  With them went three pinned chart versions, an IRSA annotation applied by
  kubectl because the chart exposed no value for it, and a mandatory rollout
  restart working around a webhook certificate the chart re-minted on every run.

.PARAMETER SkipInfra
  Reuse existing infrastructure and only redeploy the application.

.PARAMETER SkipBuild
  Do not rebuild or push images; deploy whatever tag is already in the registry.

.EXAMPLE
  .\scripts\up.ps1
  .\scripts\up.ps1 -SkipInfra          # app-only redeploy
#>
[CmdletBinding()]
param(
  [switch]$SkipInfra,
  [switch]$SkipBuild,
  [string]$Tag
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = git rev-parse --show-toplevel
Set-Location $repoRoot

$persistentDir = Join-Path $repoRoot 'infra/persistent'
$ephemeralDir = Join-Path $repoRoot 'infra/ephemeral'
$chartDir = Join-Path $repoRoot 'helm/web-store'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Info($msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

<#
Runs terraform and returns its exit code plus stderr, without tripping
$ErrorActionPreference = 'Stop'.

PowerShell turns a native command's stderr into ErrorRecord objects, and under
'Stop' the first one is a terminating error — so `terraform ... 2>&1` aborts the
script before any `if ($LASTEXITCODE ...)` check can run, making the error
handling below unreachable. Redirecting stderr to a file and relaxing the
preference for the duration avoids that.
#>
function Invoke-Terraform {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $errFile = [IO.Path]::GetTempFileName()
  try {
    & terraform @Arguments 2>$errFile
    $code = $LASTEXITCODE
    $stderr = if (Test-Path $errFile) { (Get-Content $errFile -Raw) } else { '' }
    if ($stderr) { Write-Host $stderr }
    return [pscustomobject]@{ ExitCode = $code; Stderr = $stderr }
  } finally {
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
    $ErrorActionPreference = $previous
  }
}

<#
Terraform holds a state lock for the duration of an operation and releases it
on exit. A run that is killed — Ctrl-C, a timeout, a closed window — never gets
to release it, and every later run then fails with "Error acquiring the state
lock" until it is cleared by hand.

This clears a lock only when no terraform process is running locally, which is
the signature of an abandoned run rather than a concurrent one. It deliberately
does not force past a live operation.

Still needed on GCS. The backend locks natively rather than through a separate
table, but an interrupted run leaves the .tflock object behind just the same.
#>
function Clear-StaleLock {
  param([string]$Output)

  if ($Output -notmatch 'Error acquiring the state lock') { return $false }

  $lockId = [regex]::Match($Output, 'ID:\s+([0-9a-f-]{36})').Groups[1].Value
  if (-not $lockId) { return $false }

  if (Get-Process terraform -ErrorAction SilentlyContinue) {
    Warn 'State is locked and terraform is running elsewhere. Not forcing.'
    return $false
  }

  Warn "Clearing a stale state lock left by an interrupted run ($lockId)"
  terraform force-unlock -force $lockId 2>&1 | Out-Null
  return $true
}

$started = Get-Date

# ---------------------------------------------------------------------------
Step 'Checking prerequisites'
foreach ($tool in 'terraform', 'gcloud', 'kubectl', 'helm', 'docker') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is not on PATH."
  }
}

# Checked separately because it is not a command anyone runs directly, and
# because its absence surfaces late and confusingly. kubectl shells out to it
# for every GKE API call, so without it the run gets all the way through the
# Terraform apply and the image pushes before dying at the first kubectl call
# with "getting credentials: exec: executable gke-gcloud-auth-plugin.exe not
# found" — which reads like a kubeconfig problem.
if (-not (Get-Command gke-gcloud-auth-plugin -ErrorAction SilentlyContinue)) {
  throw @'
gke-gcloud-auth-plugin is not on PATH. kubectl cannot authenticate to GKE without it.

  gcloud components install gke-gcloud-auth-plugin

If that fails with "Cannot use bundled Python installation to update Google
Cloud CLI in non-interactive mode", point CLOUDSDK_PYTHON at a copy first:

  $env:CLOUDSDK_PYTHON = (gcloud components copy-bundled-python | Select-Object -Last 1)
  gcloud components install gke-gcloud-auth-plugin --quiet
'@
}

$projectId = (gcloud config get-value project 2>$null)
if (-not $projectId -or $projectId -eq '(unset)') {
  throw 'No GCP project is configured. Run: gcloud config set project <PROJECT_ID>'
}
$account = (gcloud config get-value account 2>$null)
if (-not $account -or $account -eq '(unset)') {
  throw 'Not authenticated. Run: gcloud auth login; gcloud auth application-default login'
}
Ok "Authenticated as $account on project $projectId"

# Terraform reads this rather than a committed tfvars, so the project id never
# lands in the repository.
$env:TF_VAR_project_id = $projectId

# ---------------------------------------------------------------------------
Step 'Persistent stack (state bucket + Artifact Registry)'
Push-Location $persistentDir
try {
  # Backend config is derived rather than committed: the bucket name embeds the
  # project id, and this repository is public.
  #
  # No encrypt or use_lockfile as there were on S3 — GCS always encrypts at rest
  # and locks natively.
  terraform init -input=false -reconfigure `
    -backend-config="bucket=web-store-tfstate-$projectId" `
    -backend-config="prefix=persistent" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'persistent terraform init failed' }

  # Not piped to Out-Null: PowerShell turns a native command's stderr into a
  # NativeCommandError and the real Terraform message is lost, which makes a
  # failure here almost undiagnosable.
  terraform apply -auto-approve -input=false
  if ($LASTEXITCODE -ne 0) { throw 'persistent terraform apply failed' }

  $stateBucket = terraform output -raw state_bucket
  $registryHost = terraform output -raw artifact_registry_host
  $region = terraform output -raw region
  $repos = terraform output -json image_repos | ConvertFrom-Json
  Ok "State bucket: $stateBucket"
} finally { Pop-Location }

# ---------------------------------------------------------------------------
Step 'Ephemeral stack (VPC, GKE Autopilot, Cloud SQL)'
Info 'This is the slow part - the cluster and database take ~10 minutes between them.'
Push-Location $ephemeralDir
try {
  terraform init -input=false -reconfigure `
    -backend-config="bucket=$stateBucket" `
    -backend-config="prefix=ephemeral" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'terraform init failed' }

  # No equivalent of the EKS access-entry dance here. On EKS, IAM permissions
  # alone gave CI nothing inside the cluster and a separate access entry had to
  # name its role. GKE maps IAM to Kubernetes RBAC directly, so the
  # container.developer role granted in the persistent stack is sufficient.

  if (-not $SkipInfra) {
    $apply = Invoke-Terraform apply -auto-approve -input=false
    if ($apply.ExitCode -ne 0) {
      if (Clear-StaleLock -Output $apply.Stderr) {
        Info 'Retrying apply...'
        $retry = Invoke-Terraform apply -auto-approve -input=false
        if ($retry.ExitCode -ne 0) { throw 'terraform apply failed after clearing the lock' }
      } else {
        throw 'terraform apply failed'
      }
    }
  } else {
    Info 'Skipped (using existing infrastructure)'
  }

  $tf = @{}
  foreach ($k in 'cluster_name', 'cluster_location', 'region', 'namespace',
    'project_id', 'secret_prefix', 'database_host') {
    $tf[$k] = terraform output -raw $k
  }
  $cost = terraform output -raw estimated_hourly_usd
} finally { Pop-Location }

Ok "Cluster: $($tf.cluster_name)"
Info "Cost while running: $cost"

# ---------------------------------------------------------------------------
Step 'Configuring kubectl'
gcloud container clusters get-credentials $tf.cluster_name --region $tf.cluster_location --project $tf.project_id 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not get cluster credentials' }

# Autopilot reports no nodes until something is scheduled, so an empty list here
# is normal rather than a symptom.
$nodes = kubectl get nodes --no-headers 2>$null
if ($nodes) { $nodes | ForEach-Object { Info $_ } } else { Info 'No nodes yet; Autopilot provisions them when pods are scheduled.' }

# ---------------------------------------------------------------------------
Step 'Building and pushing images'
if (-not $Tag) { $Tag = (git rev-parse --short HEAD) }
Info "Tag: $Tag"

if (-not $SkipBuild) {
  # Installs a docker credential helper for the registry host, after which
  # docker authenticates transparently.
  #
  # Considerably simpler than the ECR equivalent, which needed a token written
  # to a temp file and piped in by cmd: docker rejected the same token from
  # PowerShell's stdin with 400 Bad Request, and --password would have put it on
  # the command line where any local process could read it.
  gcloud auth configure-docker $registryHost --quiet 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not configure the docker credential helper' }

  <#
  --provenance=false suppresses buildx's attestation manifests.

  With them on, every push produces a manifest LIST whose child manifests appear
  in the registry as separate untagged images. That is a problem here for two
  reasons: the repository fills with entries that look like junk but are not,
  and the cleanup policy that deletes untagged images after a day can delete the
  children of a live tag and corrupt it. Artifact Registry behaves exactly as
  ECR did in this respect.

  Attestations are worth having on a release pipeline. For a dev environment
  rebuilt daily they cost clarity and storage and buy nothing.
  #>
  docker build --provenance=false -t "$($repos.backend):$Tag" --target runtime ./backend
  docker build --provenance=false -t "$($repos.migrator):$Tag" --target migrator ./backend
  docker build --provenance=false -t "$($repos.frontend):$Tag" ./frontend
  foreach ($r in $repos.backend, $repos.migrator, $repos.frontend) {
    docker push "${r}:$Tag" | Out-Null
    Ok "pushed $(($r -split '/')[-1]):$Tag"
  }
} else {
  Info 'Skipped'
}

# ---------------------------------------------------------------------------
Step 'Deploying the application'
kubectl create namespace $tf.namespace --dry-run=client -o yaml | kubectl apply -f - | Out-Null

# 15m rather than 10: the migration Job is a pre-upgrade hook, and on a cold
# Autopilot cluster the scheduler has to provision capacity for it first.
helm upgrade --install web-store $chartDir `
  --namespace $tf.namespace `
  -f "$chartDir/values-dev.yaml" `
  --set backend.image.repository=$($repos.backend) --set backend.image.tag=$Tag `
  --set frontend.image.repository=$($repos.frontend) --set frontend.image.tag=$Tag `
  --set migration.image.repository=$($repos.migrator) --set migration.image.tag=$Tag `
  --set secrets.projectId=$($tf.project_id) `
  --set secrets.prefix=$($tf.secret_prefix) `
  --wait --timeout 15m
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nDeploy failed. Migration job logs:" -ForegroundColor Yellow
  kubectl logs -n $tf.namespace -l app.kubernetes.io/component=migrate --tail=50
  throw 'helm upgrade failed'
}

# ---------------------------------------------------------------------------
Step 'Waiting for the load balancer'
Info 'The GKE Ingress controller provisions it out of band; this usually takes 3-5 minutes.'
# .ip, not .hostname. A Google Cloud load balancer publishes an address; only an
# ALB publishes a hostname.
$address = ''
for ($i = 0; $i -lt 90; $i++) {
  $address = kubectl get ingress web-store -n $tf.namespace -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
  if ($address) { break }
  Start-Sleep -Seconds 5
}
if (-not $address) { throw "Load balancer did not appear. Check: kubectl describe ingress web-store -n $($tf.namespace)" }

Info "Address: $address"
Info 'Waiting for the backend to pass health checks...'
for ($i = 0; $i -lt 60; $i++) {
  try {
    $r = Invoke-WebRequest "http://$address/healthz" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { break }
  } catch { Start-Sleep -Seconds 5 }
}

$elapsed = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)

Write-Host ""
Write-Host "  Store is live:  http://$address" -ForegroundColor Green
Write-Host ""
Write-Host "  Brought up in $elapsed minutes. Cost while running: $cost" -ForegroundColor DarkGray
Write-Host "  Sign-in details are in Secret Manager, not printed here:" -ForegroundColor DarkGray
Write-Host "    gcloud secrets versions access latest --secret=$($tf.secret_prefix)-seed-admin-password" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  When you are done for the day:  .\scripts\down.ps1" -ForegroundColor Yellow
Write-Host ""

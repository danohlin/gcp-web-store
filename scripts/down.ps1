<#
.SYNOPSIS
  Destroys the ephemeral environment and verifies nothing billable is left.

.DESCRIPTION
  Order matters, and getting it wrong is the single most common way a teardown
  fails or quietly keeps charging:

    1. Uninstall the application release, then WAIT for the load balancer to
       disappear. The forwarding rule, target proxy, URL map, backend services,
       health checks and firewall rules are created by the GKE Ingress
       controller, not by Terraform, which knows nothing about them. Destroying
       the cluster and network first orphans the lot, and an orphaned global
       forwarding rule keeps billing at roughly $0.025/hr indefinitely.
    2. terraform destroy.
    3. Sweep for anything still costing money.

  Step 2 of the AWS version — uninstalling three controller charts from
  kube-system — has no counterpart: the GKE Ingress controller is part of the
  control plane and the Secret Manager CSI component is a cluster add-on, so
  neither is a Helm release that could be left behind.

  The persistent stack (state bucket and Artifact Registry) is deliberately left
  alone; it costs roughly ten cents a month and rebuilding it would mean
  re-pushing every image tomorrow.

.PARAMETER Force
  Skip the confirmation prompt.

.PARAMETER SkipSweep
  Skip the post-destroy billing sweep.
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipSweep
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = git rev-parse --show-toplevel
Set-Location $repoRoot

$ephemeralDir = Join-Path $repoRoot 'infra/ephemeral'
$persistentDir = Join-Path $repoRoot 'infra/persistent'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Info($msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

if (-not $Force) {
  Write-Host "`nThis destroys the GKE cluster, the database and all its data." -ForegroundColor Yellow
  Write-Host "The state bucket and container images are kept.`n"
  $answer = Read-Host 'Type "destroy" to continue'
  if ($answer -ne 'destroy') { Write-Host 'Aborted.'; exit 0 }
}

$started = Get-Date

# Region and bucket come from the persistent stack, which always exists.
$projectId = (gcloud config get-value project 2>$null)
if (-not $projectId -or $projectId -eq '(unset)') {
  throw 'No GCP project is configured. Run: gcloud config set project <PROJECT_ID>'
}
$env:TF_VAR_project_id = $projectId

Push-Location $persistentDir
try {
  # Derived, not committed: the bucket name embeds the project id.
  terraform init -input=false -reconfigure `
    -backend-config="bucket=web-store-tfstate-$projectId" `
    -backend-config="prefix=persistent" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'persistent terraform init failed' }

  $stateBucket = terraform output -raw state_bucket
  $region = terraform output -raw region
} finally { Pop-Location }

# ---------------------------------------------------------------------------
Step 'Removing the application (and its load balancer)'

$clusterName = ''
Push-Location $ephemeralDir
try {
  terraform init -input=false -reconfigure `
    -backend-config="bucket=$stateBucket" `
    -backend-config="prefix=ephemeral" | Out-Null

  $clusterName = terraform output -raw cluster_name 2>$null
  $clusterLocation = terraform output -raw cluster_location 2>$null
  $namespace = terraform output -raw namespace 2>$null
} finally { Pop-Location }

if ($clusterName) {
  if (-not $clusterLocation) { $clusterLocation = $region }
  gcloud container clusters get-credentials $clusterName --region $clusterLocation --project $projectId 2>&1 | Out-Null

  if ($LASTEXITCODE -eq 0) {
    if (-not $namespace) { $namespace = 'web-store' }

    helm uninstall web-store -n $namespace 2>&1 | Out-Null
    Info 'Release uninstalled; waiting for the load balancer to be deleted...'

    # Poll GCP directly rather than trusting the Kubernetes object to vanish:
    # the Ingress can disappear while the controller is still tearing down the
    # load balancer, and it is the forwarding rule that keeps billing.
    #
    # Matches the k8s2- prefix the GKE controller uses for the resources it
    # creates, so this cannot mistake an unrelated forwarding rule for ours.
    $deadline = (Get-Date).AddMinutes(6)
    while ((Get-Date) -lt $deadline) {
      $rules = gcloud compute forwarding-rules list --project $projectId `
        --filter="name~'^k8s2-' OR description~'web-store'" `
        --format='value(name)' 2>$null
      if (-not $rules) { break }
      Start-Sleep -Seconds 10
    }

    if ((Get-Date) -ge $deadline) {
      Warn 'Load balancer still present after 6 minutes. It will keep billing if the destroy orphans it.'
      Warn "Inspect with:  gcloud compute forwarding-rules list --project $projectId"
    } else {
      Ok 'Load balancer gone'
    }

    # Hook-created resources are not tracked by the release, so uninstall
    # leaves them behind.
    kubectl delete serviceaccount,secretproviderclass -n $namespace --all 2>&1 | Out-Null
    kubectl delete namespace $namespace --timeout=120s 2>&1 | Out-Null
    Ok 'Namespace removed'
  } else {
    Warn 'Could not reach the cluster; it may already be gone. Continuing.'
  }
} else {
  Info 'No cluster in state; nothing to uninstall.'
}

# ---------------------------------------------------------------------------
Step 'Destroying infrastructure'
Push-Location $ephemeralDir
try {
  terraform destroy -auto-approve -input=false
  if ($LASTEXITCODE -ne 0) {
    Warn 'Destroy failed. Most likely an orphaned load balancer resource holding the network,'
    Warn 'or deletion protection left enabled on the cluster or the database.'
    # String interpolation, not concatenation: `Warn 'text' + $region` would be
    # parsed as three separate arguments and silently drop the value.
    Warn "Inspect with:  gcloud compute forwarding-rules list --project $projectId"
    Warn "               gcloud compute firewall-rules list --project $projectId --filter=`"name~'^k8s'`""
    throw 'terraform destroy failed'
  }
} finally { Pop-Location }
Ok 'Infrastructure destroyed'

# ---------------------------------------------------------------------------
if (-not $SkipSweep) {
  Step 'Checking for anything still billable'
  & (Join-Path $repoRoot 'scripts/check-orphans.ps1') -ProjectId $projectId -Region $region
}

$elapsed = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Write-Host ""
Write-Host "  Torn down in $elapsed minutes." -ForegroundColor Green
Write-Host "  Remaining spend: the state bucket and container images, roughly `$0.10/month." -ForegroundColor DarkGray
Write-Host ""

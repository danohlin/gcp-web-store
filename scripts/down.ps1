<#
.SYNOPSIS
  Destroys the ephemeral environment and verifies nothing billable is left.

.DESCRIPTION
  Order matters, and getting it wrong is the single most common way an AWS
  teardown fails:

    1. Uninstall the application release, then WAIT for the ALB to disappear.
       The load balancer and its security groups are created by the controller,
       not by Terraform, so Terraform does not know they exist. Destroying the
       VPC while they are still there strands network interfaces that block
       subnet deletion, and the destroy hangs for ~20 minutes before failing.
    2. Uninstall the controllers.
    3. terraform destroy.
    4. Sweep for anything still costing money.

  The persistent stack (state bucket and ECR) is deliberately left alone; it
  costs roughly ten cents a month and rebuilding it would mean re-pushing every
  image tomorrow.

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
  Write-Host "`nThis destroys the EKS cluster, the database and all its data." -ForegroundColor Yellow
  Write-Host "The state bucket and ECR images are kept.`n"
  $answer = Read-Host 'Type "destroy" to continue'
  if ($answer -ne 'destroy') { Write-Host 'Aborted.'; exit 0 }
}

$started = Get-Date

# Region and bucket come from the persistent stack, which always exists.
$account = (aws sts get-caller-identity --query Account --output text 2>$null)
if (-not $account) { throw 'AWS credentials are not configured.' }
$account = $account.Trim()

Push-Location $persistentDir
try {
  # Derived, not committed: the bucket name embeds the account id.
  terraform init -input=false -reconfigure `
    -backend-config="bucket=web-store-tfstate-$account" `
    -backend-config="key=persistent/terraform.tfstate" `
    -backend-config="region=us-east-1" `
    -backend-config="encrypt=true" `
    -backend-config="use_lockfile=true" | Out-Null
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
    -backend-config="key=ephemeral/terraform.tfstate" `
    -backend-config="region=$region" `
    -backend-config="encrypt=true" `
    -backend-config="use_lockfile=true" | Out-Null

  $clusterName = terraform output -raw cluster_name 2>$null
  $namespace = terraform output -raw namespace 2>$null
} finally { Pop-Location }

if ($clusterName) {
  aws eks update-kubeconfig --name $clusterName --region $region 2>&1 | Out-Null

  if ($LASTEXITCODE -eq 0) {
    if (-not $namespace) { $namespace = 'web-store' }

    helm uninstall web-store -n $namespace 2>&1 | Out-Null
    Info 'Release uninstalled; waiting for the ALB to be deleted...'

    # Poll AWS directly rather than trusting the Kubernetes object to vanish:
    # the Ingress can disappear while the controller is still tearing down the
    # load balancer, and it is the ALB's network interfaces that block the VPC.
    $deadline = (Get-Date).AddMinutes(6)
    while ((Get-Date) -lt $deadline) {
      $albs = aws elbv2 describe-load-balancers --region $region `
        --query "LoadBalancers[?contains(LoadBalancerName, 'k8s-')].LoadBalancerArn" `
        --output text 2>$null
      if (-not $albs -or $albs -eq 'None') { break }
      Start-Sleep -Seconds 10
    }

    if ((Get-Date) -ge $deadline) {
      Warn 'ALB still present after 6 minutes. Destroy may hang on leftover network interfaces.'
    } else {
      Ok 'Load balancer gone'
    }

    # Hook-created resources are not tracked by the release, so uninstall
    # leaves them behind.
    kubectl delete serviceaccount,secretproviderclass -n $namespace --all 2>&1 | Out-Null
    kubectl delete namespace $namespace --timeout=120s 2>&1 | Out-Null

    helm uninstall secrets-provider-aws -n kube-system 2>&1 | Out-Null
    helm uninstall csi-secrets-store -n kube-system 2>&1 | Out-Null
    helm uninstall aws-load-balancer-controller -n kube-system 2>&1 | Out-Null
    Ok 'Controllers removed'
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
    Warn 'Destroy failed. Most likely a leftover ENI holding a subnet.'
    # String interpolation, not concatenation: `Warn 'text' + $region` would be
    # parsed as three separate arguments and silently drop the region.
    Warn "Inspect with:  aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=<vpc> --region $region"
    throw 'terraform destroy failed'
  }
} finally { Pop-Location }
Ok 'Infrastructure destroyed'

# ---------------------------------------------------------------------------
if (-not $SkipSweep) {
  Step 'Checking for anything still billable'
  & (Join-Path $repoRoot 'scripts/check-orphans.ps1') -Region $region
}

$elapsed = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Write-Host ""
Write-Host "  Torn down in $elapsed minutes." -ForegroundColor Green
Write-Host "  Remaining spend: the state bucket and ECR images, roughly `$0.10/month." -ForegroundColor DarkGray
Write-Host ""

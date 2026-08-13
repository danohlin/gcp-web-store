<#
.SYNOPSIS
  Builds the whole environment in AWS: infrastructure, cluster add-ons, and the
  application.

.DESCRIPTION
  Expect roughly 20 minutes, dominated by the EKS control plane. Run down.ps1
  when finished for the day; nothing here survives that.

  Cluster add-ons are installed with helm from this script rather than through
  Terraform's helm provider. Configuring a provider from resources created in
  the same apply is a well-known bootstrapping trap that fails on first run, and
  keeping the ordering explicit here also makes teardown ordering obvious.

.PARAMETER SkipInfra
  Reuse existing infrastructure and only redeploy the application.

.PARAMETER SkipBuild
  Do not rebuild or push images; deploy whatever tag is already in ECR.

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

<#
Cluster add-on chart versions, pinned deliberately.

Installing "whatever is latest today" makes a daily rebuild non-reproducible:
a green run proves nothing about tomorrow, because an upstream release lands
without any change on your side.

The ALB controller pin is load-bearing beyond reproducibility. Its IAM policy is
vendored at infra/ephemeral/policies/ and must match the controller version. The
two drifted once already — the policy sat at v2.11.0 while the chart floated to
v3.5.0, which withholds four permissions the newer controller needs, including
elasticloadbalancing:SetRulePriorities. That is how the ALB orders routing
rules, so /api would have stopped taking precedence over the catch-all.

When bumping ALB_CHART_VERSION, re-vendor the policy from the matching tag.
#>
$ALB_CHART_VERSION        = '3.5.0'
$CSI_DRIVER_CHART_VERSION = '1.6.0'
$CSI_AWS_CHART_VERSION    = '3.1.2'

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
foreach ($tool in 'terraform', 'aws', 'kubectl', 'helm', 'docker') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is not on PATH."
  }
}
$identity = aws sts get-caller-identity --output json | ConvertFrom-Json
if (-not $?) { throw 'AWS credentials are not configured. Run: aws configure --profile terraform-deployer' }
Ok "Authenticated as $($identity.Arn)"

# ---------------------------------------------------------------------------
Step 'Persistent stack (state bucket + ECR)'
Push-Location $persistentDir
try {
  # Backend config is derived rather than committed: the bucket name embeds the
  # account id, and this repository is public.
  terraform init -input=false -reconfigure `
    -backend-config="bucket=web-store-tfstate-$($identity.Account)" `
    -backend-config="key=persistent/terraform.tfstate" `
    -backend-config="region=us-east-1" `
    -backend-config="encrypt=true" `
    -backend-config="use_lockfile=true" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'persistent terraform init failed' }

  # Not piped to Out-Null: PowerShell turns a native command's stderr into a
  # NativeCommandError and the real Terraform message is lost, which makes a
  # failure here almost undiagnosable.
  terraform apply -auto-approve -input=false
  if ($LASTEXITCODE -ne 0) { throw 'persistent terraform apply failed' }

  $stateBucket = terraform output -raw state_bucket
  $registry = terraform output -raw ecr_registry
  $region = terraform output -raw region
  $repos = terraform output -json ecr_repository_urls | ConvertFrom-Json
  $ciRoleArn = terraform output -raw github_actions_role_arn
  Ok "State bucket: $stateBucket"
} finally { Pop-Location }

# ---------------------------------------------------------------------------
Step 'Ephemeral stack (VPC, EKS, RDS)'
Info 'This is the slow part - the EKS control plane alone takes ~10 minutes.'
Push-Location $ephemeralDir
try {
  # The backend is configured on the command line rather than committed,
  # because the bucket name embeds the account id.
  terraform init -input=false -reconfigure `
    -backend-config="bucket=$stateBucket" `
    -backend-config="key=ephemeral/terraform.tfstate" `
    -backend-config="region=$region" `
    -backend-config="encrypt=true" `
    -backend-config="use_lockfile=true" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'terraform init failed' }

  # Grant the CI role cluster access. IAM permissions alone give it nothing
  # inside Kubernetes; without this access entry, GitHub Actions authenticates
  # to AWS successfully and is then refused by the cluster.
  # Passed as TF_VAR_ rather than -var to avoid quoting a JSON list through
  # PowerShell's argument parser.
  $env:TF_VAR_cluster_admin_principals = (ConvertTo-Json @($ciRoleArn) -Compress)

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
  foreach ($k in 'cluster_name', 'region', 'namespace', 'alb_controller_role_arn',
    'csi_driver_role_arn', 'app_role_arn', 'database_secret_name',
    'app_secret_name', 'vpc_id') {
    $tf[$k] = terraform output -raw $k
  }
  $cost = terraform output -raw estimated_hourly_usd
} finally { Pop-Location }

Ok "Cluster: $($tf.cluster_name)"
Info "Cost while running: $cost"

# ---------------------------------------------------------------------------
Step 'Configuring kubectl'
aws eks update-kubeconfig --name $tf.cluster_name --region $tf.region | Out-Null
kubectl get nodes --no-headers | ForEach-Object { Info $_ }

# ---------------------------------------------------------------------------
Step 'Cluster add-ons'

Info 'AWS Load Balancer Controller...'
helm repo add eks https://aws.github.io/eks-charts 2>&1 | Out-Null
helm repo add secrets-store-csi-driver https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts 2>&1 | Out-Null
helm repo add aws-secrets-manager https://aws.github.io/secrets-store-csi-driver-provider-aws 2>&1 | Out-Null
helm repo update 2>&1 | Out-Null

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller `
  --version $ALB_CHART_VERSION `
  --namespace kube-system `
  --set clusterName=$($tf.cluster_name) `
  --set serviceAccount.create=true `
  --set serviceAccount.name=aws-load-balancer-controller `
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=$($tf.alb_controller_role_arn)" `
  --set region=$($tf.region) `
  --set vpcId=$($tf.vpc_id) `
  --wait --timeout 5m | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ALB controller install failed' }

<#
Restart the controller after every upgrade.

The chart mints a self-signed webhook certificate on each helm run, updating
both the TLS secret and the caBundle in the webhook configuration. The pods do
not restart, because the Deployment spec itself has not changed — so they keep
serving the certificate mounted at their original start, which no longer
matches the CA the API server now expects.

Nothing breaks until the next deploy, and then everything does: the webhook
intercepts every Service admission, so the whole release fails with

  failed calling webhook "mservice.elbv2.k8s.aws": x509: certificate signed by
  unknown authority

which reads like a cluster CA problem rather than a stale pod.
#>
kubectl rollout restart deployment aws-load-balancer-controller -n kube-system | Out-Null
kubectl rollout status deployment aws-load-balancer-controller -n kube-system --timeout=180s | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ALB controller did not become ready after restart' }

Ok 'ALB controller ready'

Info 'Secrets Store CSI driver...'
<#
syncSecret stays off: values must never be copied into Kubernetes Secrets, or
they would land in etcd, which is the whole point of mounting them as files.

tokenRequests is required and defaults to empty. The AWS provider assumes the
IRSA role of the pod whose volume it is mounting, which means it needs that
pod's service account token — and the driver only supplies one when an audience
is requested here. Without it every mount fails with:

  CSI token error: serviceAccount.tokens not provided

The audience must be sts.amazonaws.com to match what AWS STS expects.
#>
helm upgrade --install csi-secrets-store secrets-store-csi-driver/secrets-store-csi-driver `
  --version $CSI_DRIVER_CHART_VERSION `
  --namespace kube-system `
  --set syncSecret.enabled=false `
  --set enableSecretRotation=false `
  --set "tokenRequests[0].audience=sts.amazonaws.com" `
  --wait --timeout 5m | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'CSI driver install failed' }

# The AWS provider chart bundles the driver as a subchart, enabled by default.
# Leaving it on makes this release try to own a ServiceAccount named
# secrets-store-csi-driver that the driver release above already owns, and helm
# refuses with an ownership metadata error. Disable the subchart.
#
# fullnameOverride pins the provider's own ServiceAccount to
# secrets-store-csi-driver-provider-aws. Without it the name is prefixed with
# the release name and no longer matches the IRSA trust policy in Terraform.
#
# The chart exposes no serviceAccount.annotations value, so the IRSA annotation
# is applied afterwards with kubectl.
helm upgrade --install secrets-provider-aws aws-secrets-manager/secrets-store-csi-driver-provider-aws `
  --version $CSI_AWS_CHART_VERSION `
  --namespace kube-system `
  --set "secrets-store-csi-driver.install=false" `
  --set fullnameOverride=secrets-store-csi-driver-provider-aws `
  --wait --timeout 5m | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'CSI AWS provider install failed' }

kubectl annotate serviceaccount secrets-store-csi-driver-provider-aws `
  -n kube-system "eks.amazonaws.com/role-arn=$($tf.csi_driver_role_arn)" --overwrite | Out-Null

Ok 'Secrets Store CSI driver ready'

# ---------------------------------------------------------------------------
Step 'Building and pushing images'
if (-not $Tag) { $Tag = (git rev-parse --short HEAD) }
Info "Tag: $Tag"

if (-not $SkipBuild) {
  <#
  Docker rejects the ECR token with 400 Bad Request when it arrives on stdin
  from PowerShell, and also when written directly to the redirected stream from
  .NET — including as raw ASCII bytes with no BOM. Only a byte-clean shell pipe
  works. Verified against docker 29.6.2: the same token succeeds via
  --password and via a cmd pipe, and fails every other way.

  --password would be simpler but puts the token on the command line, where any
  local process can read it. The token goes to a temp file instead, is piped in
  by cmd, and the file is removed immediately afterwards.
  #>
  $tokenFile = Join-Path ([IO.Path]::GetTempPath()) "ecr-$([guid]::NewGuid().ToString('N')).txt"
  try {
    $token = aws ecr get-login-password --region $tf.region
    if ($LASTEXITCODE -ne 0) { throw 'could not obtain an ECR token' }

    [IO.File]::WriteAllText($tokenFile, $token, (New-Object System.Text.UTF8Encoding($false)))
    cmd /c "type `"$tokenFile`" | docker login --username AWS --password-stdin $registry" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'ECR login failed' }
  } finally {
    Remove-Item $tokenFile -Force -ErrorAction SilentlyContinue
  }

  <#
  --provenance=false suppresses buildx's attestation manifests.

  With them on, every push produces a manifest LIST whose child manifests appear
  in ECR as separate untagged images. That is a problem here for two reasons:
  the repository fills with entries that look like junk but are not, and the
  lifecycle rule that expires untagged images after a day can delete the children
  of a live tag and corrupt it.

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

helm upgrade --install web-store $chartDir `
  --namespace $tf.namespace `
  -f "$chartDir/values-dev.yaml" `
  --set backend.image.repository=$($repos.backend) --set backend.image.tag=$Tag `
  --set frontend.image.repository=$($repos.frontend) --set frontend.image.tag=$Tag `
  --set migration.image.repository=$($repos.migrator) --set migration.image.tag=$Tag `
  --set secrets.region=$($tf.region) `
  --set secrets.databaseSecretName=$($tf.database_secret_name) `
  --set secrets.appSecretName=$($tf.app_secret_name) `
  --set serviceAccount.roleArn=$($tf.app_role_arn) `
  --wait --timeout 10m
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nDeploy failed. Migration job logs:" -ForegroundColor Yellow
  kubectl logs -n $tf.namespace -l app.kubernetes.io/component=migrate --tail=50
  throw 'helm upgrade failed'
}

# ---------------------------------------------------------------------------
Step 'Waiting for the load balancer'
Info 'The controller provisions the ALB out of band; this usually takes 2-3 minutes.'
$address = ''
for ($i = 0; $i -lt 60; $i++) {
  $address = kubectl get ingress web-store -n $tf.namespace -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>$null
  if ($address) { break }
  Start-Sleep -Seconds 5
}
if (-not $address) { throw 'ALB did not appear. Check: kubectl describe ingress web-store -n ' + $tf.namespace }

Info "Address: $address"
Info 'Waiting for the ALB target group to pass health checks...'
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
Write-Host "  Sign-in details are in Secrets Manager, not printed here:" -ForegroundColor DarkGray
Write-Host "    aws secretsmanager get-secret-value --secret-id $($tf.app_secret_name) --query SecretString --output text" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  When you are done for the day:  .\scripts\down.ps1" -ForegroundColor Yellow
Write-Host ""

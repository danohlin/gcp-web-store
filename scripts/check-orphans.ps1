<#
.SYNOPSIS
  Lists resources in the project that still cost money.

.DESCRIPTION
  Run after down.ps1. "terraform destroy completed" is not the same as "nothing
  is billing" — anything created outside Terraform survives it, and those are
  exactly the things that quietly accrue charges:

    * The load balancer the GKE Ingress controller created, and every piece of
      it: forwarding rule, target proxy, URL map, backend services, health
      checks, network endpoint groups and firewall rules. Terraform never knew
      any of it existed.
    * Reserved static IP addresses, which bill while unattached
    * Persistent disks left by PersistentVolumeClaims
    * Cloud SQL instances and their backups
    * Cloud NAT gateways and the routers holding them

  One AWS check has no counterpart: secrets pending deletion. Secret Manager
  deletes immediately, so a leftover secret is simply a leftover, listed below
  as one.

  Read-only. It reports; it never deletes.
#>
[CmdletBinding()]
param(
  [string]$ProjectId,
  [string]$Region = 'us-central1',
  [string]$Project = 'web-store'
)

$ErrorActionPreference = 'Continue'

if (-not $ProjectId) {
  $ProjectId = (gcloud config get-value project 2>$null)
  if (-not $ProjectId -or $ProjectId -eq '(unset)') {
    throw 'No project. Pass -ProjectId or run: gcloud config set project <PROJECT_ID>'
  }
}

function Section($name) { Write-Host "`n  $name" -ForegroundColor Cyan }
function Clean() { Write-Host "    none" -ForegroundColor DarkGray }
function Found($line) { Write-Host "    $line" -ForegroundColor Yellow }

$total = 0

function Report($label, $items, $note) {
  Section $label
  $list = @($items | Where-Object { $_ -and $_.Trim() })
  if ($list.Count -eq 0) {
    Clean
  } else {
    $script:total += $list.Count
    foreach ($i in $list) { Found $i }
    if ($note) { Write-Host "      -> $note" -ForegroundColor DarkYellow }
  }
}

Write-Host "`nScanning project $ProjectId for billable leftovers..." -ForegroundColor White

# ---- the load balancer the Ingress controller built ------------------------
# Listed piece by piece rather than as one item, because they are deleted
# independently and a partial teardown leaves some but not others.

Report 'Forwarding rules' (
  gcloud compute forwarding-rules list --project $ProjectId --format='value(name,region,IPAddress)' 2>$null
) 'A global forwarding rule bills ~$0.025/hr. Delete: gcloud compute forwarding-rules delete <name> --global'

Report 'Target HTTP(S) proxies' (
  @(gcloud compute target-http-proxies list --project $ProjectId --format='value(name)' 2>$null) +
  @(gcloud compute target-https-proxies list --project $ProjectId --format='value(name)' 2>$null)
) 'Delete: gcloud compute target-http-proxies delete <name>'

Report 'URL maps' (
  gcloud compute url-maps list --project $ProjectId --format='value(name)' 2>$null
) 'Delete: gcloud compute url-maps delete <name>'

Report 'Backend services' (
  gcloud compute backend-services list --project $ProjectId --format='value(name,protocol)' 2>$null
) 'Delete: gcloud compute backend-services delete <name> --global'

Report 'Health checks' (
  gcloud compute health-checks list --project $ProjectId --format='value(name,type)' 2>$null
) 'Free, but they block deletion of the backend services that reference them.'

Report 'Network endpoint groups' (
  gcloud compute network-endpoint-groups list --project $ProjectId --format='value(name,zone)' 2>$null
) 'Created per-Service by container-native load balancing.'

Report 'Firewall rules created by GKE' (
  gcloud compute firewall-rules list --project $ProjectId --filter="name~'^k8s'" --format='value(name)' 2>$null
) 'Free, but they keep the network alive and block its deletion.'

# ---- addresses -------------------------------------------------------------
# Both scopes. A regional address left by a Service of type LoadBalancer and a
# global one reserved for an Ingress bill the same way, and listing only one
# scope is how the other gets missed.

Report 'Unattached IP addresses (regional)' (
  gcloud compute addresses list --project $ProjectId --filter='status!=IN_USE' --format='value(name,region,address)' 2>$null
) 'An unattached address bills ~$0.006/hr forever. Delete: gcloud compute addresses delete <name> --region <region>'

Report 'Unattached IP addresses (global)' (
  gcloud compute addresses list --project $ProjectId --global --filter='status!=IN_USE' --format='value(name,address)' 2>$null
) 'Delete: gcloud compute addresses delete <name> --global'

# ---- compute and data ------------------------------------------------------

Report 'GKE clusters' (
  gcloud container clusters list --project $ProjectId --format='value(name,location,status)' 2>$null
) 'Autopilot bills a $0.10/hr cluster fee plus per-pod resources.'

Report 'Cloud SQL instances' (
  gcloud sql instances list --project $ProjectId --format='value(name,databaseVersion,state)' 2>$null
) 'Delete: gcloud sql instances delete <name>'

Report 'Cloud SQL backups' (
  gcloud sql backups list --project $ProjectId --instance=- --format='value(id,windowStartTime,instance)' 2>$null
) 'Backups survive their instance and keep billing for storage.'

Report 'Unattached persistent disks' (
  gcloud compute disks list --project $ProjectId --filter='-users:*' --format='value(name,zone,sizeGb)' 2>$null
) 'Delete: gcloud compute disks delete <name> --zone <zone>'

Report 'Cloud NAT gateways' (
  gcloud compute routers list --project $ProjectId --format='value(name,region,network)' 2>$null
) 'A NAT gateway bills ~$0.044/hr plus data processed.'

Report 'VPC networks' (
  gcloud compute networks list --project $ProjectId --filter="name~'$Project'" --format='value(name)' 2>$null
) 'Free in themselves, but a surviving network means something inside it survived too.'

Report 'Secret Manager secrets' (
  gcloud secrets list --project $ProjectId --filter="name~'$Project'" --format='value(name)' 2>$null
) 'Roughly $0.06 per active version per month. Delete: gcloud secrets delete <name>'

# ---------------------------------------------------------------------------
Write-Host ""
if ($total -eq 0) {
  Write-Host "  Nothing billable found." -ForegroundColor Green
} else {
  Write-Host "  $total item(s) still present. Review the notes above." -ForegroundColor Yellow
  Write-Host "  Artifact Registry images and the Terraform state bucket are expected and excluded." -ForegroundColor DarkGray
}
Write-Host ""

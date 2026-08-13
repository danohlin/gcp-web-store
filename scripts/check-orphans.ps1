<#
.SYNOPSIS
  Lists resources in the region that still cost money.

.DESCRIPTION
  Run after down.ps1. "terraform destroy completed" is not the same as "nothing
  is billing" — anything created outside Terraform survives it, and those are
  exactly the things that quietly accrue charges:

    * Load balancers made by the AWS Load Balancer Controller
    * Their orphaned security groups and network interfaces
    * EBS volumes left by PersistentVolumeClaims
    * Elastic IPs, which bill while unattached
    * Public IPv4 addresses, billed since February 2024 even when in use
    * CloudWatch log groups, which outlive the cluster that wrote them
    * RDS snapshots

  Read-only. It reports; it never deletes.
#>
[CmdletBinding()]
param(
  [string]$Region = 'us-east-1',
  [string]$Project = 'web-store'
)

$ErrorActionPreference = 'Continue'

function Section($name) { Write-Host "`n  $name" -ForegroundColor Cyan }
function Clean($what) { Write-Host "    none" -ForegroundColor DarkGray }
function Found($line) { Write-Host "    $line" -ForegroundColor Yellow }

$total = 0

function Report($label, $items, $note) {
  Section $label
  if (-not $items -or $items -eq 'None' -or $items.Count -eq 0) {
    Clean
  } else {
    $script:total += @($items).Count
    foreach ($i in @($items)) { Found $i }
    if ($note) { Write-Host "      -> $note" -ForegroundColor DarkYellow }
  }
}

Write-Host "`nScanning $Region for billable leftovers..." -ForegroundColor White

Report 'Load balancers' (
  aws elbv2 describe-load-balancers --region $Region `
    --query 'LoadBalancers[].[LoadBalancerName,Type,State.Code]' --output text 2>$null
) 'Delete with: aws elbv2 delete-load-balancer --load-balancer-arn <arn>'

Report 'Classic load balancers' (
  aws elb describe-load-balancers --region $Region `
    --query 'LoadBalancerDescriptions[].LoadBalancerName' --output text 2>$null
) 'Delete with: aws elb delete-load-balancer --load-balancer-name <name>'

Report 'EKS clusters' (
  aws eks list-clusters --region $Region --query 'clusters' --output text 2>$null
) 'Costs $0.10/hr each.'

Report 'RDS instances' (
  aws rds describe-db-instances --region $Region `
    --query 'DBInstances[].[DBInstanceIdentifier,DBInstanceStatus]' --output text 2>$null
) $null

Report 'RDS snapshots (manual)' (
  aws rds describe-db-snapshots --region $Region --snapshot-type manual `
    --query 'DBSnapshots[].DBSnapshotIdentifier' --output text 2>$null
) 'Cheap, but they persist forever until deleted.'

Report 'NAT gateways' (
  aws ec2 describe-nat-gateways --region $Region `
    --filter 'Name=state,Values=available,pending' `
    --query 'NatGateways[].NatGatewayId' --output text 2>$null
) 'Costs ~$0.045/hr each.'

Report 'Unattached Elastic IPs' (
  aws ec2 describe-addresses --region $Region `
    --query 'Addresses[?AssociationId==null].PublicIp' --output text 2>$null
) 'Billed at ~$0.005/hr while unattached.'

Report 'Available (unattached) EBS volumes' (
  aws ec2 describe-volumes --region $Region `
    --filters 'Name=status,Values=available' `
    --query 'Volumes[].[VolumeId,Size]' --output text 2>$null
) 'Usually left behind by PersistentVolumeClaims.'

Report 'Running EC2 instances' (
  aws ec2 describe-instances --region $Region `
    --filters 'Name=instance-state-name,Values=running' `
    --query 'Reservations[].Instances[].[InstanceId,InstanceType]' --output text 2>$null
) $null

Report "VPCs tagged $Project" (
  aws ec2 describe-vpcs --region $Region `
    --filters "Name=tag:Project,Values=$Project" `
    --query 'Vpcs[].VpcId' --output text 2>$null
) 'A VPC is free, but it lingering means the destroy did not finish.'

Report 'Orphaned network interfaces' (
  aws ec2 describe-network-interfaces --region $Region `
    --filters 'Name=status,Values=available' `
    --query 'NetworkInterfaces[].[NetworkInterfaceId,Description]' --output text 2>$null
) 'These are what block a VPC from being deleted.'

Report "CloudWatch log groups for $Project" (
  aws logs describe-log-groups --region $Region `
    --log-group-name-prefix "/aws/eks/$Project" `
    --query 'logGroups[].logGroupName' --output text 2>$null
) 'Storage is billed until deleted; they outlive the cluster.'

Report 'Secrets pending deletion' (
  aws secretsmanager list-secrets --region $Region --include-planned-deletion `
    --query "SecretList[?DeletedDate!=null].Name" --output text 2>$null
) 'A pending-deletion secret keeps its name reserved and will collide with the next apply. Force with: aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery'

Write-Host ""
if ($total -eq 0) {
  Write-Host "  Clean. Nothing billable left in $Region." -ForegroundColor Green
} else {
  Write-Host "  $total item(s) still present - review the list above." -ForegroundColor Yellow
  Write-Host "  Some may belong to other projects in this account." -ForegroundColor DarkGray
}
Write-Host ""

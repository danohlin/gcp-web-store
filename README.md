# web-store

A full-featured shopping cart and storefront, containerised and deployed to
Amazon EKS. Payments are simulated — no real gateway, no real card is ever
charged.

The AWS environment is **ephemeral by design**: brought up in the morning,
destroyed at the end of the day, costing roughly **$1.50 for an eight-hour
day** and **~$0.10/month** while torn down.

---

## Stack

| Layer | Choice |
|---|---|
| Backend | Node 24, Express 5, Prisma, TypeScript |
| Frontend | React 19, Vite, TypeScript |
| Database | PostgreSQL 17 (RDS in AWS) |
| Payments | Mock gateway behind a `PaymentProvider` interface |
| Containers | Docker, multi-stage, non-root, read-only root filesystem |
| Orchestration | Amazon EKS, Helm |
| Infrastructure | Terraform, split into persistent and ephemeral stacks |
| Secrets | AWS Secrets Manager via the Secrets Store CSI driver |
| CI/CD | GitHub Actions with OIDC — no long-lived AWS keys |

## Features

Catalogue with Postgres full-text search, categories and filters · guest and
signed-in carts that merge on login · JWT auth with rotating refresh tokens and
password reset · checkout with mock payment · order history · admin product and
order management · responsive, keyboard-navigable UI.

---

## Repository layout

```
backend/          Express API, Prisma schema and migrations, 83 integration tests
frontend/         React SPA served by nginx in production
helm/web-store/   Chart: deployments, services, ALB ingress, HPAs, migration hook
infra/
  persistent/     State bucket, ECR, GitHub OIDC. Applied once, never destroyed.
  ephemeral/      VPC, EKS, RDS, IRSA, Secrets Manager. Destroyed nightly.
scripts/          up / down / orphan sweep / hook installer
.github/workflows ci.yml (tests, no AWS) and deploy.yml (OIDC, build, deploy)
```

---

## Local development

### Everything in containers

Needs only Docker.

```powershell
docker compose up --build
```

Then open **http://localhost:8080**.

Compose starts Postgres, waits for it to be healthy, runs migrations and the
seed to completion, starts the API, then nginx. Local sign-ins:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@web-store.local` | `ChangeMe-Admin-123` |
| Customer | `customer@web-store.local` | `ChangeMe-Customer-123` |

These defaults are local-only. In AWS the same accounts get generated passwords
from Secrets Manager.

Tear down with `docker compose down`, or `docker compose down -v` to discard the
database volume too.

### Native, for faster iteration

Needs Node 24 and Docker.

```powershell
docker compose up -d postgres          # database only

cd backend
npm install
npx prisma migrate deploy
npm run seed
npm run dev                            # :4000

cd ../frontend
npm install
npm run dev                            # :5173, proxies /api to :4000
```

### Tests

```powershell
cd backend  ; npm test        # 83 integration tests against a real Postgres
cd frontend ; npm test        # 7 tests, incl. the single-flight token refresh
```

Backend tests need the `webstore_test` database, which `scripts/postgres-init`
creates automatically the first time the Postgres volume is initialised.

They run against real Postgres rather than a mock on purpose: the things most
worth testing — the full-text triggers, the conditional stock decrement, the
partial unique index on active carts — only exist in the database.

### Try the interesting bits

- Search `coffee` — matches products by **category** even though none of them
  contain the word.
- Search `headphones -bluetooth` — negation works.
- Add items as a guest, then sign in — the guest cart **merges**, quantities
  summed and capped at stock.
- Check out with `4000 0000 0000 0002` — payment is declined, stock is returned,
  and your cart survives so you can retry.
- Test cards: `4242 4242 4242 4242` approves; any number ending in an even digit
  approves; odd declines.

---

## Deploying to AWS

### Prerequisites

- Terraform ≥ 1.10, AWS CLI v2, kubectl, Helm, Docker
- An AWS profile with permission to create VPC, EKS, RDS, IAM and Secrets
  Manager resources

```powershell
$env:AWS_PROFILE = "terraform"
aws sts get-caller-identity        # confirm before going further
```

### One-time setup

Enable the secret-scanning pre-commit hook (git does not share hooks, so this is
per clone):

```powershell
.\scripts\install-hooks.ps1
```

Bootstrap the persistent stack. It creates the bucket its own state later lives
in, so the first apply runs with a local backend and migrates afterwards:

```powershell
cd infra/persistent
terraform init -backend=false
terraform apply
terraform init -migrate-state `
  -backend-config="bucket=web-store-tfstate-$(aws sts get-caller-identity --query Account --output text)" `
  -backend-config="key=persistent/terraform.tfstate" `
  -backend-config="region=us-east-1" `
  -backend-config="encrypt=true" -backend-config="use_lockfile=true"
```

Then add the CI role ARN as a GitHub repository **variable** named
`AWS_ROLE_ARN` (Settings → Secrets and variables → Actions → Variables):

```powershell
terraform -chdir=infra/persistent output -raw github_actions_role_arn
```

A variable rather than a secret: the ARN grants nothing without a matching OIDC
token from this repository's `main` branch, and keeping it visible makes CI
failures far easier to debug.

### Daily cycle

```powershell
.\scripts\up.ps1        # ~20 minutes; prints the store URL when ready
.\scripts\down.ps1      # ~15 minutes; sweeps for anything still billable
```

`up.ps1` applies both stacks, installs the ALB controller and Secrets Store CSI
driver, builds and pushes images, deploys the chart, and waits for the load
balancer to answer. Useful flags: `-SkipInfra` to redeploy the app only,
`-SkipBuild` to reuse images already in ECR.

Sign-in passwords for a deployed environment come from Secrets Manager and are
deliberately never printed:

```powershell
aws secretsmanager get-secret-value --secret-id web-store/dev/app `
  --query SecretString --output text
```

### Cost

| State | Cost |
|---|---|
| Running | ~$0.19/hr — EKS control plane $0.10, two Spot nodes, RDS `t4g.micro`, ALB |
| Destroyed | ~$0.10/month — S3 state and ECR images only |

Deliberate savings: **no NAT gateway** (nodes sit in public subnets with no
inbound rules; the database stays fully private), **Spot** nodes, **single-AZ**
RDS, and **no KMS** customer-managed key.

Set `budget_notification_email` in `terraform.tfvars` to get alerted at 80%
actual and 100% forecast spend.

---

## How secrets work

Nothing sensitive is ever committed, printed, or placed in a manifest.

1. Terraform **generates** the database password, JWT signing keys and seed
   passwords, and writes them straight to Secrets Manager. They never pass
   through your terminal.
2. The **Secrets Store CSI driver** mounts each value as its own file on a
   tmpfs volume inside the pod.
3. The app reads them **from disk** via `SECRETS_DIR`. They are never
   environment variables, so they cannot appear in `kubectl describe pod`, in a
   child process environment, or in etcd — nothing is synced to a Kubernetes
   Secret.
4. Pods reach AWS through **IRSA**; there are no static credentials in the
   cluster. CI reaches AWS through **OIDC**; there are no static credentials in
   GitHub.

The database password is generated alphanumeric-only, because the migration Job
assembles a `DATABASE_URL` with shell interpolation where punctuation would need
percent-encoding.

**Terraform state contains those generated values in plaintext** — unavoidable
for any Terraform-managed secret. That is why state lives in S3 with encryption,
versioning, enforced TLS and all public access blocked, and why no state file is
kept on local disk.

A pre-commit hook blocks `.env` files, tfvars, tfstate, private keys,
kubeconfigs, AWS access keys, and hardcoded account ids in ARNs or ECR URIs.
CI runs **gitleaks** over the full history, because a local hook can be bypassed
with `--no-verify` and is per-clone.

---

## CI/CD

**`ci.yml`** — on every push and pull request. Lints, typechecks and tests both
apps against a real Postgres, builds all three images without pushing, renders
the chart and validates it with kubeconform, checks `terraform fmt` and
`validate`, and scans history with gitleaks. It has **no AWS access at all**, so
a pull request from a fork can never reach the cloud account.

**`deploy.yml`** — on push to `main`, or manually. Assumes the CI role via OIDC,
pushes images tagged with the commit SHA, then deploys. If no cluster is running
— the normal state overnight — it pushes the images and skips the deploy rather
than failing.

CI derives every name it needs (cluster, namespace, secret names, IRSA role ARN)
from the naming convention rather than reading Terraform state, so it never
needs access to a file holding the database password.

---

## Troubleshooting

**`Not authorized to perform sts:AssumeRoleWithWebIdentity`**

GitHub sends an **immutable** subject claim containing numeric ids:

```
repo:owner@8661324/web-store@1317833055:ref:refs/heads/main
```

not the name-only `repo:owner/repo:ref:...` that most documentation shows. A
`repo:owner/repo:*` wildcard does *not* fix it, because the `@id` segments sit
inside the parts being matched — which makes this look like anything but a
subject problem.

The workflow error carries no detail. **CloudTrail does**:

```powershell
aws cloudtrail lookup-events --region us-east-1 `
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity `
  --max-results 5
```

The `userIdentity.userName` field shows the exact subject presented. Go here
first; it turns an hour of guessing into one command.

**`terraform destroy` hangs, then fails on subnets**

The ALB and its security groups are created by the load balancer controller,
not by Terraform, so Terraform does not know they exist. Destroying the VPC
while they are still there strands network interfaces that block subnet
deletion. `down.ps1` handles this by uninstalling the release and polling AWS
until the ALB is really gone — note that the Ingress object can disappear while
the controller is still deleting the load balancer.

To recover manually:

```powershell
aws elbv2 describe-load-balancers --query "LoadBalancers[?contains(LoadBalancerName,'k8s-')]"
aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=<vpc-id> Name=status,Values=available
```

**`A secret with this name is scheduled for deletion`**

A deleted secret keeps its name reserved for 7–30 days by default, which breaks
a daily rebuild. Both secrets set `recovery_window_in_days = 0`. If you hit this
on a secret created another way:

```powershell
aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery
```

**Deploy failed and the pods never rolled**

The migration hook runs before the pods, so it is usually the explanation. The
workflow prints its logs on failure; locally:

```powershell
kubectl logs -n web-store -l app.kubernetes.io/component=migrate --tail=100
```

**Something is still costing money after teardown**

```powershell
.\scripts\check-orphans.ps1 -Region us-east-1
```

Read-only. Reports load balancers, orphaned ENIs and security groups, unattached
EBS volumes and EIPs, surviving log groups, RDS snapshots, and secrets pending
deletion.

---

## Known gaps

- **Email is not wired up.** Password reset works, but the token is surfaced in
  the API response outside production instead of being emailed. Real delivery
  needs SES with a verified domain.
- **No HTTPS.** Without a domain the ALB serves plain HTTP on its
  `*.elb.amazonaws.com` hostname, so `app.cookieSecure` stays `false`. Setting
  `ingress.certificateArn` and a domain enables TLS — and only then should
  `cookieSecure` be turned on, or browsers will silently drop the refresh cookie.
- **No stock reservation during checkout.** Overselling is prevented by a
  conditional decrement at order time, but items are not held while a customer
  fills in the form.
- **Rate limits are per-pod**, since they are in-process. A shared Redis store
  would be needed for a global limit.
- **`migration.seed` is `true` in the dev values**, so every deploy reseeds the
  catalogue and resets the demo passwords. Set it to `false` anywhere holding
  real data.

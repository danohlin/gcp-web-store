# web-store

A full-featured shopping cart and storefront, containerised and deployed to
GKE Autopilot. Payments are simulated — no real gateway, no real card is ever
charged.

The cloud environment is **ephemeral by design**: brought up in the morning,
destroyed at the end of the day, costing roughly **$1.20 for an eight-hour day**
and **~$0.10/month** while torn down.

---

## Stack

| Layer | Choice |
|---|---|
| Backend | Node 24, Express 5, Prisma, TypeScript |
| Frontend | React 19, Vite, TypeScript |
| Database | PostgreSQL 17 (Cloud SQL when deployed) |
| Payments | Mock gateway behind a `PaymentProvider` interface |
| Containers | Docker, multi-stage, non-root, read-only root filesystem |
| Orchestration | GKE Autopilot, Helm |
| Infrastructure | Terraform, split into persistent and ephemeral stacks |
| Secrets | Secret Manager via the GKE Secret Manager CSI component |
| CI/CD | GitHub Actions with Workload Identity Federation — no service account keys |

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
helm/web-store/   Chart: deployments, services, ingress, HPAs, migration hook
infra/
  persistent/     State bucket, Artifact Registry, Workload Identity Federation.
                  Applied once, never destroyed.
  ephemeral/      VPC, GKE, Cloud SQL, Secret Manager. Destroyed nightly.
scripts/          up / down / orphan sweep / hook installer
.github/workflows ci.yml (tests, no cloud access) and deploy.yml (build, deploy)
```

---

## Local development

Nothing here touches GCP. The application reads its configuration from files
under `SECRETS_DIR` if present and falls back to environment variables, so
compose supplies plain env vars and the deployed chart supplies mounted files —
the same code path either way.

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

These defaults are local-only, and the seed **refuses** to use them when
`NODE_ENV=production` — a failed secret mount stops the migration rather than
creating a real admin account with a password published in this file. Deployed
environments get generated passwords from Secret Manager.

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

## Deploying to GCP

### Prerequisites

- Terraform ≥ 1.10, gcloud CLI, kubectl, Helm, Docker
- `gke-gcloud-auth-plugin`, which kubectl shells out to for every GKE API call:

  ```powershell
  gcloud components install gke-gcloud-auth-plugin
  ```

  If that fails with *"Cannot use bundled Python installation to update Google
  Cloud CLI in non-interactive mode"*, point `CLOUDSDK_PYTHON` at a copy first:

  ```powershell
  $env:CLOUDSDK_PYTHON = (gcloud components copy-bundled-python | Select-Object -Last 1)
  gcloud components install gke-gcloud-auth-plugin --quiet
  ```

- A GCP project with billing linked, and permission to create VPC, GKE,
  Cloud SQL, IAM and Secret Manager resources

```powershell
gcloud auth login
gcloud auth application-default login
gcloud config set project <PROJECT_ID>
gcloud config get-value project        # confirm before going further
```

Enable the three APIs Terraform needs before it can enable the rest:

```powershell
gcloud services enable cloudresourcemanager.googleapis.com iam.googleapis.com serviceusage.googleapis.com
```

> **The project id is never committed.** It has no default in either Terraform
> root and is supplied through the gitignored `terraform.tfvars`, or by exporting
> `TF_VAR_project_id`. The scripts read it from your gcloud config. The project
> *number* is read from the `google_project` data source at plan time, so it
> never appears either. This repository is public; keep it that way.

### One-time setup

Enable the secret-scanning pre-commit hook (git does not share hooks, so this is
per clone):

```powershell
.\scripts\install-hooks.ps1
```

Put your project id in `infra/persistent/terraform.tfvars` and
`infra/ephemeral/terraform.tfvars` (both gitignored), or export
`TF_VAR_project_id`.

Bootstrap the persistent stack. It creates the bucket its own state later lives
in, so the first apply runs against local state and migrates afterwards.
`-backend=false` is **not** sufficient — it leaves no backend record and both
plan and apply then fail with "Backend initialization required". Use a throwaway
override instead; `*_override.tf` is gitignored for exactly this:

```powershell
cd infra/persistent
'terraform { backend "local" {} }' | Set-Content backend_override.tf
terraform init -reconfigure
terraform apply

$bucket = terraform output -raw state_bucket    # read it BEFORE deleting the override
Remove-Item backend_override.tf
terraform init -migrate-state -force-copy `
  -backend-config="bucket=$bucket" `
  -backend-config="prefix=persistent"
```

Once the override is gone, `terraform output` can no longer reach the state to
tell you the bucket name — hence reading it first.

Then add two GitHub repository **variables** (Settings → Secrets and variables →
Actions → Variables):

```powershell
terraform -chdir=infra/persistent output -raw workload_identity_provider
terraform -chdir=infra/persistent output -raw github_actions_service_account
```

as `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`. Variables rather
than secrets: neither grants anything without a matching OIDC token from this
repository's `main` branch, and keeping them visible makes CI failures far
easier to debug. They do embed the project number, which is why they live in
repository settings rather than in a committed file.

### Daily cycle

```powershell
.\scripts\up.ps1        # ~15 minutes; prints the store URL when ready
.\scripts\down.ps1      # ~10 minutes; sweeps for anything still billable
```

`up.ps1` applies both stacks, builds and pushes images, deploys the chart, and
waits for the load balancer to answer. Useful flags: `-SkipInfra` to redeploy the
app only, `-SkipBuild` to reuse images already in the registry.

There is no add-on installation stage. The Ingress controller is part of the GKE
control plane, and the Secret Manager CSI component is enabled by a field on the
cluster resource — so unlike the AWS predecessor this replaced, no third-party
Helm charts are installed into `kube-system` at all.

Sign-in passwords for a deployed environment come from Secret Manager and are
deliberately never printed:

```powershell
gcloud secrets versions access latest --secret=web-store-dev-seed-admin-password
```

### Cost

| State | Cost |
|---|---|
| Running | ~$0.15/hr — Autopilot cluster fee $0.10, pods on Spot, Cloud SQL `db-f1-micro`, external load balancer |
| Destroyed | ~$0.10/month — GCS state and container images only |

The cluster fee is often **$0** in practice: GKE gives each billing account
$74.40/month of free cluster management, enough to cover one Autopilot cluster.

Deliberate savings: **no Cloud NAT** (Artifact Registry, Secret Manager and
Cloud SQL are all reachable over Private Google Access), **Spot Pods**,
**single-zone** Cloud SQL on the smallest shared-core tier, **no backups**, and
workload logging trimmed to system components only.

Set `budget_notification_email` and `billing_account_id` in `terraform.tfvars` to
get alerted at 80% actual and 100% forecast spend. The budget needs
`roles/billing.costsManager` on the *billing account*, not the project — a higher
bar than everything else here, which is why it is opt-in.

---

## How secrets work

Nothing sensitive is ever committed, printed, or placed in a manifest.

1. Terraform **generates** the database password, JWT signing keys and seed
   passwords, and writes them straight to Secret Manager — one secret per value.
   They never pass through your terminal.
2. The **GKE Secret Manager CSI component** mounts each value as its own file on
   a tmpfs volume inside the pod.
3. The app reads them **from disk** via `SECRETS_DIR`. They are never
   environment variables, so they cannot appear in `kubectl describe pod`, in a
   child process environment, or in etcd — nothing is synced to a Kubernetes
   Secret, and this provider has no option to.
4. Pods authenticate through **Workload Identity Federation** as their own
   Kubernetes service account; there are no static credentials in the cluster,
   and no Google service account in the path. CI authenticates the same way and
   impersonates a service account with three permissions; there are no keys in
   GitHub.

Access is per-secret. The application service account can read all nine values;
the migration Job can read the seven it needs and not the JWT signing keys.

The database password is generated alphanumeric-only, because the migration Job
assembles a `DATABASE_URL` with shell interpolation where punctuation would need
percent-encoding.

**Terraform state contains those generated values in plaintext** — unavoidable
for any Terraform-managed secret. That is why state lives in a GCS bucket with
versioning, uniform bucket-level access and public access prevention enforced,
and why no state file is kept on local disk.

A pre-commit hook blocks `.env` files, tfvars, tfstate, private keys,
kubeconfigs, service account key JSON, API keys, OAuth tokens, and hardcoded
project ids, project numbers, registry URIs and billing account ids. CI runs
**gitleaks** and **TruffleHog** over the full history, because a local hook can
be bypassed with `--no-verify` and is per-clone.

---

## CI/CD

**`ci.yml`** — on every push and pull request. Lints, typechecks and tests both
apps against a real Postgres, builds all three images without pushing, renders
the chart and validates it with kubeconform, checks `terraform fmt` and
`validate`, and scans history with gitleaks. It has **no cloud access at all**,
so a pull request from a fork can never reach the project.

**`deploy.yml`** — on push to `main`, or manually. Authenticates via Workload
Identity Federation, pushes images tagged with the commit SHA, then deploys. If
no cluster is running — the normal state overnight — it pushes the images and
skips the deploy rather than failing.

**`version-audit.yml`** — weekly. Checks that the pins in this repository still
match reality: the Kubernetes version CI validates against versus what the
release channel serves, the Postgres major across Cloud SQL, CI and compose, the
Terraform provider and core versions, kubeconform, and the nginx base image. It
fails loudly if any of its extraction patterns stop matching, because an audit
that silently checks nothing is worse than no audit.

CI derives every name it needs (cluster, namespace, secret prefix, registry)
from the naming convention rather than reading Terraform state, so it never
needs access to a file holding the database password.

---

## Troubleshooting

**Workflow fails at the authentication step**

Check the two repository variables exist and are spelled exactly
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`. The provider value
is the full resource name, not the short id:

```
projects/<number>/locations/global/workloadIdentityPools/github/providers/github
```

If they are right and it still fails, the `attribute_condition` on the provider
is the next place to look — it pins the repository owner, the repository, and
the ref, so a run from any branch other than `main` is refused by design.

**Pods stuck in `ContainerCreating` with a CSI error**

The driver name is `secrets-store-gke.csi.k8s.io`, not the upstream
`secrets-store.csi.k8s.io`. The upstream Secrets Store CSI driver cannot run on
Autopilot at all — its DaemonSet needs privileged write-mode hostPath mounts,
which Autopilot forbids. If the driver name is right, check that the pod's
service account matches the namespace and name in the `principal://` binding in
`infra/ephemeral/secrets.tf`; a mismatch surfaces as `PermissionDenied` rather
than as a naming error.

**`terraform destroy` fails at the very end**

Almost always deletion protection. There are *two* separate flags on the
database — the provider-level `deletion_protection` and the API-level
`settings.deletion_protection_enabled` — plus one on the cluster, and the
provider-level ones default to **true**. All three are set false here; if you
have edited them, that is the first thing to check.

**Something is still costing money after teardown**

```powershell
.\scripts\check-orphans.ps1
```

Read-only. The load balancer is created by the Ingress controller, not by
Terraform, so `terraform destroy` does not remove it — and an orphaned global
forwarding rule keeps billing at roughly $0.025/hr with nothing pointing at it.
`down.ps1` avoids this by uninstalling the release and polling until the load
balancer is really gone before destroying anything; note that the Ingress object
can disappear while the controller is still deleting it.

The sweep reports forwarding rules, proxies, URL maps, backend services, health
checks, NEGs, GKE firewall rules, unattached addresses in both scopes, clusters,
Cloud SQL instances and backups, unattached disks, Cloud NAT, networks and
leftover secrets.

**Deploy failed and the pods never rolled**

The migration hook runs before the pods, so it is usually the explanation. The
workflow prints its logs on failure; locally:

```powershell
kubectl logs -n web-store -l app.kubernetes.io/component=migrate --tail=100
```

If it timed out rather than errored, note that `activeDeadlineSeconds` counts
from Job creation and Autopilot has to provision capacity for the hook Job
first — one to three minutes on a cold cluster.

---

## Known gaps

- **Email is not wired up.** Password reset works, but the token is surfaced in
  the API response outside production instead of being emailed. Real delivery
  needs an email provider with a verified sender domain.
- **No HTTPS.** Without a domain the load balancer serves plain HTTP on its raw
  IP, so `app.cookieSecure` stays `false`. Setting `ingress.managedCertificateName`
  and a domain enables TLS — and only then should `cookieSecure` be turned on, or
  browsers will silently drop the refresh cookie.
- **Ingress, not Gateway API.** Google now leads with Gateway API for new work.
  Ingress was the smaller, lower-risk port and every Gateway advantage —
  multiple certificates, traffic splitting, header matching — needs a domain
  first. Worth revisiting at the same time as TLS.
- **No stock reservation during checkout.** Overselling is prevented by a
  conditional decrement at order time, but items are not held while a customer
  fills in the form.
- **Rate limits are per-pod**, since they are in-process. A shared Redis store
  would be needed for a global limit.
- **`migration.seed` is `true` in the dev values**, so every deploy reseeds the
  catalogue and resets the demo passwords. Set it to `false` anywhere holding
  real data.

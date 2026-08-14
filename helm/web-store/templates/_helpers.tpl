{{/* Base name, overridable. */}}
{{- define "web-store.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "web-store.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "web-store.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels applied to every object. */}}
{{- define "web-store.labels" -}}
helm.sh/chart: {{ include "web-store.chart" . }}
app.kubernetes.io/name: {{ include "web-store.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: web-store
{{- end -}}

{{/* Selector labels for a given component; must stay stable across upgrades. */}}
{{- define "web-store.selectorLabels" -}}
app.kubernetes.io/name: {{ include "web-store.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "web-store.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "web-store.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "web-store.secretProviderClassName" -}}
{{- printf "%s-secrets" (include "web-store.fullname" .) -}}
{{- end -}}

{{/*
The filenames mounted under SECRETS_DIR, as a JSON array.

This list is a contract with three consumers and must not drift from any of
them:
  backend/src/config/index.ts   reads DB_* and JWT_*
  templates/migration.yaml      cats DB_* and SEED_* in shell
  infra/ephemeral/secrets.tf    creates one Secret Manager secret per entry

The secret id is derived from each name by lowercasing and swapping
underscores for hyphens, so DB_PASSWORD becomes <prefix>-db-password.
*/}}
{{- define "web-store.appSecretNames" -}}
["DB_USER","DB_PASSWORD","DB_HOST","DB_PORT","DB_NAME","JWT_ACCESS_SECRET","JWT_REFRESH_SECRET","SEED_ADMIN_PASSWORD","SEED_CUSTOMER_PASSWORD"]
{{- end -}}

{{/*
The subset the migration hook needs: enough to build a DATABASE_URL and seed
accounts. It has no business reading the JWT signing keys, and Terraform grants
it access to these seven only.
*/}}
{{- define "web-store.migrateSecretNames" -}}
["DB_USER","DB_PASSWORD","DB_HOST","DB_PORT","DB_NAME","SEED_ADMIN_PASSWORD","SEED_CUSTOMER_PASSWORD"]
{{- end -}}

{{/*
Fully-qualified image reference. CI overrides `tag` with an immutable digest or
a commit SHA; `latest` is deliberately not a default, because a mutable tag
makes rollbacks meaningless.
*/}}
{{- define "web-store.image" -}}
{{- $repo := .repository -}}
{{- $tag := .tag | default "" -}}
{{- if not $repo -}}
{{- fail "image.repository must be set (the Artifact Registry image URI)" -}}
{{- end -}}
{{- if not $tag -}}
{{- fail "image.tag must be set; refusing to deploy a floating tag" -}}
{{- end -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}

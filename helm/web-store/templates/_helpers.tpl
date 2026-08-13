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
Fully-qualified image reference. CI overrides `tag` with an immutable digest or
a commit SHA; `latest` is deliberately not a default, because a mutable tag
makes rollbacks meaningless.
*/}}
{{- define "web-store.image" -}}
{{- $repo := .repository -}}
{{- $tag := .tag | default "" -}}
{{- if not $repo -}}
{{- fail "image.repository must be set (the ECR repository URI)" -}}
{{- end -}}
{{- if not $tag -}}
{{- fail "image.tag must be set; refusing to deploy a floating tag" -}}
{{- end -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}

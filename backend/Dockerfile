# syntax=docker/dockerfile:1.7

# Two runtime targets share every base layer:
#   * `runtime`  — the API. The Prisma CLI and its engine downloads are removed
#                  after client generation, which is safe because the generated
#                  client carries its own copy of the query engine.
#   * `migrator` — keeps the CLI so `prisma migrate deploy` can run. Used by the
#                  compose migrate job and the Helm pre-upgrade hook.
# Because the layers are shared, a node that already has one pulls very little
# of the other.

# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------
# Debian slim rather than Alpine: Prisma's engines link against OpenSSL and
# glibc, and the musl builds are a recurring source of "engine not found".
FROM node:24-slim AS base
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# A placeholder is enough: `prisma generate` resolves env("DATABASE_URL") to
# validate the datasource block, but nothing connects at build time.
ENV PRISMA_BUILD_URL="postgresql://build:build@127.0.0.1:5432/build"

# ---------------------------------------------------------------------------
# Dependencies (production only) — shared by both runtime targets
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY prisma ./prisma
RUN DATABASE_URL="$PRISMA_BUILD_URL" npx prisma generate

# ---------------------------------------------------------------------------
# Build — TypeScript needs the dev dependencies
# ---------------------------------------------------------------------------
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY prisma ./prisma
RUN DATABASE_URL="$PRISMA_BUILD_URL" npx prisma generate

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime — the API
# ---------------------------------------------------------------------------
FROM prod-deps AS runtime

# The generated client under node_modules/.prisma bundles the query engine it
# needs, so the CLI and the full engine download can go. This is the difference
# between a ~440MB and a ~800MB image.
RUN rm -rf \
      node_modules/prisma \
      node_modules/@prisma/engines \
      node_modules/@prisma/engines-version \
      node_modules/.bin/prisma

COPY --from=build /app/dist ./dist

# node:24-slim ships an unprivileged `node` user (uid 1000).
USER node
EXPOSE 4000

# Node runs as PID 1. That is safe because server.ts installs explicit SIGTERM
# and SIGINT handlers; without them PID 1 would ignore both and every rollout
# would stall until the grace period expired.
CMD ["node", "dist/server.js"]

# ---------------------------------------------------------------------------
# Migrator — schema migrations and seeding
# ---------------------------------------------------------------------------
FROM prod-deps AS migrator

# Seeding runs the compiled seed, so no TypeScript toolchain is needed here.
COPY --from=build /app/dist ./dist

USER node

CMD ["npx", "prisma", "migrate", "deploy"]

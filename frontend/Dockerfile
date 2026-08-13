# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
# nginx-unprivileged runs as a non-root user and listens on 8080, so the pod
# needs no capabilities and the container filesystem can stay read-only.
FROM nginxinc/nginx-unprivileged:1.31-alpine AS runtime

# Rendered by the image's entrypoint, which substitutes only variables that are
# actually set in the environment — so nginx's own $uri and $host survive.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Not a template: it contains no variables, and it is included from several
# places to work around nginx's add_header inheritance rule.
COPY security-headers.conf /etc/nginx/security-headers.conf

COPY --from=build /app/dist /usr/share/nginx/html

# Always defined, so the template can never render an empty proxy_pass and
# fail nginx's config check at startup.
ENV BACKEND_ORIGIN=http://backend:4000

# Opt in to the image's own resolver detection. Its 15-local-resolvers.envsh
# returns immediately unless this is set, which would leave the literal string
# ${NGINX_LOCAL_RESOLVERS} in the rendered config and stop nginx from starting.
# With it enabled the nameserver is read from /etc/resolv.conf at boot, so the
# same image works under Docker's embedded DNS and under kube-dns.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

EXPOSE 8080

STOPSIGNAL SIGQUIT

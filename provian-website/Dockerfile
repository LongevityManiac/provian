# syntax=docker/dockerfile:1
# Build context: the repo root (NOT provian-website/).
# Set a NEW Basic-Auth password (F42: BuildKit secret mount — the plaintext is available only
# inside the RUN, never expanded into a layer or the image history):
#   DOCKER_BUILDKIT=1 DASHBOARD_PASSWORD=<pw> docker build -f provian-website/Dockerfile \
#     --secret id=dashboard_pw,env=DASHBOARD_PASSWORD -t provian-website .
# Or inherit the current private gate (only the bcrypt HASH) from a prior image:
#   docker build -f provian-website/Dockerfile \
#     --build-arg HTPASSWD_SOURCE_IMAGE=<image-digest> -t provian-website .
# The repo-root .dockerignore narrows the context to provian-website/ only.
#
# Review-open switch (default off): --build-arg REVIEW_OPEN=on serves the store-review open set
# (review-open.json) without the password; everything else stays walled. Exactly "on" or "off";
# any other value fails the build. scripts/deploy-site.sh --review-open sets it for a deploy.
#
# F42: the plaintext preview password must NEVER be passed as a --build-arg consumed in a RUN —
# Docker records build-arg values referenced by a RUN in the layer history (docker history
# --no-trunc), leaking the plaintext to anyone who can pull the image. Only the one-way bcrypt
# hash (in the inherited /etc/nginx/.htpasswd, or produced from the secret mount here) may enter
# the image.

ARG HTPASSWD_SOURCE_IMAGE=us-central1-docker.pkg.dev/provian-ai/cloud-run-source-deploy/provian-site@sha256:a49093f357e72cd58f470cb77d1427790b2d11a2676fc3140ea91625d1f96540
FROM ${HTPASSWD_SOURCE_IMAGE} AS auth_source

FROM node:20-alpine AS builder
WORKDIR /app

COPY provian-website/package.json provian-website/package-lock.json ./
RUN npm ci

COPY provian-website/ ./
RUN npm run build

# The store-review open set, resolved against this export and written as the nginx maps
# nginx.conf includes. Resolved in both modes (a broken list fails the build either way);
# the maps carry entries only with REVIEW_OPEN=on. (Declared here, after the export, so the
# switch never invalidates the cached build above it.)
ARG REVIEW_OPEN=off
RUN node scripts/review-open.mjs out /app/review-open "$REVIEW_OPEN"

# Tripwire (OPEN_ITEMS.md finding #3, 2026-07-06): the internal tracker
# (OPEN_ITEMS.md / MEMORY.md) must never be compiled into a client-served
# asset. If its canary ever lands in the static export, a build pipeline is
# leaking internal content into a public bundle — fail the image build rather
# than ship it. Mirrors the CI canary guard in .github/workflows/typecheck.yml.
RUN if grep -rIl 'PROVIAN-CANARY-OI-7c19' out >/dev/null 2>&1; then \
      echo 'ERROR: OPEN_ITEMS canary found in the static export (out/) — internal tracker content leaked into a client-served asset. Aborting build.' >&2; \
      exit 1; \
    fi

FROM nginx:alpine

COPY --from=auth_source /etc/nginx/.htpasswd /tmp/inherited.htpasswd
# F42: the password arrives via a BuildKit secret mount (id=dashboard_pw), readable ONLY inside
# this RUN at /run/secrets/dashboard_pw and never persisted to a layer or the image history. If
# no password secret is provided, inherit the existing bcrypt hash from the source image.
RUN --mount=type=secret,id=dashboard_pw \
    if [ -s /run/secrets/dashboard_pw ]; then \
      apk add --no-cache apache2-utils && \
      htpasswd -bcB /etc/nginx/.htpasswd provian "$(cat /run/secrets/dashboard_pw)" && \
      apk del apache2-utils; \
    elif [ -s /tmp/inherited.htpasswd ]; then \
      cp /tmp/inherited.htpasswd /etc/nginx/.htpasswd; \
    else \
      echo "ERROR: provide the dashboard_pw build secret or HTPASSWD_SOURCE_IMAGE with /etc/nginx/.htpasswd" >&2; exit 1; \
    fi && \
    rm -f /tmp/inherited.htpasswd

COPY provian-website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/review-open/ /etc/nginx/review-open/

COPY --from=builder /app/out/ /usr/share/nginx/html/
# Everything served is world-readable: a source file checked out under a restrictive umask
# (0600) would otherwise reach the image as-is, and nginx's worker answers 403 for it
# (the MCP Registry domain proof did, 2026-10-07). Git records only 644/755, so this
# changes nothing for a clean checkout.
RUN chmod -R a+rX /usr/share/nginx/html && nginx -t

EXPOSE 8080

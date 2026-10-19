# syntax=docker/dockerfile:1
#
# Fishtape API and worker image. Build from the repo root, because the server reads files from
# the PWA: the shared JSON Schemas (electrical-app/js/schema/) and the product name
# (electrical-app/js/brand.js):
#
#   docker build -f server/Dockerfile --build-arg GIT_SHA="$(git rev-parse HEAD)" -t fishtape.invalid/server:dev .
#
# One image runs both processes: the API (default CMD) and the worker (`node src/worker.js`);
# `npm run migrate` and `npm run seed` run as one-off containers. Nothing secret is baked in:
# configuration arrives at runtime through the environment (deploy/<env>/.env.example).
#
# Node 22.12 or newer is required (cookie 2.x via @fastify/cookie). Debian trixie slim (glibc):
# @node-rs/argon2 installs a prebuilt N-API binary for linux-x64-gnu, so no compiler is needed.
# Dependabot (docker ecosystem) keeps the tag and digest current. Keep both FROM lines equal.

FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3410 \
    SCHEMA_DIR=/app/electrical-app/js/schema/ \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_CACHE=/tmp/.npm
WORKDIR /app/server

# Code is owned by root and read-only to the runtime user. Same layout as the repo, so the
# server's relative paths (../electrical-app/js/...) resolve exactly as in development.
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/ ./
COPY electrical-app/js/schema/ /app/electrical-app/js/schema/
COPY electrical-app/js/brand.js /app/electrical-app/js/brand.js

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.title="fishtape-server" \
      org.opencontainers.image.source="https://github.com/Kwald90/kelbeplugin" \
      org.opencontainers.image.revision="${GIT_SHA}"

# The official image's unprivileged user (uid 1000).
USER node
EXPOSE 3410

# Liveness only (process up). Readiness (/api/readyz) is checked by deploy/*/update.sh.
# The worker serves no HTTP, so docker-compose.yml disables this check for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3410)+'/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "src/index.js"]

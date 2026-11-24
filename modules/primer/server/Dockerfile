# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# The self-hosted Primer (primer_mode: self-host): Primer's own image recipe (apps/api/Dockerfile) built from its source at a
# pinned commit, plus start.ts, which turns AidenHQ's gate key and vault files into Primer's proxy sign-in settings.
# PRIMER_SHA: the commit of github.com/maxsam4/primer (the collaboration stack, 0xPolygon/primer#162-#184, plus proxy sign-in) this
# product runs. Bump it here; the Primer source enforces its own dependency age (14 days) and frozen lockfile.
ARG PRIMER_SHA=9d1f369f3f668e7ac57e344d3b6f0366af123506

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
ARG PRIMER_SHA
ADD --keep-git-dir=false https://github.com/maxsam4/primer.git#${PRIMER_SHA} /src
WORKDIR /src
RUN corepack enable
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @polygonlabs/primer-api-types --filter @primer/web --filter @primer/api run build
RUN pnpm --filter @primer/api deploy --prod --legacy /out/api \
 && rm -rf /out/api/src /out/api/scripts /out/api/container-tests /out/api/*.test.* /out/api/vitest*.ts \
 && mkdir -p /out/web && cp -r apps/web/dist /out/web/dist

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
# Primer runs on node alone: the bundled npm (with published advisories) is deleted.
RUN rm -rf /usr/local/lib/node_modules/npm

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# Debian sid, not bookworm: Debian 12 has no fix for pam CVE-2025-6020 or zlib CVE-2026-85091, and Debian 13's node image
# still carries zlib CVE-2026-85091 (fixed in 13, not yet in the image: image-scan fails it). Node and npm come from the node
# stage above, as services/computer/images/browser does; this base has no `node` account, so it is re-created.
COPY --from=node /usr/local /usr/local
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home --shell /bin/bash node
ENV NODE_ENV=production SERVE_STATIC=1 STATIC_ROOT=/app/web/dist PORT=3000 STORAGE_BACKEND=filesystem STORAGE_ROOT=/data/blobs
WORKDIR /app
COPY --from=build --chown=root:root /out/api /app/api
COPY --from=build --chown=root:root /out/web /app/web
COPY start.ts /app/start.ts
USER 1000:1000
EXPOSE 3000
WORKDIR /app/api
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "/app/start.ts"]

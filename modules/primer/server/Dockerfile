# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# The self-hosted Primer (primer_mode: self-host): Primer's own image recipe (apps/api/Dockerfile) built from its source at a
# pinned commit, plus start.mjs, which turns AidenHQ's gate key and vault files into Primer's proxy sign-in settings.
# PRIMER_SHA: the commit of github.com/maxsam4/primer (the collaboration stack, 0xPolygon/primer#162-#182, plus proxy sign-in) this
# product runs. Bump it here; the Primer source enforces its own dependency age (14 days) and frozen lockfile.
ARG PRIMER_SHA=4dc290ce51cf72ab820dde48743a1afdecad6e44

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

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
# Primer runs on node alone: the bundled npm (with published advisories) is deleted.
RUN rm -rf /usr/local/lib/node_modules/npm
ENV NODE_ENV=production SERVE_STATIC=1 STATIC_ROOT=/app/web/dist PORT=3000 STORAGE_BACKEND=filesystem STORAGE_ROOT=/data/blobs
WORKDIR /app
COPY --from=build --chown=root:root /out/api /app/api
COPY --from=build --chown=root:root /out/web /app/web
COPY start.mjs /app/start.mjs
USER 1000:1000
EXPOSE 3000
WORKDIR /app/api
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "/app/start.mjs"]

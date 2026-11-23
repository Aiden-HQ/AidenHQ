# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# The GitHub process (spec 2026-11-20-github-owner-identity §1): github-mcp (built here) and the code host (service/, Node's own
# modules and git) in one image and one Node process, on the owner's one sign-in. The tree mirrors the module's, so the code host
# imports github-mcp's built entry by its relative path.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app/connections/github-mcp
COPY connections/github-mcp/package.json connections/github-mcp/package-lock.json ./
RUN npm ci --ignore-scripts
COPY connections/github-mcp/tsconfig.json connections/github-mcp/tsconfig.build.json ./
COPY connections/github-mcp/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
# Node 24.22.3 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads.
RUN npm install -g npm@11.21.2 && npm cache clean --force

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# Debian sid, not bookworm: Debian 12 has no fix for pam CVE-2025-6020 or zlib CVE-2026-85091, and Debian 13's node image
# still carries zlib CVE-2026-85091 (fixed in 13, not yet in the image: image-scan fails it). Node and npm come from the node
# stage above, as services/computer/images/browser does; this base has no `node` account, so it is re-created.
COPY --from=node /usr/local /usr/local
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home --shell /bin/bash node
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
      libgssapi-krb5-2 libk5crypto3 libkrb5-3 libkrb5support0 \
      && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libkrb5-3)" ge 1.22.3-1 \
      && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/connections/github-mcp/node_modules ./connections/github-mcp/node_modules
COPY --from=build /app/connections/github-mcp/dist ./connections/github-mcp/dist
COPY connections/github-mcp/package.json ./connections/github-mcp/
COPY service/src ./service/src
# The sign-in's token lives in the vault dir mounted at /state (official.ts); the cache clones and held writes in /cache.
USER 1000:1000
EXPOSE 8086 8087 8100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "service/src/main.ts"]

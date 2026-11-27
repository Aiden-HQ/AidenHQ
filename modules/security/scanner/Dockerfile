# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# Pinned scanner (tag and digest): grype matches the host's SBOMs (ops/security-sbom.sh runs the matching syft).
FROM anchore/grype:v0.121.3@sha256:13113eeceab017260370cf540e1d25442c59665fd07d1b09b66d63bb0c282887 AS grype

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
COPY --from=oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build && rm -rf node_modules && bun install --frozen-lockfile --ignore-scripts --production

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
RUN npm install -g npm@11.21.2 && npm cache clean --force

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# Debian sid, not bookworm: Debian 12 has no fix for pam CVE-2025-6020 or zlib CVE-2026-85091, and Debian 13's node image
# still carries zlib CVE-2026-85091 (fixed in 13, not yet in the image: image-scan fails it). Node and npm come from the node
# stage above, as services/computer/images/browser does; this base has no `node` account, so it is re-created.
COPY --from=node /usr/local /usr/local
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home --shell /bin/bash node
ENV NODE_ENV=production
# grype is a Go binary: it needs the system CA bundle to fetch its vulnerability database.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=grype /grype /usr/local/bin/grype
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# /cache: grype's database (a named volume, so it survives restarts and isn't held in tmpfs).
RUN mkdir -p /cache/grype-db /cache/tmp && chown -R 1000:100 /cache
USER 1000:1000
CMD ["node", "dist/src/main.js"]

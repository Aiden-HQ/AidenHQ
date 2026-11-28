# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
COPY --from=oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
# Native modules load their bundled prebuilds (better-sqlite3's N-API binaries), so the install runs no build scripts.
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build && rm -rf node_modules && bun install --frozen-lockfile --ignore-scripts --production

FROM docker:29.10.0-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker

# The compose plugin docker:29.10.0-cli ships is compose v5.7.1, whose x/net v0.60.0 fixes the HTTP/2 advisories older
# tags carried (GO-2026-6612/6603/6611/6617) but still carries GO-2026-6860, and whose klauspost/compress v1.20.0 carries
# GO-2026-6865. It is built here from compose v5.7.1 with two pins above its own (go.mod, go.sum next to this file), so
# the binary carries x/net v0.62.0 and compress v1.20.2.
FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS compose
WORKDIR /src
COPY compose-plugin/go.mod compose-plugin/go.sum ./
RUN CGO_ENABLED=0 go mod download
RUN CGO_ENABLED=0 go build -trimpath -tags e2e \
      -ldflags "-w -X github.com/docker/compose/v5/internal.Version=v5.7.1" \
      -o /usr/local/bin/docker-compose github.com/docker/compose/v5/cmd

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
ENV NODE_ENV=production HOME=/tmp
# The krb5 packages are named so apt upgrades them from the base image's 1.22.1-3 to sid's 1.22.3-1.
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
      libgssapi-krb5-2 libk5crypto3 libkrb5-3 libkrb5support0 \
      && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libkrb5-3)" ge 1.22.3-1 \
      && rm -rf /var/lib/apt/lists/*
# Static Go binaries: the docker CLI with its compose plugin. No tailscale CLI: apps are served by their own tailnet node
# (the apps-edge sidecar), from a config file this service writes.
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=compose /usr/local/bin/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.status<600?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/src/main.js"]

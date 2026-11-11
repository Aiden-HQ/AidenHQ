# syntax=docker/dockerfile:1
# Pinned scanner (tag and digest): grype matches the host's SBOMs (ops/security-sbom.sh runs the matching syft).
FROM anchore/grype:v0.121.3@sha256:13113eeceab017260370cf540e1d25442c59665fd07d1b09b66d63bb0c282887 AS grype

FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production
# grype is a Go binary: it needs the system CA bundle to fetch its vulnerability database.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@11.21.2 && npm cache clean --force
COPY --from=grype /grype /usr/local/bin/grype
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# /cache: grype's database (a named volume, so it survives restarts and isn't held in tmpfs).
RUN mkdir -p /cache/grype-db /cache/tmp && chown -R 1000:100 /cache
USER 1000:1000
CMD ["node", "dist/src/main.js"]

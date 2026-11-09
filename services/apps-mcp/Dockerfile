# syntax=docker/dockerfile:1
FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 has no prebuilt binary for every Node release; build tools let it compile.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM docker:29-cli AS docker

FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production HOME=/tmp
# Node 24.22.2 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads.
RUN npm install -g npm@11.21.2 && npm cache clean --force
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
# Static Go binaries: the docker CLI with its compose plugin. No tailscale CLI: apps are served by their own tailnet node
# (the apps-edge sidecar), from a config file this service writes.
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.status<600?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/src/main.js"]

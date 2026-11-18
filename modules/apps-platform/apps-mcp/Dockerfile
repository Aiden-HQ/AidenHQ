# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 has no prebuilt binary for every Node release; build tools let it compile.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM docker:29.9.2-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
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

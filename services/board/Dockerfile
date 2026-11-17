# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
# Node 24.22.2 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads.
RUN npm install -g npm@11.21.2 && npm cache clean --force
# pdftotext: attached PDFs get a text version the agents can read. git: the Handbook tab's history of the mounted instance repo
# (src/agent-handbook.ts; it reads with safe.directory set, as the mount's owner isn't the board's user).
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Bucket/rank state lives in /data/board (mounted).
USER 1000:1000
EXPOSE 3121
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3121/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/main.js"]

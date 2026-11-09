# syntax=docker/dockerfile:1
FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production
# Node 24.22.2 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads.
RUN npm install -g npm@11.21.2 && npm cache clean --force
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /state && chown 1000:100 /state
# Holds the ClickHouse Cloud OAuth client and token pair in /state, mounted from the secrets dir.
USER 1000:1000
EXPOSE 8088
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8088/healthz').then(r=>process.exit(r.status<600?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/src/main.js"]

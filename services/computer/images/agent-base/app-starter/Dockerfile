# Two stages on the same base: build the React app with the locked dev tooling, then run only server.mjs, the modules it imports and dist/ (the
# server has no runtime dependencies, so the image carries no node_modules).
# node 24.22.3 bookworm-slim, pinned by digest (the same base the agent computers use).
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
ENV NODE_ENV=production
# Node 24.22.3 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads. The app's
# one-off commands run as `npm run <script>` in this image, so npm stays.
RUN npm install -g npm@11.21.2 && npm cache clean --force
COPY --from=build /app/server.mjs /app/aidenhq-identity.mjs ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

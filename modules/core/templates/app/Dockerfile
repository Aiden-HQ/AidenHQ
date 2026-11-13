# Two stages on the same base: build the React app with the locked dev tooling, then run only server.mjs and dist/ (the
# server has no runtime dependencies, so the image carries no node_modules).
# node 24.22.2 bookworm-slim, pinned by digest (the same base the agent computers use).
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
ENV NODE_ENV=production
# Node 24.22.2 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads. The app's
# one-off commands run as `npm run <script>` in this image, so npm stays.
RUN npm install -g npm@11.21.2 && npm cache clean --force
COPY --from=build /app/server.mjs ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

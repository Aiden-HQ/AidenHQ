# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# The gate: no dependencies beyond Node itself.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
# The gate runs `node main.ts` (Node strips the types: no build step) and needs neither npm nor corepack, and the base
# image's npm 11.19.1 bundles undici 6.28.0 and brace-expansion 5.0.9, which carry published advisories: drop them from
# the runtime image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY package.json gate.ts main.ts ./
USER node
CMD ["node", "main.ts"]

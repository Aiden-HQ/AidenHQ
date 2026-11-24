# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# The gate: no dependencies beyond Node itself.

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
# The gate runs `node main.ts` (Node strips the types: no build step) and needs neither npm nor corepack, and the base
# image's npm 11.19.1 bundles undici 6.28.0 and brace-expansion 5.0.9, which carry published advisories: drop them from
# the runtime image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# Debian sid, not bookworm: Debian 12 has no fix for pam CVE-2025-6020 or zlib CVE-2026-85091, and Debian 13's node image
# still carries zlib CVE-2026-85091 (fixed in 13, not yet in the image: image-scan fails it). Node and npm come from the node
# stage above, as services/computer/images/browser does; this base has no `node` account, so it is re-created.
COPY --from=node /usr/local /usr/local
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home --shell /bin/bash node
ENV NODE_ENV=production
WORKDIR /app
COPY package.json config-reader.ts gate.ts main.ts signin-pages.ts test-listener.ts ./
USER node
CMD ["node", "main.ts"]

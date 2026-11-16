# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# The gate: no dependencies beyond Node itself.
# Node's own binary, on Debian sid rather than bookworm: bookworm carries no fix for its pam, zlib1g, util-linux and glibc
# rows, and trixie as published still ships the unfixed zlib1g (1:1.3.dfsg+really1.3.1-1+b1). sid has pam 1.7.0-8,
# zlib1g 1:1.3.dfsg+really1.3.2-4, util-linux 2.42.4-1 and glibc 2.43, and is the base the browser image already runs.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS node
FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# Only the binary, never /usr/local/lib/node_modules: that image's npm 11.19.1 bundles undici 6.28.0 and
# brace-expansion 5.0.9, which carry published advisories, and the gate runs `node main.ts` (Node strips the types: no
# build step) and needs neither npm nor corepack.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production
WORKDIR /app
COPY package.json gate.ts main.ts ./
USER 1000:1000
CMD ["node", "main.ts"]

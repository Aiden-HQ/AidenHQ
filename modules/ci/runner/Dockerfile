# The CI runner: the official Actions runner image (pinned below) without what our jobs never run and what carries
# known vulnerabilities (image-scan, 2026-11-14):
#   - externals/node20*: Node 20 is end of life; its 20.20.2 has CVE-2026-111497 (critical, in CISA's KEV catalogue) and
#     no fixed 20.x will ship. Every action our workflows pin (checkout, setup-node) runs on node24.
#   - node24's bundled npm, npx and corepack: actions run `node` directly (undici, brace-expansion advisories).
#   - the Docker engine, containerd, runc and buildx: the runner gets no Docker socket (golang.org/x/net and others).
# Still flagged: Microsoft.AspNetCore.WebUtilities 8.0.25 in the runner's own Runner.Worker (GHSA-x33c-w48q-qrgc): fixed
# only by an actions/runner release that ships 8.0.34+; 2.338.2 is the newest as of 2026-11-14.
# Node for the jobs, in setup-node's tool cache (<cache>/node/<version>/x64 plus x64.complete): `node-version: 24.x`
# resolves to it without a download (setup-node took 9-16 s a job). node 24.22.2 (pushed 2026-11-05); its npm 11.19.1
# bundles vulnerable undici and brace-expansion, so npm 11.21.2 (2026-11-04), which image-scan finds clean.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS node
RUN npm install -g npm@11.21.2 --no-audit --no-fund

FROM ghcr.io/actions/actions-runner:2.338.2@sha256:6d0b2d80d80f143f77dcb676e50920100bbb547e39e883454d57f45ab8c31300
USER root
RUN rm -rf /home/runner/externals/node20 /home/runner/externals/node20_alpine \
      /home/runner/externals/node24/lib/node_modules /home/runner/externals/node24/bin/npm \
      /home/runner/externals/node24/bin/npx /home/runner/externals/node24/bin/corepack \
      /usr/bin/containerd /usr/bin/containerd-shim-runc-v2 /usr/bin/ctr /usr/bin/docker /usr/bin/docker-init \
      /usr/bin/docker-proxy /usr/bin/dockerd /usr/bin/runc /usr/local/lib/docker
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache
COPY --from=node /usr/local/bin/node /opt/hostedtoolcache/node/24.22.2/x64/bin/node
COPY --from=node /usr/local/lib/node_modules /opt/hostedtoolcache/node/24.22.2/x64/lib/node_modules
COPY --from=node /usr/local/include/node /opt/hostedtoolcache/node/24.22.2/x64/include/node
RUN cd /opt/hostedtoolcache/node/24.22.2/x64/bin \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js npx \
 && touch /opt/hostedtoolcache/node/24.22.2/x64.complete
USER runner

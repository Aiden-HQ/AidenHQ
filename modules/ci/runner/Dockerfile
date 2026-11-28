# The CI runner: the official Actions runner image (pinned below) without what our jobs never run and what carries
# known vulnerabilities (image-scan, 2026-11-14):
#   - externals/node20*: Node 20 is end of life; its 20.20.2 has CVE-2026-111497 (critical, in CISA's KEV catalogue) and
#     no fixed 20.x will ship. Every action our workflows pin (checkout, setup-node) runs on node24.
#   - node24's bundled npm, npx and corepack: actions run `node` directly (undici, brace-expansion advisories).
#   - the Docker engine, containerd, runc and buildx: the runner gets no Docker socket (golang.org/x/net and others).
# Still flagged: Microsoft.AspNetCore.WebUtilities 8.0.25 in the runner's own Runner.Worker (GHSA-x33c-w48q-qrgc): fixed
# only by an actions/runner release that ships 8.0.34+; 2.338.2 is the newest as of 2026-11-14 (an expiring entry in
# .github/image-scan-exceptions.yaml). image-scan scans the base as published: each path the RUN rm below deletes is an
# entry there too, conditioned on this rm naming it, so keep it one `rm -rf` with every path as an argument.
# Node for the jobs, in setup-node's tool cache (<cache>/node/<version>/x64 plus x64.complete): `node-version: 24.x`
# resolves to it without a download (setup-node took 9-16 s a job). node 24.22.3 (pushed 2026-11-11); its npm 11.19.1
# bundles vulnerable undici and brace-expansion, so npm 11.21.2 (2026-11-04), which image-scan finds clean (the exact
# `npm install -g npm@<version>` form, no other flag or argument, is what its exception accepts).
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
RUN npm install -g npm@11.21.2

FROM ghcr.io/actions/actions-runner:2.338.2@sha256:6d0b2d80d80f143f77dcb676e50920100bbb547e39e883454d57f45ab8c31300
USER root
# iproute2: the product's kernel runs `ip` (kernel/src/sandbox.ts hostIPv4, hostRoutes), which its unit tests reach (the base
# image has none). Noble's versions, with the three libraries it adds (apt-get install -s, 2026-11-18); apt keeps only the
# current version, so a bump of any of them is a deliberate edit here. libc6 and libc-bin are upgraded from the base's
# 2.39-0ubuntu8.9 (medium CVEs, fixed in 8.12).
RUN apt-get update \
 && apt-get install -y --no-install-recommends iproute2=6.1.0-1ubuntu6.4 libbpf1=1:1.3.0-2build2 libmnl0=1.0.5-2build1 libxtables12=1.8.10-3ubuntu2 libc6=2.39-0ubuntu8.12 libc-bin=2.39-0ubuntu8.12 \
 && rm -rf /var/lib/apt/lists/*
RUN rm -rf /home/runner/externals/node20 /home/runner/externals/node20_alpine \
      /home/runner/externals/node24/lib/node_modules /home/runner/externals/node24/bin/npm \
      /home/runner/externals/node24/bin/npx /home/runner/externals/node24/bin/corepack /home/runner/externals/node24/bin/node \
      /usr/bin/containerd /usr/bin/containerd-shim-runc-v2 /usr/bin/ctr /usr/bin/docker /usr/bin/docker-init \
      /usr/bin/docker-proxy /usr/bin/dockerd /usr/bin/runc /usr/local/lib/docker
# The runner's own node24 (24.22.1 in 2.338.2, high CVEs fixed in 24.22.3; 2.338.2 is the newest runner release): deleted
# above and replaced by the digest-pinned 24.22.3 binary, the one the tool cache gets below.
COPY --from=node /usr/local/bin/node /home/runner/externals/node24/bin/node
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache
COPY --from=node /usr/local/bin/node /opt/hostedtoolcache/node/24.22.3/x64/bin/node
COPY --from=node /usr/local/lib/node_modules /opt/hostedtoolcache/node/24.22.3/x64/lib/node_modules
COPY --from=node /usr/local/include/node /opt/hostedtoolcache/node/24.22.3/x64/include/node
# grype for the image-scan check, which scans each image's directory and base images without building (no Docker here):
# the security module's pin (modules/security/scanner/Dockerfile), a static binary.
COPY --from=anchore/grype:v0.122.1@sha256:661583704a253c0448ed63998b5ea2cd9d5a76ee71eedc4aed439b8ce3e93a1c /grype /usr/local/bin/grype
RUN cd /opt/hostedtoolcache/node/24.22.3/x64/bin \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js npx \
 && touch /opt/hostedtoolcache/node/24.22.3/x64.complete \
 && chown -R runner:runner /opt/hostedtoolcache
# The job-started hook (job-started.sh, .ts): refuses untrusted jobs (fork PRs, other repos) before any step runs.
# Root-owned and read-only, outside every checkout. /opt/aidenhq/allowed is the runner's to write once, in the entrypoint
# (module.yaml), which then makes it read-only.
COPY --chown=root:root --chmod=0555 job-started.sh /opt/aidenhq/job-started.sh
COPY --chown=root:root --chmod=0444 job-started.ts /opt/aidenhq/job-started.ts
RUN install -o runner -g runner -m 0644 /dev/null /opt/aidenhq/allowed
ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/aidenhq/job-started.sh
# The runner owns the tool cache: setup-node for a version not baked in here downloads it and caches it for this job
# (root-owned, every such job failed with EACCES: roadmap-keeper's code-review on 22.x, 2026-11-14).
USER runner

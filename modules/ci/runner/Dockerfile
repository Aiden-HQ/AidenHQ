# The CI runner: the official Actions runner image (pinned below) without what our jobs never run and what carries
# known vulnerabilities (image-scan, 2026-11-14):
#   - externals/node20*: Node 20 is end of life; its 20.20.2 has CVE-2026-111497 (critical, in CISA's KEV catalogue) and
#     no fixed 20.x will ship. Every action our workflows pin (checkout, setup-node) runs on node24.
#   - node24's bundled npm, npx and corepack: actions run `node` directly (undici, brace-expansion advisories).
#   - the Docker engine, containerd, runc and buildx: the runner gets no Docker socket (golang.org/x/net and others).
# Still flagged: Microsoft.AspNetCore.WebUtilities 8.0.25 in the runner's own Runner.Worker (GHSA-x33c-w48q-qrgc): fixed
# only by an actions/runner release that ships 8.0.34+; 2.338.2 is the newest as of 2026-11-14.
FROM ghcr.io/actions/actions-runner:2.338.2@sha256:6d0b2d80d80f143f77dcb676e50920100bbb547e39e883454d57f45ab8c31300
USER root
RUN rm -rf /home/runner/externals/node20 /home/runner/externals/node20_alpine \
      /home/runner/externals/node24/lib/node_modules /home/runner/externals/node24/bin/npm \
      /home/runner/externals/node24/bin/npx /home/runner/externals/node24/bin/corepack \
      /usr/bin/containerd /usr/bin/containerd-shim-runc-v2 /usr/bin/ctr /usr/bin/docker /usr/bin/docker-init \
      /usr/bin/docker-proxy /usr/bin/dockerd /usr/bin/runc /usr/local/lib/docker
USER runner

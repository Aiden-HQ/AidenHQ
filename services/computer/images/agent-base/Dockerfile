# An agent's computer: the base every computer image builds FROM. Runs under gVisor, one container per run, started
# by the host launcher (services/computer/launcher.mjs). No logins, keys or tokens are ever baked in or mounted.
# node: Paperclip's sandbox runner needs sh, node, nohup. Codex pinned to the paperclip image's (0.166.0); agent-browser pinned to
# the release the spike proved, with its Chrome baked in.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS node
# Node 24.22.2 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads.
RUN npm install -g npm@11.21.2

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep ffmpeg python3 python3-venv procps less unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local /usr/local
RUN npm i -g @openai/codex@0.166.0 agent-browser@0.41.2 && npm cache clean --force
RUN agent-browser install --with-deps && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
# repo-checkout: a commit of an agents-org repo, placed by the launcher (services/computer/launcher.mjs POST /repo); no credentials.
COPY --chmod=755 repo-checkout /usr/local/bin/repo-checkout
# ui-review: screenshots, axe (embedded in agent-browser), web vitals and layout checks for a running app; the design system
# (synced from modules/core/design-system by scripts/sync-shared.mjs) as the review reference; the app starter (synced from
# modules/core/templates/app: shadcn/ui on Vite + React) to scaffold new apps and mockups from, and to serve /catalog.
COPY --chmod=755 ui-review /usr/local/bin/ui-review
COPY design-system /opt/aidenhq/design-system
COPY app-starter /opt/aidenhq/app-starter
# The starter's dependencies, installed once from its lockfile (exact pins, nothing new), so a mockup or a review's
# `cp -r /opt/aidenhq/app-starter …` carries node_modules and can build at once, with no download.
RUN cd /opt/aidenhq/app-starter && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force

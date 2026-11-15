# An agent's computer: the base every computer image builds FROM. Runs under gVisor, one container per run, started
# by the host launcher (services/computer/launcher.mjs). No logins, keys or tokens are ever baked in or mounted.
# BASE is the browser image's tag (ops/computer-images.sh): Node, agent-browser and its pinned Chrome (services/computer/images/browser).
# node: Paperclip's sandbox runner needs sh, node, nohup. Codex pinned to the paperclip image's (0.166.0).
ARG BASE=aidenhq/computer-browser
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      git jq ripgrep ffmpeg python3 python3-venv procps less \
    && rm -rf /var/lib/apt/lists/*
RUN npm i -g @openai/codex@0.166.0 && npm cache clean --force
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

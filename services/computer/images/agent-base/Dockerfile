# An agent's computer: the base every computer image builds FROM. Runs under gVisor, one container per run, started
# by the host launcher (services/computer/launcher.ts). No logins, keys or tokens are ever baked in or mounted.
# BASE is the browser image's tag (ops/computer-images.sh): Node, agent-browser and its pinned Chrome (services/computer/images/browser).
# node: Paperclip's sandbox runner needs sh, node, nohup. Codex pinned to the paperclip image's (0.166.0).
ARG BASE=aidenhq/computer-browser
FROM ${BASE}
# file, binutils (strings, readelf) and sqlite3: the commands Engineer jobs reached for most and didn't find (job logs,
# 2026-11-16: file 42 times, strings 11, sqlite3 4).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git jq ripgrep ffmpeg python3 python3-venv procps less file binutils sqlite3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm i -g @openai/codex@0.166.0 && npm cache clean --force
# apply_patch as a command: Codex takes `apply_patch <<EOF` as its patch tool only when it is the whole command, so an edit
# chained with a build (`… EOF` then `&& npm test`) failed with "command not found". The pinned Codex binary runs the same
# patch tool when called by that name (arg0), so this adds no dependency; the build checks it applies a patch.
RUN ln -s "$(find "$(npm root -g)/@openai/codex" -path '*/vendor/*/bin/codex' -type f | head -n1)" /usr/local/bin/apply_patch \
    && cd /tmp && printf 'a\n' > p.txt && printf '*** Begin Patch\n*** Update File: p.txt\n@@\n-a\n+b\n*** End Patch\n' | apply_patch >/dev/null \
    && grep -qx b p.txt && rm p.txt
# Codex runs each command in a login shell, and /etc/profile resets PATH, dropping the job's /opt/aidenhq/bin (`aidenhq`,
# `aidenhq-browse`) and cargo: put them back for login shells.
RUN echo 'case ":$PATH:" in *:/opt/aidenhq/bin:*) ;; *) PATH="/opt/aidenhq/bin:/opt/rust/cargo/bin:$PATH" ;; esac' > /etc/profile.d/aidenhq-path.sh
WORKDIR /workspace
# repo-checkout is not in the image: the launcher mounts it (lib.ts jobMounts) only into a job box whose agent holds the role.
# ui-review: screenshots, axe (embedded in agent-browser), web vitals and layout checks for a running app; the design system
# (synced from modules/apps-platform/design-system by scripts/sync-shared.ts) as the review reference; the app starter (synced from
# modules/apps-platform/starter: shadcn/ui on Vite + React) to scaffold new apps and mockups from, and to serve /catalog.
COPY --chmod=755 ui-review /usr/local/bin/ui-review
COPY ui-review-copy.json /usr/local/bin/ui-review-copy.json
COPY design-system /opt/aidenhq/design-system
COPY app-starter /opt/aidenhq/app-starter
# The starter's dependencies, installed once from its lockfile (exact pins, nothing new), so a mockup or a review's
# `cp -r /opt/aidenhq/app-starter …` carries node_modules and can build at once, with no download.
# Its Playwright Test (`npm run screens`) drives the image's pinned Chrome (AGENT_BROWSER_EXECUTABLE_PATH): no browser
# download, ever. The build checks that it launches.
RUN cd /opt/aidenhq/app-starter && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force \
    && node -e 'require("@playwright/test").chromium.launch({ executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH }).then((b) => b.close())'

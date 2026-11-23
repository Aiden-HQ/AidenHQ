# An agent's computer: the base every computer image builds FROM. Runs under gVisor, one container per run, started
# by the host launcher (services/computer/launcher.ts). No logins, keys or tokens are ever baked in or mounted.
# BASE is the browser image's tag (ops/computer-images.sh): Node, agent-browser and its pinned Chrome (services/computer/images/browser).
# node: Paperclip's sandbox runner needs sh, node, nohup. Codex pinned to the paperclip image's (0.166.0).
ARG BASE=aidenhq/computer-browser
FROM ${BASE}
# file, binutils (strings, readelf) and sqlite3: the commands Engineer jobs reached for most and didn't find (job logs,
# 2026-11-16: file 42 times, strings 11, sqlite3 4).
# krb5 1.22.3-1 fixes seven high GSS-API/RPC CVEs (CVE-2026-107778, -112314, -112320, -112321, -112322, -112323, -119079).
# The browser base already carries 1.22.1-3, and naming an installed package is what upgrades it, so all four the image
# carries are named: libkrb5-3 asks for libk5crypto3 >= 1.20, not 1.22.3, so it does not come up through the others. The
# build then fails rather than ship a stale mirror's copy.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git jq ripgrep ffmpeg python3 python3-venv procps less file binutils sqlite3 \
      libkrb5-3 libgssapi-krb5-2 libkrb5support0 libk5crypto3 \
    && for p in libkrb5-3 libgssapi-krb5-2 libkrb5support0 libk5crypto3; do \
         v="$(dpkg-query -W -f='${Version}' "$p")" && dpkg --compare-versions "${v:-0}" ge 1.22.3-1 \
           || { echo "krb5: $p is ${v:-not installed}, need >= 1.22.3-1" >&2; exit 1; }; \
       done \
    && rm -rf /var/lib/apt/lists/*
RUN npm i -g @openai/codex@0.166.0 && npm cache clean --force
# Code review's other engines (modules/code-review/recipe/engines.ts): Claude Code 2.1.323 (published 2026-11-12) and codegenie
# 0.7.0 (2026-09-25), each at least 7 days old, with every dependency resolved as of 2026-11-13 (--before), so none is newer
# either. Claude Code's postinstall copies its native binary into place; it is run explicitly (npm may skip install scripts).
# codegenie 0.7.0 pins zod 4.6.5, whose `$ZodArray` keeps one issue per failing element with no cap, so a large unconstrained
# array in a request body exhausts memory (GHSA-mrhx-c7xc-m3w5). The newer codegenie that moves the pin is under 7 days old,
# and the fix is in zod 4.6.6, so zod 4.6.7 (the 4.6.x the 7-day rule picks) replaces codegenie's own copy. It comes from a
# checked-in lockfile (codegenie-zod/) that ships into both computer images and is installed with `npm ci`, because npm
# re-resolves codegenie's own directory as a root project and fails on its dev tree, so installing in place won't do.
COPY codegenie-zod /opt/codegenie-zod
RUN npm i -g --before=2026-11-13 @anthropic-ai/claude-code@2.1.323 @0xsequence/codegenie@0.7.0 && npm cache clean --force \
    && (cd "$(npm root -g)/@anthropic-ai/claude-code" && node install.cjs) \
    && claude --version | grep -q '^2\.1\.323 ' && codegenie --version | grep -q '^codegenie v0\.7\.0 ' \
    && (cd /opt/codegenie-zod && npm ci --no-audit --no-fund \
        && cd "$(npm root -g)/@0xsequence/codegenie/node_modules" && rm -rf zod \
        && mv /opt/codegenie-zod/node_modules/zod zod \
        && node -p 'JSON.parse(require("fs").readFileSync("zod/package.json","utf8")).version' | grep -qx 4.6.7)
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

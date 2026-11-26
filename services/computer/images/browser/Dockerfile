# The one browser image: agent-browser and its pinned Chrome, nothing else. apps-mcp renders app_view, web_view, the grader's
# view and the post-deploy render check in a fresh, hardened container of it; agent-base (every agent computer) builds FROM it.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
# Node 24.22.3 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads.
RUN npm install -g npm@11.21.2

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# Every computer image builds FROM this one and inherits the label, as do the release's prebuilt ones. The image prunes
# (ops/units/prune-docker.service, ops/apply-config-work.sh) skip it: an idle install runs no box, so no container uses
# these images, and pruning them leaves every job "Queued" until an apply rebuilds them.
LABEL aidenhq.keep=true
# Chrome's libraries and fonts: the list `agent-browser install --with-deps` installs, without its unpinned Chrome download.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
      libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
      libgtk-3-0t64 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0t64 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 \
      libxrender1 libasound2t64 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 libatk-bridge2.0-0t64 \
      libdrm2 libxkbcommon0 libatspi2.0-0t64 libcups2t64 libxshmfence1 libgbm1 fonts-liberation fonts-noto-color-emoji \
      fonts-noto-cjk fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*
# krb5 1.22.3-1 fixes seven high GSS-API/RPC CVEs (CVE-2026-107778, -112314, -112320, -112321, -112322, -112323, -119079).
# The sid base carries 1.22.1-3, and naming an installed package is what upgrades it, so all four are named; the build
# then fails rather than ship a stale mirror's copy. agent-base and engineer name the same four in their own apt steps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libkrb5-3 libgssapi-krb5-2 libkrb5support0 libk5crypto3 \
    && for p in libkrb5-3 libgssapi-krb5-2 libkrb5support0 libk5crypto3; do \
         v="$(dpkg-query -W -f='${Version}' "$p")" && dpkg --compare-versions "${v:-0}" ge 1.22.3-1 \
           || { echo "krb5: $p is ${v:-not installed}, need >= 1.22.3-1" >&2; exit 1; }; \
       done \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local /usr/local
RUN npm i -g agent-browser@0.41.2 && npm cache clean --force
# Chrome for Testing 157.0.8103.78 (2026-11-11, critical CVE fixes; supply-chain exception), checksummed, readable by every uid. ops/vm/setup.sh installs the same build
# on the host for Engineer jobs: move both together.
RUN case "$(dpkg --print-architecture)" in \
      amd64) cft=linux64 sum=9223832977a13db3646201b1341c1f9cf08afa3ceae92540116d7b0c062364fb ;; \
      arm64) cft=linux-arm64 sum=f354d666822a11d8fe99e923c44be77dd226fab2750c5b5947e6318818bf10f1 ;; \
    esac \
    && curl -fsSLo /tmp/chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.78/$cft/chrome-$cft.zip" \
    && echo "$sum  /tmp/chrome.zip" | sha256sum -c - \
    && unzip -q /tmp/chrome.zip -d /tmp && mv "/tmp/chrome-$cft" /opt/chrome && rm /tmp/chrome.zip \
    && chmod -R a+rX /opt/chrome && /opt/chrome/chrome --version
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/chrome/chrome
# Also for login shells: an agent's harness may start its shell without the image's environment (Codex runs `bash -lc`),
# and agent-browser then finds no Chrome and downloads its own (194 MB, every UI review run since 2026-11-15).
RUN echo 'export AGENT_BROWSER_EXECUTABLE_PATH=/opt/chrome/chrome' > /etc/profile.d/agent-browser.sh

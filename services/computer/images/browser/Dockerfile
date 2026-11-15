# The one browser image: agent-browser and its pinned Chrome, nothing else. apps-mcp renders app_view, web_view, the grader's
# view and the post-deploy render check in a fresh, hardened container of it; agent-base (every agent computer) builds FROM it.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS node
# Node 24.22.2 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads.
RUN npm install -g npm@11.21.2

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# Chrome's libraries and fonts: the list `agent-browser install --with-deps` installs, without its unpinned Chrome download.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
      libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
      libgtk-3-0t64 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0t64 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 \
      libxrender1 libasound2t64 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 libatk-bridge2.0-0t64 \
      libdrm2 libxkbcommon0 libatspi2.0-0t64 libcups2t64 libxshmfence1 libgbm1 fonts-liberation fonts-noto-color-emoji \
      fonts-noto-cjk fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local /usr/local
RUN npm i -g agent-browser@0.41.2 && npm cache clean --force
# Chrome for Testing 157.0.8103.50 (2026-11-07), checksummed, readable by every uid. ops/vm/setup.sh installs the same build
# on the host for Engineer jobs: move both together.
RUN curl -fsSLo /tmp/chrome.zip https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/linux64/chrome-linux64.zip \
    && echo "d17167bc092eb495a3b768c7467f27e35f625aa03834233a1663af67dcb668c9  /tmp/chrome.zip" | sha256sum -c - \
    && unzip -q /tmp/chrome.zip -d /tmp && mv /tmp/chrome-linux64 /opt/chrome && rm /tmp/chrome.zip \
    && chmod -R a+rX /opt/chrome && /opt/chrome/chrome --version
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/chrome/chrome

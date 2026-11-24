# A session's computer: the engineer image plus opencode, tmux and ttyd. ONE standing container of it holds many sessions
# (services/computer/standing.ts): each lease runs its own opencode server in its own process group, and a terminal (ttyd on
# tmux) the board proxies. BASE is the engineer tag (ops/computer-images.sh).
ARG BASE=aidenhq/computer-engineer
FROM ${BASE}
# opencode 1.19.6 (npm opencode-ai, published 2026-11-17). Exact, so the box never moves under a running session; nothing
# self-updates (autoupdate false in the config the engine writes) and nothing is fetched at run time.
RUN npm i -g opencode-ai@1.19.6 && npm cache clean --force && opencode --version | grep -qx 1.19.6
# tmux 3.8-1 (Debian sid, 2026-10-09) and ttyd 1.7.7-8 (sid, 2026-10-04): the session's terminal. Exact: a sid that has moved on
# fails this build loudly (bump both here), it never installs another version.
RUN apt-get update && apt-get install -y --no-install-recommends tmux=3.8-1 ttyd=1.7.7-8 \
    && rm -rf /var/lib/apt/lists/* && tmux -V | grep -q 3.8 && ttyd --version | grep -q 1.7.7
# opencode with no network (checked on 1.19.6 under `docker run --network none`): the server starts and answers
# GET /session/status in under a second, and a session runs a model call against an OpenAI-compatible provider named by
# OPENCODE_CONFIG without fetching anything: @ai-sdk/openai-compatible is bundled, so no provider package is installed here.
# What holds, for engine-opencode: OPENCODE_CONFIG is the config file, XDG_DATA_HOME holds the session database, and
# OPENCODE_CONFIG_DIR is the folder of agents and skills. Not fetched at run time: the model list (OPENCODE_DISABLE_MODELS_FETCH)
# and updates (OPENCODE_DISABLE_AUTOUPDATE).
ENV OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1
# Plugins: exactly plugins.json, with their whole dependency tree pinned by package-lock.json (every version at least 7 days old).
# All three are the engine-opencode module's, copied here by scripts/sync-shared.ts. `npm ci` installs the lock once into
# /opt/opencode, with no install scripts, readable by every uid; plugins.json stays there for the engine's config builder.
COPY package.json package-lock.json plugins.json /opt/opencode/
RUN npm ci --prefix /opt/opencode --ignore-scripts --no-audit --no-fund && chmod -R a+rX /opt/opencode && npm cache clean --force
# `session-stop <lease>`: how the launcher ends one session in the shared box (see the script).
COPY --chmod=755 session-stop /opt/aidenhq/bin/session-stop
# Git and gh in the shell (lane G): the credential helper and a `gh` wrapper, first on PATH (/opt/aidenhq/bin precedes the real gh),
# and the system gitconfig that points git at the helper.
# The real gh (/usr/bin/gh, what the wrapper below runs): 2.105.0, the checksummed release .deb ops/vm/setup.sh installs on the host.
RUN case "$(dpkg --print-architecture)" in \
      amd64) sum=1dac939af3e84fb3861927c984b357531341be9403b889e4aa86e8822145a09d ;; \
      arm64) sum=d17e9b089ce0356679c9fa1898f3a7d38dccf943d529acaa94c24e8a4584e0ae ;; \
    esac \
    && curl -fsSLo /tmp/gh.deb "https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_linux_$(dpkg --print-architecture).deb" \
    && echo "$sum  /tmp/gh.deb" | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/gh.deb && rm -f /tmp/gh.deb && rm -rf /var/lib/apt/lists/* \
    && /usr/bin/gh --version | grep -q 2.105.0
COPY --chmod=755 git-credential-aidenhq gh /opt/aidenhq/bin/
COPY gitconfig /etc/gitconfig

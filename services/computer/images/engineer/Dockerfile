# An engineer's computer: the base plus toolchains. Pushes and merges are the runner's, against an approval; GitHub reads are
# the github connection's tools. BASE is the agent-base tag (ops/computer-images.sh).
# Usable by any uid: a runner job's box (the Engineer) runs as the runner's uid, not root, so every toolchain lives outside
# /root and each tool's caches go under the job's writable HOME.
ARG BASE=aidenhq/computer-agent-base
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev python3-pip python3-dev golang-go make gnupg openssh-client \
    && rm -rf /var/lib/apt/lists/*
# krb5 1.22.3-1 (2026-11-11, security release): the browser and agent-base layers carry 1.22.1-3 from when they were built,
# and their tags don't change when only this directory does, so a fresh engineer build would otherwise keep it. sid has the
# fix; --only-upgrade moves just these four packages, and the assertions fail the build if the archive stops carrying it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade libgssapi-krb5-2 libk5crypto3 libkrb5-3 libkrb5support0 \
    && rm -rf /var/lib/apt/lists/* \
    && for p in libgssapi-krb5-2 libk5crypto3 libkrb5-3 libkrb5support0; do \
         dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$p")" ge 1.22.3-1 \
           || { echo "$p is $(dpkg-query -W -f='${Version}' "$p"), below 1.22.3-1" >&2; exit 1; }; \
       done
# rustup-init 1.29.3 (archived 2026-11-03; per-arch sha256 from the .sha256 files beside each binary), checksummed; it installs the pinned toolchain into /opt/rust (readable by all). At run
# time RUSTUP_HOME stays there; CARGO_HOME is unset, so cargo's registry and builds go under the user's own HOME.
ENV RUSTUP_HOME=/opt/rust/rustup
RUN case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64-unknown-linux-gnu sum=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55 ;; \
      arm64) triple=aarch64-unknown-linux-gnu sum=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282 ;; \
    esac \
    && curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/1.29.3/$triple/rustup-init" \
    && echo "$sum  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init && CARGO_HOME=/opt/rust/cargo /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.91.0 && rm /tmp/rustup-init \
    && chmod -R a+rX /opt/rust && /opt/rust/cargo/bin/rustc --version
ENV PATH=/opt/rust/cargo/bin:$PATH
# gitleaks 8.30.1 (released 2026-03-21, the version the product's CI runs): a check job's secret scan (kernel/src/checkjobs.ts).
# Built from the module at that tag with the image's Go, not from its release binary: those are cut with go1.24.11 and carry
# brotli 1.1.2-pre (CVE-2026-111497, in CISA's KEV catalogue), x/crypto 0.35.0, x/text 0.22.0 and klauspost/compress 1.17.11,
# and there is no newer release. gitleaks/go.mod beside this file lifts those four (and the lower-severity rardecode, xz and
# x/sys) to their fixed versions. GOTOOLCHAIN=local and the module's `go 1.26.11` floor make a base whose Go is older fail the
# build instead of fetching another toolchain, and the download and build caches are dropped after it. The smoke test keeps the behaviour the
# check jobs rely on: non-zero on a finding, zero on a clean tree.
COPY gitleaks/go.mod gitleaks/go.sum /opt/gitleaks/
RUN cd /opt/gitleaks \
    && GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=readonly GOPATH=/opt/gitleaks/cache GOCACHE=/opt/gitleaks/cache/build go mod download all \
    && GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=readonly GOPATH=/opt/gitleaks/cache GOCACHE=/opt/gitleaks/cache/build go build -trimpath \
         -ldflags "-s -w -X=github.com/zricethezav/gitleaks/v8/version.Version=8.30.1" \
         -o /usr/local/bin/gitleaks github.com/zricethezav/gitleaks/v8 \
    && chmod -R u+w /opt/gitleaks/cache && rm -rf /opt/gitleaks/cache && chmod 0755 /usr/local/bin/gitleaks \
    && go version -m /usr/local/bin/gitleaks | grep -Eq '^\s+dep\s+github\.com/andybalholm/brotli\s+v1\.(2\.7|[3-9])' \
    && go version -m /usr/local/bin/gitleaks | grep -Eq '^\s+dep\s+github\.com/klauspost/compress\s+v1\.20\.[2-9]' \
    && go version -m /usr/local/bin/gitleaks | grep -Eq '^\s+dep\s+golang\.org/x/crypto\s+v0\.(5[6-9]|[6-9][0-9])' \
    && go version -m /usr/local/bin/gitleaks | grep -Eq '^\s+dep\s+golang\.org/x/text\s+v0\.(4[1-9]|[5-9][0-9])' \
    && gitleaks version | grep -qx 8.30.1 \
    && mkdir -p /tmp/gl-smoke/leak /tmp/gl-smoke/clean \
    && printf 'aws_access_key_id = AKIA3%s\n' EXAMPLE7K2Q4WNZ > /tmp/gl-smoke/leak/credentials \
    && printf 'a note, no secrets\n' > /tmp/gl-smoke/clean/notes.txt \
    && ! gitleaks dir /tmp/gl-smoke/leak --no-banner --redact --exit-code 1 >/dev/null 2>&1 \
    && gitleaks dir /tmp/gl-smoke/clean --no-banner --redact --exit-code 1 \
    && rm -rf /tmp/gl-smoke
# Global npm installs land in /usr/local (the node image's prefix), readable by all.
# pnpm 10.34.9 (2026-10-25): its vendored tree carries tar 7.5.22 (GHSA-23hp-3jrh-7fpw fixed in 7.5.19), glob 10.5.0,
# picomatch 4.0.7, brace-expansion 2.1.7, minimatch 9.0.9 and ip-address 10.7.4 (the 14 highs 10.20.0 had).
RUN npm i -g pnpm@10.34.9 typescript@5.9.3 && npm cache clean --force
# The `aidenhq` commands of a kernel job (bin/aidenhq: calls to the kernel with the job's own token), and the job's wrappers
# first on its PATH (/opt/aidenhq/bin): a read-only gh, a capped sleep and aidenhq-browse (screenshots of the app it builds).
COPY --chmod=755 bin/aidenhq /usr/local/bin/aidenhq
COPY --chmod=755 bin/sleep bin/aidenhq-browse /opt/aidenhq/bin/
# An Engineer's review of its own change before it publishes: the code-review check's engine and brief (synced from modules/code-review/recipe by
# scripts/sync-shared.ts), run as `node /opt/aidenhq/code-review/self-review.ts <base-branch> <branch>` (skill publish).
COPY code-review/ /opt/aidenhq/code-review/

# ---- Code review tools (modules/code-review/service/src/catalog.json: every `tool` option's binary; recipe/tools.ts runs them) ----
# Each is pinned (versions published on or before 2026-11-14, so 7+ days old) and checksummed (release downloads: sha256 per
# architecture from the GitHub release's own digests), or resolved as of that date (npm --before, uv --exclude-newer, the Go
# module proxy with its checksum database). gitleaks is the one above. Nothing is downloaded when a review runs, except the
# vulnerability database govulncheck reads (data, not code).
# uv 0.13.8 builds the Python tools' venv, then stays only as a build step's tool.
RUN case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64-unknown-linux-gnu sum=5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91 ;; \
      arm64) triple=aarch64-unknown-linux-gnu sum=74f2f5c6024d397481db228db8fc25eed420db192243f88438c118e7e013e585 ;; \
    esac \
    && curl -fsSLo /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/0.13.8/uv-$triple.tar.gz" \
    && echo "$sum  /tmp/uv.tgz" | sha256sum -c - \
    && mkdir /tmp/uv && tar -xzf /tmp/uv.tgz -C /tmp/uv --strip-components=1 \
    && UV_CACHE_DIR=/tmp/uv-cache /tmp/uv/uv venv --python /usr/bin/python3 /opt/review-py \
    && UV_CACHE_DIR=/tmp/uv-cache /tmp/uv/uv pip install --python=/opt/review-py/bin/python --exclude-newer=2026-11-14T23:59:59Z vulture==2.16 ruff==0.17.5 \
    && ln -s /opt/review-py/bin/vulture /opt/review-py/bin/ruff /usr/local/bin/ \
    && rm -rf /tmp/uv /tmp/uv.tgz /tmp/uv-cache && chmod -R a+rX /opt/review-py \
    && vulture --version | grep -qx 'vulture 2.16' && ruff --version | grep -qx 'ruff 0.17.5'
RUN npm i -g --before=2026-11-14 knip@6.45.1 fallow@3.43.0 && npm cache clean --force \
    && knip --version | grep -q 6.45.1 && fallow --version | grep -q 3.43.0
# govulncheck v1.9.0 (2026-10-11), built with the image's Go from the module proxy (go.sum and the checksum database verify it).
RUN GOTOOLCHAIN=local CGO_ENABLED=0 GOBIN=/usr/local/bin GOPATH=/tmp/gopath GOCACHE=/tmp/gocache go install golang.org/x/vuln/cmd/govulncheck@v1.9.0 \
    && chmod -R u+w /tmp/gopath && rm -rf /tmp/gopath /tmp/gocache && govulncheck -version | grep -q v1.9.0
# squawk 2.72.0: a release binary.
# scc 4.1.0 (2026-09-07; modules/code-review/service/src/catalog.json maint.scc): a review's complexity pass. Built from the module at
# that tag with the image's Go, not from its release binary: those are cut with go1.27.0 and carry x/net 0.56.0 (critical
# GO-2026-6612, highs GO-2026-6603/6610/6611/6617/6860), x/crypto 0.53.0 and x/text 0.39.0, and there is no newer release.
# scc/go.mod beside this file lifts them to x/net 0.62.0, x/crypto 0.58.0 and x/text 0.43.0 (the floors x/net 0.62.0
# requires), and its `go 1.27.4` floor with GOTOOLCHAIN=local makes a base whose Go is older fail the build instead of
# fetching another toolchain. The download and build caches are dropped after it. The smoke test keeps the JSON shape the
# review's scc adapter reads.
COPY scc/go.mod scc/go.sum /opt/scc/
RUN cd /opt/scc \
    && GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=readonly GOPATH=/opt/scc/cache GOCACHE=/opt/scc/cache/build go mod download all \
    && GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=readonly GOPATH=/opt/scc/cache GOCACHE=/opt/scc/cache/build go build -trimpath \
         -ldflags "-s -w" -o /usr/local/bin/scc github.com/boyter/scc/v4 \
    && chmod -R u+w /opt/scc/cache && rm -rf /opt/scc/cache && chmod 0755 /usr/local/bin/scc \
    && go version /usr/local/bin/scc | grep -Eq 'go1\.(27\.([4-9]|[1-9][0-9])|[2-9][0-9]\.)' \
    && go version -m /usr/local/bin/scc | grep -Eq '^\s+dep\s+golang\.org/x/net\s+v0\.(6[2-9]|[7-9][0-9])' \
    && go version -m /usr/local/bin/scc | grep -Eq '^\s+dep\s+golang\.org/x/crypto\s+v0\.(5[6-9]|[6-9][0-9])' \
    && go version -m /usr/local/bin/scc | grep -Eq '^\s+dep\s+golang\.org/x/text\s+v0\.(4[1-9]|[5-9][0-9])' \
    && scc --version | grep -qx 'scc version 4.1.0' \
    && mkdir -p /tmp/scc-smoke && printf 'package main\n\nfunc main() {}\n' > /tmp/scc-smoke/main.go \
    && scc --by-file -f json --no-cocomo /tmp/scc-smoke | python3 -c 'import json, sys; d = json.load(sys.stdin); assert isinstance(d, list) and d and d[0]["Files"]' \
    && rm -rf /tmp/scc-smoke
RUN case "$(dpkg --print-architecture)" in \
      amd64) a=a61661808119a82515565503111099b070c869f73698f61cb1785de5d0c8b11a file=squawk-linux-x64 ;; \
      arm64) a=bcb529c1344512de5ce70695d89e7b1ae58738f73c05187a5f56cbf079417cf2 file=squawk-linux-arm64 ;; \
    esac \
    && curl -fsSLo /usr/local/bin/squawk "https://github.com/sbdchd/squawk/releases/download/v2.72.0/$file" && echo "$a  /usr/local/bin/squawk" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/squawk && squawk --version | grep -q 2.72.0
# ---- end of the code review tools ----
# Code review options, lane R2: the review options that run an upstream skill, plugin or scanner as shipped (modules/code-review,
# recipe/engines.ts `skill:<option>` and recipe/deepsec.ts). Everything here is pinned to a commit or version published on or before
# 2026-11-14 (the 7-day rule at 2026-11-22); a bump moves the pin and the catalog's version together. Nothing is loaded by default:
# a review run links only the selected skill or plugin into its own throwaway home (resolveSkill).
#   /opt/review/skills/<owner>__<repo>/  the repo at its pin (skill folders inside)
#   /opt/review/plugins/<name>/          a Claude Code plugin folder at its pin
# deepsec 2.3.12 (2026-11-06; 2.3.13 on 2026-11-16 is too new): npm's tarball, install scripts off.
RUN npm i -g --ignore-scripts deepsec@2.3.12 && npm cache clean --force && deepsec --version
RUN set -eu; mkdir -p /opt/review/skills /opt/review/plugins; \
    pin() { d=$1; repo=$2; sha=$3; git init -q "$d" && git -C "$d" fetch -q --depth 1 "https://github.com/$repo" "$sha" && git -C "$d" checkout -q FETCH_HEAD && rm -rf "$d/.git"; }; \
    skills() { pin "/opt/review/skills/$(echo "$1" | sed 's#/#__#')" "$1" "$2"; }; \
    # Skill repos (each passes through to run.skills as <owner>/<repo>:<skill>).
    skills cloudflare/security-audit-skill c1c8a8c1471069fb0e188eeaff69b8e8db6564a8; \
    skills trailofbits/skills 149d7b21f4067765b82e67029730b42d228ef4b4; \
    skills mattpocock/skills 5863806dd4e15c63174bee4e7515a4256792ecfa; \
    skills supabase/agent-skills c9be0e931b7930f7d02126d04774d904c381e7d7; \
    skills vercel-labs/agent-skills 53b6e3ddf96b3fa83af97b1783ed805b582ad3a7; \
    skills getsentry/skills a582c51ee29d0f35e6ac321340796f77d43da733; \
    skills callstackincubator/agent-skills 59e9d17446a248b21d86f078fcd0bd2d36db1ca4; \
    skills dotnet/skills 2877c712edc20643b72f64e2983b168e6661d607; \
    skills pashov/skills eacfc09b365d2697b83355909d0300607e596ffc; \
    # Claude Code plugins: anthropics/claude-plugins-official's three, and EveryInc's (the repo root is the plugin).
    pin /tmp/cpo anthropics/claude-plugins-official b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6; \
    for p in pr-review-toolkit code-modernization security-guidance; do cp -r "/tmp/cpo/plugins/$p" "/opt/review/plugins/$p"; done; rm -rf /tmp/cpo; \
    # Trail of Bits plugins (their commands, agents and skills as a plugin), from the pinned skills checkout above.
    for p in audit-context-building insecure-defaults sharp-edges fp-check differential-review variant-analysis; do cp -r "/opt/review/skills/trailofbits__skills/plugins/$p" "/opt/review/plugins/$p"; done; \
    pin /opt/review/plugins/compound-engineering EveryInc/compound-engineering-plugin ee46dde75a40e297bd8eac4055a410a771d3ac1d; \
    # Left out: gemini-cli-extensions/code-review (no gemini CLI in the image) and openai/codex-plugin-cc (inactive since 2026-07,
    # and it calls a local codex outside our gateway).
    chmod -R a+rX /opt/review; \
    test -f /opt/review/skills/cloudflare__security-audit-skill/skills/security-audit/SKILL.md; \
    test -f /opt/review/plugins/pr-review-toolkit/.claude-plugin/plugin.json; \
    test -f /opt/review/plugins/compound-engineering/.claude-plugin/plugin.json; \
    test -f /opt/review/plugins/insecure-defaults/commands/audit.md; \
    test -f /opt/review/skills/mattpocock__skills/skills/engineering/codebase-design/SKILL.md

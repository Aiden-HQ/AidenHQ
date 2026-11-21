# An engineer's computer: the base plus toolchains. Pushes and merges are the runner's, against an approval; GitHub reads are
# the github connection's tools. BASE is the agent-base tag (ops/computer-images.sh).
# Usable by any uid: a runner job's box (the Engineer) runs as the runner's uid, not root, so every toolchain lives outside
# /root and each tool's caches go under the job's writable HOME.
ARG BASE=aidenhq/computer-agent-base
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev python3-pip python3-dev golang-go make gnupg openssh-client \
    && rm -rf /var/lib/apt/lists/*
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

# ---- Code review tools (modules/code-review/catalog.json: every `tool` option's binary; recipe/tools.ts runs them) ----
# Each is pinned (versions published on or before 2026-11-15, so 7+ days old) and checksummed (release downloads: sha256 per
# architecture from the GitHub release's own digests), or resolved as of that date (npm --before, uv --exclude-newer, the Go
# module proxy with its checksum database). gitleaks is the one above. Nothing is downloaded when a review runs, except the
# vulnerability databases osv-scanner, trivy and govulncheck read (data, not code).
# uv 0.13.8 builds the Python tools' venv, then stays only as a build step's tool.
RUN case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64-unknown-linux-gnu sum=5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91 ;; \
      arm64) triple=aarch64-unknown-linux-gnu sum=74f2f5c6024d397481db228db8fc25eed420db192243f88438c118e7e013e585 ;; \
    esac \
    && curl -fsSLo /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/0.13.8/uv-$triple.tar.gz" \
    && echo "$sum  /tmp/uv.tgz" | sha256sum -c - \
    && mkdir /tmp/uv && tar -xzf /tmp/uv.tgz -C /tmp/uv --strip-components=1 \
    && UV_CACHE_DIR=/tmp/uv-cache /tmp/uv/uv venv --python /usr/bin/python3 /opt/review-py \
    && UV_CACHE_DIR=/tmp/uv-cache /tmp/uv/uv pip install --python=/opt/review-py/bin/python --exclude-newer=2026-11-15T23:59:59Z vulture==2.16 ruff==0.17.5 \
    && ln -s /opt/review-py/bin/vulture /opt/review-py/bin/ruff /usr/local/bin/ \
    && rm -rf /tmp/uv /tmp/uv.tgz /tmp/uv-cache && chmod -R a+rX /opt/review-py \
    && vulture --version | grep -qx 'vulture 2.16' && ruff --version | grep -qx 'ruff 0.17.5'
RUN npm i -g --before=2026-11-15 oxlint@1.93.0 knip@6.45.1 jscpd@5.4.3 fallow@3.43.1 && npm cache clean --force \
    && oxlint --version | grep -q 1.93.0 && knip --version | grep -q 6.45.1 && jscpd --version | grep -q 5.4.3 && fallow --version | grep -q 3.43.1
# govulncheck v1.9.0 (2026-10-11), built with the image's Go from the module proxy (go.sum and the checksum database verify it).
RUN GOTOOLCHAIN=local CGO_ENABLED=0 GOBIN=/usr/local/bin GOPATH=/tmp/gopath GOCACHE=/tmp/gocache go install golang.org/x/vuln/cmd/govulncheck@v1.9.0 \
    && chmod -R u+w /tmp/gopath && rm -rf /tmp/gopath /tmp/gocache && govulncheck -version | grep -q v1.9.0
# actionlint 1.7.12, osv-scanner 2.7.1, zizmor 1.32.0, trivy 0.76.2, scc 4.1.0 and squawk 2.72.0: release binaries.
RUN case "$(dpkg --print-architecture)" in \
      amd64) a=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 file=actionlint_1.7.12_linux_amd64.tar.gz ;; \
      arm64) a=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 file=actionlint_1.7.12_linux_arm64.tar.gz ;; \
    esac \
    && curl -fsSLo /tmp/al.tgz "https://github.com/rhysd/actionlint/releases/download/v1.7.12/$file" && echo "$a  /tmp/al.tgz" | sha256sum -c - \
    && tar -xzf /tmp/al.tgz -C /usr/local/bin actionlint && rm /tmp/al.tgz && actionlint -version | head -n1 | grep -qx 1.7.12
RUN case "$(dpkg --print-architecture)" in \
      amd64) a=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8 file=osv-scanner_linux_amd64 ;; \
      arm64) a=983d22fbad9724514e3fcc6acc83b5fa64c5ffa6b0d9f510028f22c1b223ff81 file=osv-scanner_linux_arm64 ;; \
    esac \
    && curl -fsSLo /usr/local/bin/osv-scanner "https://github.com/google/osv-scanner/releases/download/v2.7.1/$file" && echo "$a  /usr/local/bin/osv-scanner" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/osv-scanner && osv-scanner --version | grep -q 2.7.1
RUN case "$(dpkg --print-architecture)" in \
      amd64) a=bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b file=zizmor-x86_64-unknown-linux-gnu.tar.gz ;; \
      arm64) a=cb152b207f815116d7fa1c1ee4614f61578803351395052908095e79adfd9fd0 file=zizmor-aarch64-unknown-linux-gnu.tar.gz ;; \
    esac \
    && curl -fsSLo /tmp/zz.tgz "https://github.com/zizmorcore/zizmor/releases/download/v1.32.0/$file" && echo "$a  /tmp/zz.tgz" | sha256sum -c - \
    && tar -xzf /tmp/zz.tgz -C /usr/local/bin zizmor && rm /tmp/zz.tgz && zizmor --version | grep -q 1.32.0
RUN case "$(dpkg --print-architecture)" in \
      amd64) a=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf file=trivy_0.76.2_Linux-64bit.tar.gz ;; \
      arm64) a=ab9d51f86e6a5fb936f605faff6b593ac51bc378fff4d3e8b9d58358b9c367c3 file=trivy_0.76.2_Linux-ARM64.tar.gz ;; \
    esac \
    && curl -fsSLo /tmp/tv.tgz "https://github.com/aquasecurity/trivy/releases/download/v0.76.2/$file" && echo "$a  /tmp/tv.tgz" | sha256sum -c - \
    && tar -xzf /tmp/tv.tgz -C /usr/local/bin trivy && rm /tmp/tv.tgz && trivy --version | head -n1 | grep -qx 'Version: 0.76.2'
RUN case "$(dpkg --print-architecture)" in \
      amd64) a=c7328436d3027f4357d3d7853f7dc3ac2bbcb4ca08f1adad91a27c593884079b file=scc_Linux_x86_64.tar.gz ;; \
      arm64) a=6e0d2a1f8d3540ba7df185477dec40bb7340f1b214bfd303147de5cad2bd7b8b file=scc_Linux_arm64.tar.gz ;; \
    esac \
    && curl -fsSLo /tmp/scc.tgz "https://github.com/boyter/scc/releases/download/v4.1.0/$file" && echo "$a  /tmp/scc.tgz" | sha256sum -c - \
    && tar -xzf /tmp/scc.tgz -C /usr/local/bin scc && rm /tmp/scc.tgz && scc --version | grep -q 4.1.0
RUN case "$(dpkg --print-architecture)" in \
      amd64) a=a61661808119a82515565503111099b070c869f73698f61cb1785de5d0c8b11a file=squawk-linux-x64 ;; \
      arm64) a=bcb529c1344512de5ce70695d89e7b1ae58738f73c05187a5f56cbf079417cf2 file=squawk-linux-arm64 ;; \
    esac \
    && curl -fsSLo /usr/local/bin/squawk "https://github.com/sbdchd/squawk/releases/download/v2.72.0/$file" && echo "$a  /usr/local/bin/squawk" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/squawk && squawk --version | grep -q 2.72.0
# ---- end of the code review tools ----

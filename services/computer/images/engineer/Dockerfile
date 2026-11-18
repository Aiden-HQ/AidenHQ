# An engineer's computer: the base plus toolchains. gh is installed without a token: pushes and merges are the runner's, against an
# approval. BASE is the agent-base tag (ops/computer-images.sh).
# Usable by any uid: a runner job's box (the App Engineer) runs as the runner's uid, not root, so every toolchain lives outside
# /root and each tool's caches go under the job's writable HOME.
ARG BASE=aidenhq/computer-agent-base
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev python3-pip python3-dev golang-go make gnupg openssh-client \
    && rm -rf /var/lib/apt/lists/*
# gh 2.104.0 (released 2026-11-12), GitHub's release .deb, not Debian's gh (the base is debian:sid-slim, whose gh is 2.46.0-4,
# with no fix for CVE-2026-48501: the auth layer sent a github.com token to tuf-repo.github.com, fixed upstream in 2.93.0) and
# not GitHub's apt repository (it keeps only the newest build, so a pin there breaks). Built with go1.27.4. Per-arch sha256
# from the release's gh_2.104.0_checksums.txt, checksummed before dpkg installs it.
RUN case "$(dpkg --print-architecture)" in \
      amd64) sum=f90d578cbc4c3b067dfc4a1a540cef41faef64eebfb280b548ab32455977a21f ;; \
      arm64) sum=95b0632a7e1b12761248b7266825b0eab0853cefb84a1e272d905acb6e436f6c ;; \
    esac \
    && curl -fsSLo /tmp/gh.deb "https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_linux_$(dpkg --print-architecture).deb" \
    && echo "$sum  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb && rm /tmp/gh.deb \
    && gh --version
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
# Per-arch sha256 from the release's gitleaks_8.30.1_checksums.txt, checksummed before it is unpacked.
RUN case "$(dpkg --print-architecture)" in \
      amd64) arch=x64 sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
      arm64) arch=arm64 sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
    esac \
    && curl -fsSLo /tmp/gl.tgz "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_$arch.tar.gz" \
    && echo "$sum  /tmp/gl.tgz" | sha256sum -c - \
    && tar -xzf /tmp/gl.tgz -C /usr/local/bin gitleaks && rm /tmp/gl.tgz \
    && gitleaks version
# Global npm installs land in /usr/local (the node image's prefix), readable by all.
# pnpm 10.34.9 (2026-10-25): its vendored tree carries tar 7.5.22 (GHSA-23hp-3jrh-7fpw fixed in 7.5.19), glob 10.5.0,
# picomatch 4.0.7, brace-expansion 2.1.7, minimatch 9.0.9 and ip-address 10.7.4 (the 14 highs 10.20.0 had).
RUN npm i -g pnpm@10.34.9 typescript@5.9.3 && npm cache clean --force
# The `aidenhq` commands of a kernel job (bin/aidenhq: calls to the kernel with the job's own token), and the job's wrappers
# first on its PATH (/opt/aidenhq/bin): a read-only gh, a capped sleep and aidenhq-browse (screenshots of the app it builds).
COPY --chmod=755 bin/aidenhq /usr/local/bin/aidenhq
COPY --chmod=755 bin/gh bin/sleep bin/aidenhq-browse /opt/aidenhq/bin/

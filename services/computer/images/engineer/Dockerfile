# An engineer's computer: the base plus toolchains. gh is installed without a token: pushes and merges are the runner's, against an
# approval. BASE is the agent-base tag (ops/computer-images.sh).
# Usable by any uid: a runner job's box (the App Engineer) runs as the runner's uid, not root, so every toolchain lives outside
# /root and each tool's caches go under the job's writable HOME.
ARG BASE=aidenhq/computer-agent-base
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev python3-pip python3-dev golang-go make gnupg \
    && rm -rf /var/lib/apt/lists/*
# gh from GitHub's own apt repository, not Debian's: the base is debian:sid-slim (the browser image), whose gh is 2.46.0-4,
# with no fix for CVE-2026-48501 (the auth layer sent a github.com token to tuf-repo.github.com, fixed upstream in 2.93.0)
# and a Go stdlib carrying published advisories. 2.104.0 (2026-11-12) is built with go1.27.4. The owner approved this one
# new apt source; .github/supply-chain-source-exceptions.yaml records it. The keyring is read into /tmp first and written
# only after its unexpired primary keys are exactly the GitHub CLI key, so an added signing key is refused; `signed-by`
# carries the same fingerprint, for this repository alone, in the vendor's suite matching sid. The repository keeps only
# the newest build, so the pin moves.
RUN mkdir -m 700 -p /tmp/gh-gpg \
    && curl -fsSLo /tmp/gh-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && keys="$(GNUPGHOME=/tmp/gh-gpg gpg --batch --show-keys --with-colons /tmp/gh-keyring.gpg \
      | awk -F: '$1 == "pub" { p = ($2 != "e" && $2 != "r" && $2 != "d" && $2 != "i"); next } p && $1 == "fpr" { print $10; p = 0 }')" \
    && [ "$keys" = 7F38BBB59D064DBCB3D84D725612B36462313325 ] \
    && install -m 0644 /tmp/gh-keyring.gpg /etc/apt/keyrings/github-cli.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/github-cli.gpg,7F38BBB59D064DBCB3D84D725612B36462313325] https://cli.github.com/packages sid main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh=2.104.0 \
    && rm -rf /var/lib/apt/lists/* /tmp/gh-keyring.gpg /tmp/gh-gpg \
    && gh --version
# rustup-init 1.29.3 (archived 2026-11-03), checksummed; it installs the pinned toolchain into /opt/rust (readable by all). At run
# time RUSTUP_HOME stays there; CARGO_HOME is unset, so cargo's registry and builds go under the user's own HOME.
ENV RUSTUP_HOME=/opt/rust/rustup
RUN curl -fsSLo /tmp/rustup-init https://static.rust-lang.org/rustup/archive/1.29.3/x86_64-unknown-linux-gnu/rustup-init \
    && echo "b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init && CARGO_HOME=/opt/rust/cargo /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.91.0 && rm /tmp/rustup-init \
    && chmod -R a+rX /opt/rust && /opt/rust/cargo/bin/rustc --version
ENV PATH=/opt/rust/cargo/bin:$PATH
# Global npm installs land in /usr/local (the node image's prefix), readable by all.
# pnpm 10.34.9 (2026-10-25): its vendored tree carries tar 7.5.22 (GHSA-23hp-3jrh-7fpw fixed in 7.5.19), glob 10.5.0,
# picomatch 4.0.7, brace-expansion 2.1.7, minimatch 9.0.9 and ip-address 10.7.4 (the 14 highs 10.20.0 had).
RUN npm i -g pnpm@10.34.9 typescript@5.9.3 && npm cache clean --force

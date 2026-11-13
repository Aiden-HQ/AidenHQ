# An engineer's computer: the base plus toolchains. gh is installed without a token: pushes and merges are the runner's, against an
# approval. BASE is the agent-base tag (ops/computer-images.sh).
ARG BASE=aidenhq/computer-agent-base
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev python3-pip python3-dev golang-go make gh \
    && rm -rf /var/lib/apt/lists/*
# rustup-init 1.29.3 (archived 2026-11-03), checksummed; it installs the pinned toolchain.
RUN curl -fsSLo /tmp/rustup-init https://static.rust-lang.org/rustup/archive/1.29.3/x86_64-unknown-linux-gnu/rustup-init \
    && echo "b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init && /tmp/rustup-init -y --profile minimal --default-toolchain 1.91.0 && rm /tmp/rustup-init \
    && /root/.cargo/bin/rustc --version
ENV PATH=/root/.cargo/bin:$PATH
RUN npm i -g pnpm@10.20.0 typescript@5.9.3 && npm cache clean --force

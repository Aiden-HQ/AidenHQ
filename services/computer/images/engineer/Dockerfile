# An engineer's computer: the base plus toolchains. gh is installed without a token: pushes and merges are the runner's, against an
# approval. BASE is the agent-base tag (ops/computer-images.sh).
ARG BASE=aidenhq/computer-agent-base
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev python3-pip python3-dev golang-go make gh \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.91.0 && /root/.cargo/bin/rustc --version
ENV PATH=/root/.cargo/bin:$PATH
RUN npm i -g pnpm@10.20.0 typescript@5.9.3 && npm cache clean --force

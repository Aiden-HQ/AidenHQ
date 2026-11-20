# Grafana's MCP server as published (a folder of its own so Dependabot bumps it); release date in docs/design/monitoring.md.
# The published tag is bookworm, which has no fix for zlib CVE-2026-85091 or pam CVE-2025-6020, so only its prebuilt binary is
# copied in, onto a digest-pinned Debian sid base (its own layer is CGO_ENABLED=0, statically linked).
FROM grafana/mcp-grafana:2.3.0@sha256:c27248b5919d09d64ea273ca1b128b32902c6796f6e2dfcd11849d4f1363f9ed AS upstream

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# CA certificates for Grafana's TLS; sid-slim ships none and the upstream image had them. No apt lists left in the image.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
# The upstream image runs as mcp-grafana, uid 1000, gid 999 (/home/mcp-grafana, /bin/sh); this base has no such account, so
# it is re-created, and the runtime keeps that identity so a mounted secret readable by gid 999 stays readable.
RUN groupadd --gid 999 mcp-grafana && useradd --uid 1000 --gid 999 --create-home --shell /bin/sh mcp-grafana
WORKDIR /app
COPY --from=upstream /app/mcp-grafana /app/mcp-grafana
USER 1000:999
EXPOSE 8000
ENTRYPOINT ["/app/mcp-grafana", "--transport", "sse", "--address", "0.0.0.0:8000"]

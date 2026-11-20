# Grafana's MCP server as published (a folder of its own so Dependabot bumps it); release date in docs/design/monitoring.md.
# The published tag is bookworm, which has no fix for zlib CVE-2026-85091 or pam CVE-2025-6020, so only its prebuilt binary and
# its CA trust store are copied in, onto a digest-pinned Debian sid base (its own layer is CGO_ENABLED=0, statically linked).
FROM grafana/mcp-grafana:2.3.0@sha256:c27248b5919d09d64ea273ca1b128b32902c6796f6e2dfcd11849d4f1363f9ed AS upstream

FROM debian:sid-slim@sha256:07a3205e8583fdff12d2b05bd030f50437e9fd340ee616df0c05dc77af75767b
# sid-slim ships no CA certificates and the server calls Grafana over TLS: take the bundle the upstream image installed, rather
# than fetching packages at build time. It pins the same trust store the image ran with before.
COPY --from=upstream /etc/ssl /etc/ssl
# The upstream image runs as mcp-grafana, uid 1000, gid 999 (/home/mcp-grafana, /bin/sh); this base has no such account, so
# it is re-created, and the runtime keeps that identity so a mounted secret readable by gid 999 stays readable.
RUN groupadd --gid 999 mcp-grafana && useradd --uid 1000 --gid 999 --create-home --shell /bin/sh mcp-grafana
WORKDIR /app
COPY --from=upstream /app/mcp-grafana /app/mcp-grafana
USER 1000:999
EXPOSE 8000
ENTRYPOINT ["/app/mcp-grafana", "--transport", "sse", "--address", "0.0.0.0:8000"]

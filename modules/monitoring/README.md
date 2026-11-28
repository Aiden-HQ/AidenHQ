# monitoring

## What it does

Host and fleet monitoring with Prometheus, node-exporter, cAdvisor, Alertmanager and Grafana. Every alert opens or
updates a Fleet Steward task, and critical ones also tell you in one line. Design: `docs/design/monitoring.md`.

## Connect

Nothing to connect. Grafana alone is published (on loopback, port 3131), and `tailscale serve` exposes it on the tailnet.
Set `grafana_root_url` to its https address so links in Grafana work. To let agents read it, set `grafana_source: local`
in the `grafana` module and put a Viewer service account token in the vault.

## What agents get

No tools of its own. Agents read metrics through the `grafana` connection (`mcp-grafana` joins this module's network when
`grafana_source` is `local`). Prometheus keeps samples for 30 days.

## New installs

Not in the default bundle. It needs `fleet-steward` and `grafana`, and reads the host's `/`, `/sys` and `/proc`
read-only. Nothing is published beyond loopback.

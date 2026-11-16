# Monitoring

The `monitoring` module watches the host and the fleet for degradation: disks filling, memory pressure and OOM kills,
containers restarting, a core service or systemd unit down, the runner's queue stuck, spend near a cap. External pings
already cover "host down"; this covers everything short of it. Every alert opens or updates a Fleet Ops task; only the
two critical ones also tell the owner.

## What runs

| Piece | Where | Reached at |
|---|---|---|
| Prometheus (30 days, `monitoring_retention`) | `aidenhq-mod-monitoring` + `-board` | not published |
| node-exporter (as nobody; host `/`, `/proc`, `/sys` read-only; textfiles) | `aidenhq-mod-monitoring` | not published |
| cAdvisor (cgroup CPU, memory, disk IO; no Docker socket) | `aidenhq-mod-monitoring` | not published |
| Alertmanager | `aidenhq-mod-monitoring` + `-board` | not published |
| Grafana (no anonymous access, admin password in the vault) | `aidenhq-mod-monitoring` + `-egress` | `127.0.0.1:3131`, tailnet via `tailscale serve` |
| mcp-grafana (read tools only, Viewer token from the vault) | `aidenhq-mod-monitoring` + `aidenhq-mod-grafana` (join) | `mcp-grafana:8000`, grafana-mcp only |
| Board `/internal/metrics`, `/internal/alerts` | board's internal listener | `board:3122`, monitoring token only |
| Gateway metrics | `data/modules/monitoring/textfile/gateway.prom`, every 30 s | node-exporter's textfile collector |
| Runner metrics | `data/modules/monitoring/textfile/runner.prom`, every 30 s | the same |
| Unit and container states | `ops/host-metrics.sh` (user timer `aidenhq-host-metrics`, every 30 s) | the same |

Networks (generated from `services:` in `modules/monitoring/module.yaml`): `aidenhq-mod-monitoring` (the module's services),
`aidenhq-mod-monitoring-board` (Prometheus and Alertmanager to the board's internal listener, and the board), the grafana
module's `aidenhq-mod-grafana` (mcp-grafana joins it to meet grafana-mcp: monitoring requires grafana); all internal, none of
the module's services on the backplane. node-exporter and cAdvisor's read-only host mounts are the module's one privileged
entry, `host-metrics`. Alertmanager's API (silences), Prometheus and mcp-grafana take no auth of their own, so these networks are
their boundary; `scripts/verify-security.sh` checks it.

The host processes (runner, gateway) and the systemd/container states are textfiles, not listeners: no new port on the host, no new privilege
(`systemctl [--user] list-units` and `docker inspect` as the owner's user, who runs the runner already). A stale textfile
is itself an alert: `HostMetricsStale` for every textfile but the unit snapshot, `HostMetricsExporterStale` for the unit
snapshot (`units.prom`), whose freshness also gates the unit alerts.

cAdvisor gets no Docker socket (only apps-mcp holds one, `scripts/verify-security.sh`), so it labels containers by cgroup
id; `containers.prom` carries each compose container's and computer box's id, name, project and service, and the Containers
dashboard and the `cpu` recording rules join on it. cAdvisor's raw cgroup whitelist also covers dockerd and containerd (Docker
builds) and `/user.slice` (the runner's service cgroup holds the Engineer jobs). The "CPU by source" panel stacks
`aidenhq:cpu_cores:by_source`: Engineer jobs, CI runners, computer boxes, Paperclip, apps, builds/dockerd, and other (the host
total less the rest, which also holds containers too short-lived for `containers.prom`'s 30 second refresh to name). CPU spikes
alone are fine; `AppsCpuStarved` fires only when deployed apps are starved (below).
Network counters from node-exporter are its own namespace's (no host networking); disk, memory, CPU, pressure and OOM
kills are the host's.

Images (pinned by digest; `scripts/supply-chain/best-version.mjs`, release dates):
`prom/prometheus:v3.16.0` (2026-11-05), `prom/node-exporter:v1.12.1` (2026-07-14), `prom/alertmanager:v0.35.0`
(2026-11-09), `grafana/grafana:13.3.0` (2026-10-27), `ghcr.io/google/cadvisor:v0.60.6` (GitHub release 2026-09-18),
`grafana/mcp-grafana:2.2.0` (2026-11-02).

## Metrics

- Board: `aidenhq_board_cards_created_today{tier}`, `aidenhq_board_cards_decided_today{tier,state}`,
  `aidenhq_board_cards_pending{tier}`, `aidenhq_board_fleet_incidents_open`, `aidenhq_board_alerts_firing`.
- Gateway: `aidenhq_gateway_spend_usd_today{agent,kind}`, `aidenhq_gateway_agent_day_spend_usd{agent}` and
  `_agent_day_cap_usd{agent}`, `aidenhq_gateway_cap_refusals_today{agent,kind}`, `aidenhq_gateway_ci_spend_usd_today`,
  `aidenhq_gateway_ci_day_cap_usd`, `aidenhq_gateway_inflight`. Labels are agent keys.
- Runner: `aidenhq_runner_queue_depth`, `_running_jobs`, `_oldest_job_seconds`, `_job_duration_seconds` (histogram, since
  the runner started), `_merge_queues{state}`, `_merge_prs_waiting`.
- Host: `aidenhq_unit_active|failed{scope,unit}`, `aidenhq_fleet_draining`, `aidenhq_container_running|restarts|unhealthy{id,project,service,name}`.
  A planned drain records the units it stopped in `data/fleet-paused.json`, and `aidenhq_unit_failed` stays 0 for them while
  that record exists: `UnitFailed` and `CiRunnersDown` (which also needs `aidenhq_fleet_draining == 0`) page on a crash, not on
  maintenance. Both also need a fresh `units.prom` (written within 3 minutes), so a dead exporter is a freshness alert
  (`HostMetricsExporterStale`) and never reads as "0 active" or "16 failed".

No secrets or ids in labels. TODO: CI time per workflow run lives in GitHub; not recorded here yet (a later small exporter
over the Actions API, or the runner recording its CI runs).

## Alerts and routing

Rules are `modules/monitoring/prometheus/rules.yml`: `DiskSpaceLow` (over 85%, or on course to fill in 24 h),
`DiskNearlyFull` (over 95%, **critical**), `MemoryPressure`, `OomKill`, `HostMetricsStale`, `ContainerRestarting`,
`CoreServiceDown` (an aidenhq container, the runner or gateway unit, or the board or gateway not answering, for 5 minutes,
**critical**), `HostMetricsExporterStale` (`units.prom` absent or not written for 3 minutes: unit state is unknown, not a
stopped fleet), `UnitFailed`, `CiRunnersDown`, `CiRunnerUnitMissing` (a runner unit in `units.prom` within the last day and
gone now, named by unit), `RunnerQueueStuck`, `RunnerJobOverlong`, `GatewaySpendNearCap`,
`CiReviewSpendNearCap`, `AppsCpuStarved` (an `app-*` container's own CPU pressure over 20% while the host's is over 15%; the
alert names the app's project, and host pressure alone never fires it). The rules' test is
`modules/monitoring/prometheus/rules.test.yml`: a host-only spike fires nothing, an `app-*` match carries its project, and
an app at its own limit with an idle host does not fire. Run it with the promtool of the module's own image, so the
checker is the build the module serves:
`docker run --rm --entrypoint /bin/promtool -v "$PWD/modules/monitoring/prometheus:/rules:ro" -w /rules prom/prometheus:v3.16.0@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06 check rules rules.yml`
(and `test rules rules.test.yml`).

Alertmanager has one receiver: the board's `POST /internal/alerts` (`services/board/src/monitoring.ts`), with
`send_resolved`. The board keeps what is firing and the Fleet Ops detector (`fleet-ops.ts`) gets an `alert` check group, so
an alert takes the detector's existing path: one incident per alert, the "Fleet Ops: check" webhook fired once, the
incident recovered (and fired once more) when the alert resolves. The board runs the detector at once when an alert
arrives. So the module requires `fleet-ops`.

The webhook is one-shot news, so the detector does not rely on it alone: each tick its `alert` group also reads
Alertmanager's `GET /api/v2/alerts` and reconciles. An alert no longer in that list recovers even when its whole label set
vanished — `aidenhq_apply_failed` is exported under each apply generation's `n`, `reason`, `log` and `health`, so a later
generation replaces a failed one's series, and the failed apply is itself restarting the board that would have taken the
resolve. One still in the list stays open, silenced and inhibited included: a silence stops notifications, not the alert.
When Alertmanager cannot be asked the webhook's record stands, so nothing recovers on a guess.

A newly firing critical alert also queues one owner line (`🚨 Monitoring: <rule> (critical): <fixed sentence>`), which the
owner channel collects with the detector's other health lines. Label and annotation text never reaches the owner (an app
can choose names that appear in labels): the line is the rule's name (identifiers only) and a fixed sentence per critical
rule. In the Fleet Ops incident the alert's text is fenced as data, after a first line built from slugs.

## Access

Every listener is loopback or in-network. Grafana is published on `127.0.0.1:3131` and reaches the tailnet through the
host's `tailscale serve`; `scripts/host-serve.mjs` allows it next to Paperclip and the board (trusted services that sign
people in; never an app, which lives on the apps node). Grafana: admin user `admin`, password in the vault
(`grafana_admin_password`, made by compile), anonymous access and sign-up off, update checks and plugin installs off. The
datasource and the dashboards (Node Exporter Full, stock from rfmoz/grafana-dashboards, Apache-2.0; Containers and Fleet,
ours) are provisioned from git and cannot be edited in the UI.

`monitoring_token` (made by compile) is the one token Prometheus scrapes with and Alertmanager posts with; it opens only
the board's two monitoring routes. The board's internal token opens neither.
`scripts/verify-security.sh` checks the ports, Grafana's sign-in, node-exporter running as nobody with read-only mounts,
the token split, and that Prometheus, Alertmanager, cAdvisor and mcp-grafana are on the monitoring networks only.

## Agents

grafana-mcp (`modules/grafana`) can point at this Grafana: `settings.grafana_source: local`. It then talks to the module's
`mcp-grafana` (Grafana's own MCP server, `--disable-write`) with no OAuth sign-in, on a network only the two share, and
allows exactly the connection's granted reads (`LOCAL_TOOLS`, kept equal to `tools.read` by a test), whatever a caller asks.
Keep the service account at Viewer. One-time:
in Grafana, make a service account with the Viewer role and a token, and put the token in the vault's
`grafana_service_account_token` (compile creates the file empty), then enable the `grafana` module and apply. Fleet Ops
has `grafana?: read` (granted whenever the grafana module is on); another agent gets it in its own definition
(`connections: { grafana: read }`).

## Enabling

1. Instance: add `monitoring` to `modules:` (and optionally `monitoring_retention`, `grafana_root_url`), commit, apply.
   Compile creates the secrets and `data/monitoring/*`; apply starts the services and the `aidenhq-host-metrics` timer.
2. Tailnet: `tailscale serve --bg --https=8444 http://127.0.0.1:3131` on the host (the operator is tailscaled's
   operator, no sudo), then set `grafana_root_url: https://<host>.<tailnet>.ts.net:8444`.
3. Optional (agents read metrics): the service account token above, the `grafana` module with `grafana_source: local`.

No sudo is needed: every metric is read as the owner's user. Turning the module off removes the services and the timer.

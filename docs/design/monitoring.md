# Monitoring

The `monitoring` module watches the host and the fleet for degradation: disks filling, memory pressure and OOM kills,
containers restarting, a core service or systemd unit down, a failed apply, spend near a cap. External pings already cover
"host down"; this covers everything short of it. Every alert opens or updates a Fleet Ops task; only the critical ones also
tell the owner.

## What runs

| Piece | Where | Reached at |
|---|---|---|
| Prometheus (`monitoring_retention`, default 30d) | `aidenhq-mod-monitoring` + `-board` | not published |
| node-exporter (as nobody; host `/`, `/proc`, `/sys` read-only; textfiles) | `aidenhq-mod-monitoring` | not published |
| cAdvisor (cgroup CPU, memory, disk IO, pressure; no Docker socket) | `aidenhq-mod-monitoring` | not published |
| Alertmanager | `aidenhq-mod-monitoring` + `aidenhq-mod-fleet-steward` (join) | not published |
| Grafana (no anonymous access, admin password in the vault) | `aidenhq-mod-monitoring` + `-egress` | `127.0.0.1:3131`, tailnet via `tailscale serve` |
| mcp-grafana (`--disable-write`, Viewer token from the vault) | `aidenhq-mod-monitoring` + `aidenhq-mod-grafana` (join) | `mcp-grafana:8000`, grafana-mcp only |
| Board `/internal/metrics` | board's internal listener | `board:3122`, monitoring token only |
| Fleet Steward service `/alerts`, `/metrics` | `aidenhq-mod-fleet-steward`, shared only with Alertmanager and Prometheus | `fleet-steward:8097`, the monitoring token only (the service asks the kernel's `/v1/whoami`: module `monitoring`) |
| Gateway metrics | `data/modules/monitoring/textfile/gateway.prom`, written by the kernel every 30 s while the directory exists | node-exporter's textfile collector |
| Unit, container and apply-generation states | `ops/host-metrics.sh` (user timer `aidenhq-host-metrics`, every 30 s): `units.prom`, `containers.prom`, `generations.prom`, `docker.prom` | the same |

Networks (generated from `services:` in `modules/monitoring/module.yaml`): `aidenhq-mod-monitoring` (the module's services),
`aidenhq-mod-monitoring-board` (Prometheus and Alertmanager to the board's internal listener, and the board), and the grafana
module's `aidenhq-mod-grafana` (mcp-grafana joins it to meet grafana-mcp; monitoring requires grafana). All internal, none of
the module's services on the backplane. node-exporter and cAdvisor's read-only host mounts are the module's one privileged
entry, `host-metrics`. Alertmanager's API (silences), Prometheus and mcp-grafana take no auth of their own, so these networks
are their boundary; `scripts/verify-security.sh` checks it.

Unit and container states are textfiles, not listeners: no new port on the host and no new privilege (`systemctl [--user]
list-units` and `docker inspect` run as the owner's user). A stale textfile is itself an alert: `HostMetricsStale` for every
textfile but the unit snapshot, `HostMetricsExporterStale` for `units.prom`, whose freshness also gates the unit alerts.

cAdvisor gets no Docker socket (only apps-mcp holds one), so it labels containers by cgroup id; `containers.prom` carries every
container's id, name, project and service (`-` for both on a container without compose labels) and its running state, and the
Containers dashboard and the `cpu` recording rules join on it. cAdvisor's raw cgroup whitelist also covers dockerd and
containerd (Docker builds) and `/user.slice`. The "CPU by source" panel stacks `aidenhq:cpu_cores:by_source`. CPU spikes alone
are fine; `AppsCpuStarved` fires only when deployed apps are starved. Network counters from node-exporter are its own
namespace's (no host networking); disk, memory, CPU, pressure and OOM kills are the host's.

Images (pinned by digest in each folder's Dockerfile; Dependabot bumps them; release dates per `scripts/supply-chain/best-version.ts`):
`prom/prometheus:v3.16.0` (2026-11-05), `prom/node-exporter:v1.13.1` (2026-11-19), `prom/alertmanager:v0.35.0` (2026-11-09),
`grafana/grafana:13.3.2` (2026-11-24), `ghcr.io/google/cadvisor:v0.60.6` (GitHub release 2026-09-18;
its final stage is `alpine:3.24.4`, 2026-11-08, and the Dockerfile upgrades that base's packages),
`grafana/mcp-grafana:2.3.0` (2026-11-10).

## Metrics

- Board: `aidenhq_board_cards_created_today{tier}`, `aidenhq_board_cards_decided_today{tier,state}`, `aidenhq_board_cards_pending{tier}`.
- Fleet Steward service: `aidenhq_steward_incidents_open`, `aidenhq_steward_alerts_firing`.
- Gateway: `aidenhq_gateway_spend_usd_today{agent,kind}`, `aidenhq_gateway_install_spend_usd{period}` and
  `aidenhq_gateway_install_limit_usd{period}` (`period` is `day` or `month`), `aidenhq_gateway_cap_refusals_today{agent,kind}`,
  `aidenhq_gateway_inflight`. Labels are agent keys.
- Kernel jobs (relayed by the Fleet Steward's `/metrics`, role `kernel.work-read`): `aidenhq_kernel_jobs_running`, `_oldest_seconds`
  (running jobs other than sessions: sessions are deadline-free, so their age is no fault), `_duration_seconds` (histogram over
  every job on record), and `aidenhq_kernel_session_oldest_seconds` for the age of the oldest running session job.
- Host: `aidenhq_unit_active|failed{scope,unit}`, `aidenhq_unit_backoff{scope="user",unit}` (a CI runner's persisted wait
  after a refused registration token, seconds; absent when none, and never for a runner systemd has neither enabled nor seen
  running, so a disabled runner that is still retrying keeps it),
  `aidenhq_unit_declared{scope="user",unit}` (the enabled set an apply keeps running, so `CiRunnerUnitMissing` ignores a
  retired unit), `aidenhq_fleet_draining`,
  `aidenhq_container_running|restarts|unhealthy{id,project,service,name}`, `aidenhq_apply_failed{n,reason,log,health}`,
  the Docker disk breakdown `aidenhq_docker_{images,containers,build_cache,volumes}_{size,reclaimable}_bytes` (from
  `docker system df`, capped at 10 s) and `aidenhq_docker_collect_ok`. `docker system df` walks every image, container and
  volume, so its answer is cached for 5 minutes (`data/modules/monitoring/docker-df.json`): a run inside that window
  republishes the cache without calling Docker, and each `docker.prom` write does not cost a full walk. When a read past
  the window times out or errors the file is still rewritten, with `aidenhq_docker_collect_ok 0` and no size series at
  all: the last bytes never stay on the scrape as if they were current, a fresh install still gets a file whose mtime
  `HostMetricsStale` reads, and 0 means the breakdown is unknown, never that Docker holds nothing (that would be a size of
  0). A read that succeeds still publishes even if writing the cache fails, and a successful read with no Build Cache row
  is not a failure: nothing cached means the build-cache ceiling holds.
  A planned drain records the units it stopped in `data/fleet-paused.json`, and `aidenhq_unit_failed` stays 0 for them while
  that record exists: `UnitFailed` and `CiRunnersDown` (which also needs `aidenhq_fleet_draining == 0`) page on a crash, not on
  maintenance. They and `CiRunnerRestartLooping` (a unit flipping out of `active` over and over, which `Restart=always`
  makes invisible to `UnitFailed`; a refused registration token backs off in `ExecStartPre`, so a refusal across every
  runner also leaves `CiRunnersDown` nothing active long enough to fire) also need a fresh `units.prom` (written within 3
  minutes), so a dead exporter is a freshness alert and never reads as "0 active" or "16 failed".

No secrets or ids in labels.

## Alerts and routing

Rules are `modules/monitoring/prometheus/rules.yml`: `DiskSpaceLow` (over 80%, or on course to fill in 24 h), `DiskNearlyFull`
(over 95%; a warning too: the kernel's disk sweep tightens itself over 80%, and disk never reaches the owner), `MemoryPressure`, `OomKill`, `HostMetricsStale`, `HostMetricsExporterStale`, `ContainerRestarting`,
`CoreServiceDown` (an aidenhq-project container other than `ci-runner`, the `aidenhq-kernel` or `aidenhq-computers` user unit, or
the board not answering Prometheus, for 5 minutes, **critical**), `ApplyFailed` (the newest apply generation failed its health
check or was refused at validation, **critical**), `UnitFailed`, `CiRunnersDown`, `CiRunnerRestartLooping` (a runner unit that
keeps dropping out of `active` and isn't staying up: `Restart=always` never makes `UnitFailed`, and a unit backing off a
refused registration is `activating` rather than `active`, so the loop is named by unit; a refusal across every runner also
empties `CiRunnersDown`'s active count), `CiRunnerBackoff` (a runner whose persisted wait is at the 60-second cap and has
held it for ten minutes: the wait is the loop's own state, so it fires even when a scrape misses every brief active
interval between backoffs, while a wait that has since cleared breaks the condition and raises nothing), `CiRunnerUnitMissing` (a runner unit seen in
the last day and gone now, named by unit), `JobOverlong`, `GatewaySpendNearCap`, `CiReviewSpendNearCap` and `AppsCpuStarved` (an
`app-*` container's own CPU pressure over 20% while the host's is over 15%; the alert names the app's project, and host
pressure alone never fires it). Only `CoreServiceDown` and `ApplyFailed` are critical.

The rules' test is `modules/monitoring/prometheus/rules.test.yml` (a host-only spike fires nothing, an `app-*` match carries its
project, an app at its own limit with an idle host does not fire, a restart-looping runner fires and a steady one, one going
job to job, or one whose fleet is draining, doesn't; a runner backing off at the cap fires `CiRunnerBackoff`, and a first
refusal, eight minutes at the cap, a backoff that has since cleared, a runner with no backoff and a drain do not). The
`checks` job of `.github/workflows/ci.yml` runs `promtool check rules rules.yml` and `promtool test rules
rules.test.yml` on every pull request head and push to main, with the image
`modules/monitoring/prometheus/Dockerfile` pins at the commit the change is based on (a PR's base, main for a merge train,
main's own tree on a push to main), never the head's: the step runs the image's code, so a PR that could choose the image
could point `promtool` at something that exits 0. It must be digest-pinned, and the workflow holds no version of its own.
Locally it is the same image:
`docker run --rm --entrypoint /bin/promtool -v "$PWD/modules/monitoring/prometheus:/rules:ro" -w /rules prom/prometheus:v3.16.0@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06 check rules rules.yml`
(and `test rules rules.test.yml`).

Alertmanager has one receiver: the fleet-steward service's `POST /alerts` (`modules/fleet-steward/service/src/alerts.ts`), with
`send_resolved`. The service keeps what is firing and its detector gets an `alert` check group, so an alert takes the detector's
existing path: one incident per alert, a "Fleet Ops: check" task filed once, the incident recovered (and a task filed once more)
when the alert resolves. The service runs the detector at once when an alert arrives. So the module requires `fleet-steward`.

The webhook is one-shot news, so each tick the `alert` group also reads Alertmanager's `GET /api/v2/alerts` and reconciles. An
alert no longer in that list recovers even when its whole label set vanished (`aidenhq_apply_failed` is exported under each
generation's `n`, `reason`, `log` and `health`, so a later generation replaces a failed one's series, and the failed apply is
itself restarting the service that would have taken the resolve). One still in the list stays open, silenced and inhibited
included: a silence stops notifications, not the alert. When Alertmanager cannot be asked the webhook's record stands, so nothing
recovers on a guess.

A newly firing critical alert also sends one owner line through `notify` (`Monitoring: <rule> (critical): <fixed sentence>`).
Label and annotation text never reaches the owner (an app can choose names that appear in labels): the line is the rule's name
and a fixed sentence per critical rule. In the detector's incident the alert's text is fenced with the SDK's `fence()`, after a
first line built from slugs.

## Access

Every listener is loopback or in-network. Grafana is published on `127.0.0.1:3131` and reaches the tailnet through the host's
`tailscale serve`; `scripts/host-serve.ts` allows it next to Paperclip and the board (trusted services that sign people in;
never an app). Grafana: admin user `admin`, password in the vault (`grafana_admin_password`, made by compile), anonymous access
and sign-up off, update checks and plugin installs off. The datasource and the dashboards (Node Exporter Full, stock from
rfmoz/grafana-dashboards, Apache-2.0; Containers and Fleet, ours) are provisioned from git and cannot be edited in the UI.

`monitoring_token` (made by compile) is the one token Prometheus scrapes with and Alertmanager posts with; it opens only the
board's two monitoring routes. The board's internal token opens neither. `scripts/verify-security.sh` checks the ports,
Grafana's sign-in, node-exporter running as nobody with read-only mounts, the token split, and that Prometheus, Alertmanager,
cAdvisor and mcp-grafana are on the monitoring networks only.

## Agents

grafana-mcp (`modules/grafana`) can point at this Grafana: `settings.grafana_source: local`. It then talks to the module's
`mcp-grafana` (Grafana's own MCP server, `--disable-write`) with no OAuth sign-in, on a network only the two share. Keep the
service account at Viewer. One-time: in Grafana, make a service account with the Viewer role and a token, put the token alone
(`glsa_...`) in the vault's `grafana_service_account_token` (compile creates the file empty), enable the `grafana` module and
apply. Fleet Ops has `grafana?: read` (granted whenever the grafana module is on); another agent gets it in its own definition
(`connections: { grafana: read }`).

## Enabling

1. Instance: add `monitoring` to `modules:` (and optionally `monitoring_retention`, `grafana_root_url`), commit, apply. Compile
   creates the secrets and `data/monitoring/*`; apply starts the services and the `aidenhq-host-metrics` timer.
2. Tailnet: `tailscale serve --bg --https=8444 http://127.0.0.1:3131` on the host (the operator is tailscaled's operator, no
   sudo), then set `grafana_root_url: https://<host>.<tailnet>.ts.net:8444`.
3. Optional (agents read metrics): the service account token above, the `grafana` module with `grafana_source: local`.

No sudo is needed: every metric is read as the owner's user. Turning the module off removes the services and the timer.

# grafana

## What it does

Lets the Engineers read metrics and dashboards: the host's disk, memory and containers, and the fleet's queue, spend and
approvals (Prometheus through Grafana), plus logs. It is Grafana's own MCP server passed through.

## Connect

Setting `grafana_source` picks the mode:

- `cloud` (default): board, Settings, Connections: press Connect, give your stack's address (`grafana_url`,
  `*.grafana.net`) and allow access.
- `local`: enable the `monitoring` module and put a Viewer service account token in the vault
  (`grafana_service_account_token`). No sign-in.

## What agents get

The `grafana` connection (61 read tools, 49 of them `named`): `query_prometheus`, `list_prometheus_metric_names`,
`list_datasources`, `search_dashboards`, `get_dashboard_summary` and more. Two destructive tools are reviewed and need a
grant naming them: `alerting_manage_routing`, `grafana_api_request`.

## New installs

Not in the default bundle. Unconnected, a banner says the Engineers can't read logs and metrics.

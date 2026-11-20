# clickhouse

## What it does

Lets the Engineers query your ClickHouse Cloud data: ClickHouse's MCP server passed through as you, with read-only
SELECT queries.

## Connect

Board, Settings, Connections: press Connect ClickHouse and allow access. Setting `clickhouse_mcp_url` defaults to
ClickHouse's hosted server.

## What agents get

The `clickhouse` connection, all read: `get_organizations`, `get_services_list`, `get_service_details`, `list_databases`,
`list_tables` and `run_select_query` (one read-only SELECT).

## New installs

Not in the default bundle. Until you connect, the board shows a banner saying the Engineers can't query it, and calls
say how to connect.

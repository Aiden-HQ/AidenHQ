# warehouse

## What it does

The shared Postgres warehouse every source ingests into (Slack, GitHub, Jira, Google Drive, HubSpot, meetings,
security), so agents can query across them. It is an app, and its point `warehouse.sources` is how each source module
contributes its schema and views.

## Connect

Nothing to connect. It needs `product_repo` (the `owner/repo` of the AidenHQ product this instance runs), where the app's
code lives.

## What agents get

Read access through apps' `warehouse_query`, with `source_new` and `source_ack` for the source tools (see
`apps-platform`). Each app with `database: warehouse` gets its own role and schema. Source summaries are a pointer,
never evidence: agents read the live record before acting.

## New installs

In the default bundle. A fresh warehouse is empty: each source fills its own schema once that module is connected.

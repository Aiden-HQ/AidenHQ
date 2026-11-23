# warehouse

## What it does

The shared Postgres warehouse every source ingests into (Slack, GitHub, Jira, Google Drive, HubSpot, meetings,
security), so agents can query across them. It is an app, and its point `warehouse.sources` is how each source module
contributes its schema and views.

It also runs task search (`search/`, the `warehouse-search` service; [design](../../docs/design/task-search.md)): one row
per task in `src_tasks.task_search` (keywords and a meaning embedding), and the board's search field over them, by what a
task was about, a file it touched or an identifier, done ones included. Setting `search_summaries` (`on`/`off`, default
`off`) adds a short model-written summary and tags to each task's row.

## Connect

Nothing to connect. It needs `product_repo` (the `owner/repo` of the AidenHQ product this instance runs), where the app's
code lives.

## What agents get

Read access through apps' `warehouse_query`, with `source_new` and `source_ack` for the source tools (see
`apps-platform`). Each app with `database: warehouse` gets its own role and schema. Source summaries are a pointer,
never evidence: agents read the live record before acting. Task search is the board's only: its rows grant agents nothing.

## New installs

In the default bundle. A fresh warehouse is empty: each source fills its own schema once that module is connected.
Task search indexes from the first task: each task's row appears within about a minute of it changing, and the first pass
embeds every existing task once. Those embeddings are the module's one spend without the owner turning anything on: cents
(gemini-embedding-001 through the model gateway, as a source writer, under the install's spend limit). Summaries are off.
On an install upgrading to it, deploy the warehouse once and apply again (the image brings pgvector); until then the search
field says search is unavailable and shows every task.

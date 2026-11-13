# Warehouse (Postgres 17)

Shared Postgres for curated fleet data. Compose: `compose.yaml`. Roles: `init/01-roles.sql` (first init only) and
`sources.sql` (idempotent; `ops/warehouse-sources.sh`, run by every apply).

## Access
- `readonly` (LOGIN): member of `agents_open`, SELECT on curated views; read-only transactions, 15s statement timeout.
  apps-mcp's `warehouse_query` and `source_new` connect as it. Every source is readable by every agent with these tools,
  Slack DMs and private channels included (owner, 2026-11-11); `channel_type` stays a column so a gate can return.
  A future restricted tier gets its own LOGIN role, never `SET ROLE` (agents send their own SQL; a member of a
  restricted role could switch to it).
- `writers`: parent of per-source writer roles (`src_slack`, `src_github`, `src_jira`, `src_meetings`, `src_docs`), each
  owning its schema.
- Restricted schemas (e.g. `people_data`) grant only to their own role.

## Schemas
- `src_<source>`: ingested data, owned by its writer role, which creates its tables and views at start. Every source row
  has `first_seen_at`, `ingested_at`, `seq` (from `src_meta.seq`, bumped on any change) and `baseline` (written by a
  first sync: not a recent change). Field changes after the baseline go to `src_<source>.change`. Long text is capped at
  4 KB with a `<field>_truncated` flag and the row's url; meeting notes are kept whole (200 KB cap), other long documents
  only as metadata + a cheap summary + the link.
- `src_meta`: `ingest_run` (one row per ingest pass: source, scope, rows, error), `cursor` (each consumer agent's
  position per view, written by apps-mcp), `seq`, and people: `person`, `person_identity` (source user ids linked to a
  person, proposed by apps-mcp on an exact email match only; approval is the owner's) and the view `people_identities`.
- `app_<app>`: data owned by an app.
- Expose data through curated views with a `COMMENT ON VIEW`.

## Backups
- Nightly at 02:00 UTC `pg_dump -Fc` to the Docker volume `app-warehouse_backups` as `warehouse-YYYY-MM-DD.dump`.
  After a restart it dumps promptly when there is no dump for the current UTC day, waits for Postgres to accept
  connections, and retries a failed dump instead of exiting. Keeps about 7 days (a successful dump removes files older
  than 6 days). Fetch one on the host: `docker run --rm -v app-warehouse_backups:/b:ro -v "$PWD":/out postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f cp /b/warehouse-YYYY-MM-DD.dump /out/` (list them with `ls /b` the same way).
- Restore (stateful; needs the owner's "apply"). Dump first, then:
  `docker compose -f modules/warehouse/apps/warehouse/compose.yaml exec backup pg_restore -h postgres -U warehouse -d warehouse --clean --if-exists /backups/<file>.dump`

## Upgrades
- Patch and digest bumps: normal deploy.
- Major versions (e.g. 17 to 18): The owner's "apply", after a fresh dump.

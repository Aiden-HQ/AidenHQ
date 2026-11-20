# primer

## What it does

Primer keeps documents with their versions and comments. Agents publish design docs and write-ups to it and read the
comments people leave on them. A digest routine summarizes activity each morning.

## Connect

Nothing to do. Setting `primer_mode` picks where Primer lives:

- `self-host` (default): this server runs Primer and its database, connected from the first apply. Its connector signs in
  as the agent user "AidenHQ agents" (acting via the owner) with a token the module generates and seeds at every start
  (`server/start.ts`). Documents open for AidenHQ admins at the board's address on port 8447 (the module door,
  [docs/design/app-doors.md](../../docs/design/app-doors.md#the-module-door)), signed in as on the board, in every exposure
  mode. With `edge`, `primer_host` (and with `app_login` `access` or `header-jwt` its audience `primer_host_aud`) shares it
  with people beyond the admins at that address instead.
- `connect`: your organization's Primer. Pick it on the board (`#/setup/primer`), give its MCP address
  (`primer_mcp_url`) and sign in; agents act as you there.

## What agents get

The `primer` connection (22 read tools, 13 of them `named`; 17 writes; 2 destructive).

- Read: `primer_whoami`, `primer_get_document`, `primer_list_documents`, `primer_find_document`, `primer_get_comments`,
  `primer_list_versions`, `primer_get_digest` and more.
- Write: `primer_create_document`, `primer_add_version`, `primer_reply_to_thread`, `primer_resolve_thread` and more.
- Destructive (reviewed, named grants only): `primer_add_collaborator`, `primer_purge_personal_records`.

## New installs

In the default bundle and required by `agent-builder` (the Agent Architect's design reviews are Primer documents).
Self-hosted and connected with no setup: every install builds Primer from source (the commit `server/Dockerfile` pins) and
runs its Postgres. The `primer-digest` routine (every morning, 08:00) starts paused under quiet start.

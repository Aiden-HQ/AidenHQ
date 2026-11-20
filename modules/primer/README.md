# primer

## What it does

Primer keeps documents with their versions and comments. Agents publish design docs and write-ups to it and read the
comments people leave on them. A digest routine summarizes activity each morning.

## Connect

Board, Settings, Primer, about 3 minutes. Setting `primer_mode` picks where it lives:

- `connect` (default): give your organization's Primer MCP address (`primer_mcp_url`) and sign in. Press Connect.
- `self-host`: this server runs Primer and its database (`primer_host`, and with `app_login` `access` or `header-jwt`
  the audience `primer_host_aud`). It needs one apply and the instance's edge.

## What agents get

The `primer` connection (22 read tools, 13 of them `named`; 17 writes; 2 destructive).

- Read: `primer_whoami`, `primer_get_document`, `primer_list_documents`, `primer_find_document`, `primer_get_comments`,
  `primer_list_versions`, `primer_get_digest` and more.
- Write: `primer_create_document`, `primer_add_version`, `primer_reply_to_thread`, `primer_resolve_thread` and more.
- Destructive (reviewed, named grants only): `primer_add_collaborator`, `primer_purge_personal_records`.

## New installs

In the default bundle. Unconnected, a banner says the agents can't read or publish documents. The `primer-digest`
routine (every morning, 08:00) starts paused under quiet start.

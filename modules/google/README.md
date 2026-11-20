# google

## What it does

Aiden reads your Google Workspace, read-only, to brief you and follow up: Calendar events, Drive and Docs text, and Gmail
threads. Drive metadata also lands in the warehouse as `src_docs`.

## Connect

Board, Settings, Google (`#/setup/google`), about 5 minutes in the Google Cloud console. Create a Desktop-app OAuth
client, paste its client id and secret (`google_client_id`, `google_client_secret`), then press Connect Google from the
board's loopback address (or paste the redirected address back). Google only accepts a named address or `127.0.0.1` for
sign-in. By hand: `scripts/google-auth.sh <client.json>`.

## What agents get

The `google_workspace` connection, all read: `calendar_list_events`, `calendar_search_events`, `calendar_get_event`,
`drive_list_recent_files`, `drive_list_meeting_documents`, `drive_search_files`, `drive_read_file`, `gmail_search`,
`gmail_read_thread`, `docs_read`. Glean finds Drive documents faster; read them here for the exact current text.

## New installs

In the default bundle. Until you connect, agents have no calendar or mail context and the tools say how to connect.

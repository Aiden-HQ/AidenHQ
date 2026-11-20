# meetings

## What it does

Meeting memory: transcripts and your Obsidian notes vault, published by the Researcher's meeting scan. Meetings and
their full notes also land in the warehouse (`src_meetings`).

## Connect

Needs `google`. Set `VAULT_DIR` (and `KNOWLEDGE_BASES` for reference docs) in the host's `.env`, then run
`ops/apply-config.sh`. Check with `scripts/healthcheck.sh`.

## What agents get

The `ops_mcp` connection.

- Read: `obsidian_search`, `obsidian_read`, `obsidian_read_document_map`, `voice_note_read`, `knowledge_list`,
  `knowledge_index`, `knowledge_search`, `knowledge_read`, `source_read`, `sync_cursor_get`.
- Write: `transcripts_scan`, `meeting_match`, `meeting_resolve`, `meeting_publish`, `meeting_note_correct`,
  `source_register_drive_document`, `source_mark_failed`, `sync_cursor_set`, `voice_note_add`.

## New installs

In the default bundle. The `meeting-scan` routine (every 15 minutes, weekdays 08:00 to 20:00, or by webhook) starts
paused under quiet start.

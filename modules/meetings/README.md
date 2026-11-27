# meetings

## What it does

Nora (the `meetings` agent) keeps your meeting record: transcripts and Google Meet documents become notes in your Obsidian
notes vault, matched to the calendar (the meeting scan), and your own action items from them become one task each (meeting
action items). Meetings and their full notes also land in the warehouse (`src_meetings`).

## Connect

Needs `google`. Set `VAULT_DIR` (and `KNOWLEDGE_BASES` for reference docs) in the host's `.env`, then run
`ops/apply-config.sh`. Check with `scripts/healthcheck.sh`.

## What agents get

The `ops_mcp` connection. Nora holds the scan's tools and the `ops-key` role (ops-mcp acts as her in Paperclip); the
Researcher keeps the reads, `meeting_note_correct` and the voice-note tools.

- Read: `obsidian_search`, `obsidian_read`, `obsidian_read_document_map`, `voice_note_read`, `knowledge_list`,
  `knowledge_index`, `knowledge_search`, `knowledge_read`, `source_read`, `sync_cursor_get`.
- Write: `transcripts_scan`, `meeting_match`, `meeting_resolve`, `meeting_publish`, `meeting_note_correct`,
  `source_register_drive_document`, `source_mark_failed`, `sync_cursor_set`, `voice_note_add`.

## New installs

In the default bundle. The `meeting-scan` routine (every 15 minutes, weekdays 08:00 to 20:00, or by webhook) and the
`meeting-actions` routine (every 30 minutes, 08:00 to 20:00) start paused under quiet start.

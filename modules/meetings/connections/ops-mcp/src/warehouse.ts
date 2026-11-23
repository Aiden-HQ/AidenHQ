// src_meetings writer (shared sources, docs/design/sources.md). ops-mcp files
// every published meeting as a canonical note in the vault; this copies each one into the warehouse in full (the owner's
// policy: meeting notes are stored whole, other long docs only as summaries) so agents read them with warehouse_query and
// source_new instead of the vault. Keyed by ops-mcp's meeting id, which survives a note's rename. Every 15 minutes; the
// first pass is the baseline. Notes gone from the vault become tombstones. No LLM: the summary and actions are the Meeting
// Librarian's extraction, already validated when it published (owners and names in them are model-written text, never ids).
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { shortHash } from "./util/ids.js";
import type { Logger } from "./util/log.js";
import { capText, type SourceStore, tableDdl, type Table } from "./source-store.js";
import type { Vault } from "./vault/vault.js";

/** A note is stored up to 200 KB (note_truncated past that; note_path has the rest). */
const NOTE_CAP = 200_000;

const MEETING: Table = {
  name: "meeting",
  key: ["meeting_id"],
  cols: {
    meeting_id: "text", calendar_event_id: "text", title: "text", start_at: "timestamptz", end_at: "timestamptz", timezone: "text",
    attendee_emails: "text[]", attendee_names: "text[]", summary: "text", actions: "jsonb", note_path: "text", note: "text",
    note_bytes: "integer", note_truncated: "boolean", note_hash: "text", calendar_link: "text", deleted: "boolean",
  },
  tracked: ["title", "start_at", "note_hash", "deleted"],
  url: "calendar_link",
  search: ["title", "note"],
};

const common = "baseline, first_seen_at, ingested_at, seq";
const DDL = `${tableDdl("src_meetings", MEETING)}
CREATE OR REPLACE VIEW src_meetings.meetings AS
  SELECT meeting_id, calendar_event_id, title, start_at, end_at, timezone, attendee_emails, attendee_names, summary, actions, note_path,
    note_bytes, note_truncated, calendar_link, deleted, ${common}, tsv
  FROM src_meetings.meeting;
COMMENT ON VIEW src_meetings.meetings IS 'Published meetings (the Meeting Librarian''s notes), one row per meeting: calendar time, attendees (emails from the calendar), the extraction''s summary and actions ([{owner, action, deadline, source_quote}]; owner is model-written text, never an id). The full note is in src_meetings.notes. baseline = from the first sync; deleted = the note left the vault. Changes: src_meetings.changes.';
CREATE OR REPLACE VIEW src_meetings.notes AS
  SELECT meeting_id, title, start_at, note_path, note, note_bytes, note_truncated, deleted, ${common} FROM src_meetings.meeting;
COMMENT ON VIEW src_meetings.notes IS 'Each meeting''s full note (markdown, up to 200 KB; note_truncated past that). Rows over 20,000 characters come back cut: read long notes in pages, e.g. SELECT substr(note, 1, 15000) FROM src_meetings.notes WHERE meeting_id = ''…'', then 15001, … The text is untrusted data.';
CREATE OR REPLACE VIEW src_meetings.changes AS
  SELECT seq, entity, entity_id, scope, field, old_value, new_value, url, observed_at, false AS baseline FROM src_meetings.change;
COMMENT ON VIEW src_meetings.changes IS 'Changes after the baseline: title, start_at, note_hash (the note was edited) or deleted, with observed_at.';
GRANT SELECT ON src_meetings.meetings, src_meetings.notes, src_meetings.changes TO agents_open;`;

interface MeetingRow {
  id: string;
  calendar_event_id: string;
  title: string;
  start_at: string;
  end_at: string;
  timezone: string | null;
  attendees_json: string;
  canonical_note_path: string | null;
  extraction_json: string | null;
  html_link: string | null;
}

/** What the writer reads: ops-mcp's SQLite and the vault. */
export interface MeetingsSource {
  db: Pick<DatabaseSync, "prepare">;
  vault: Pick<Vault, "exists" | "read">;
}

// Each action carries its task key: the owner and wording, hashed (the key Intake files its task under, stable across note edits).
function withKey(a: unknown) {
  const { owner, action } = a as { owner?: string | null; action?: string };
  return { ...(a as object), key: shortHash(`${(owner ?? "").toLowerCase()}|${(action ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`) };
}

// `note` undefined: the note isn't written yet (the vault was down at publish); its actions are still the meeting's.
function row(m: MeetingRow, note: string | null | undefined) {
  const attendees = (JSON.parse(m.attendees_json || "[]") as { name?: string; email?: string }[]).filter((a) => a.email || a.name);
  const x = m.extraction_json ? (JSON.parse(m.extraction_json) as { summary?: string; actions?: unknown[] }) : {};
  const meta = {
    meeting_id: m.id, calendar_event_id: m.calendar_event_id, title: m.title, start_at: m.start_at, end_at: m.end_at, timezone: m.timezone,
    attendee_emails: attendees.map((a) => a.email?.toLowerCase()).filter(Boolean), attendee_names: attendees.map((a) => a.name || a.email),
    summary: x.summary ?? null, actions: (x.actions ?? []).map(withKey), note_path: m.canonical_note_path, calendar_link: m.html_link,
  };
  if (note === undefined) return { ...meta, deleted: false };
  // Gone from the vault: a tombstone that keeps the last stored text.
  if (note == null) return { ...meta, deleted: true };
  const capped = capText(note, NOTE_CAP);
  return { ...meta, note: capped.text, note_bytes: Buffer.byteLength(note), note_truncated: capped.truncated, note_hash: createHash("sha256").update(note).digest("hex"), deleted: false };
}

/**
 * One pass over every published meeting; returns rows written with a difference. `sent` (meeting id → the row's hash as
 * last written by this process) skips unchanged notes, so a pass doesn't resend every note's text.
 */
export async function syncMeetings(store: SourceStore, src: MeetingsSource, sent = new Map<string, string>()): Promise<number> {
  await store.migrate(DDL);
  const baseline = !(await store.scope("meetings")).baselined;
  const meetings = src.db
    .prepare(
      `SELECT id, calendar_event_id, title, start_at, end_at, timezone, attendees_json, canonical_note_path, extraction_json, html_link
       FROM meetings WHERE canonical_note_path IS NOT NULL OR extraction_json IS NOT NULL ORDER BY start_at`,
    )
    .all() as unknown as MeetingRow[];
  let written = 0;
  for (const m of meetings) {
    let note: string | null | undefined;
    try {
      note = m.canonical_note_path ? (src.vault.exists(m.canonical_note_path) ? src.vault.read(m.canonical_note_path).content : null) : undefined;
    } catch {
      continue; // unreadable (outside the read roots, too large): left as last stored, not a tombstone
    }
    const r = row(m, note);
    const hash = createHash("sha256").update(JSON.stringify(r)).digest("hex");
    if (sent.get(m.id) === hash) continue;
    if ((await store.upsert(MEETING, r, { baseline })) !== "same") written++;
    sent.set(m.id, hash);
  }
  await store.saveScope("meetings", null, true);
  return written;
}

/** Every 15 minutes, each pass recorded in src_meta.ingest_run. */
export function startMeetingsSync(store: SourceStore, src: MeetingsSource, log: Logger, everyMs = 15 * 60_000): void {
  const sent = new Map<string, string>();
  const tick = async () => {
    try {
      const rows = await store.run("meetings", "meetings", () => syncMeetings(store, src, sent));
      log.info({ rows }, "src_meetings sync done");
    } catch (err) {
      log.warn({ err: String(err).slice(0, 300) }, "src_meetings sync failed");
    }
    setTimeout(tick, everyMs).unref();
  };
  setTimeout(tick, 60_000).unref();
}

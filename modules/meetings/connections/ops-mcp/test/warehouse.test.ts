import { expect, it } from "bun:test";
import { openDb } from "../src/db/db.js";
import type { SourceStore } from "../src/source-store.js";
import { syncMeetings } from "../src/warehouse.js";

// The writer side against a fake store (the SQL is the shared source-store's): what lands, with which baseline flag.
function fakeStore() {
  const scopes = new Map<string, boolean>();
  const writes: { row: Record<string, any>; baseline: boolean }[] = [];
  const store = {
    migrate: async () => undefined,
    scope: async (s: string) => ({ baselined: !!scopes.get(s), cursor: null }),
    saveScope: async (s: string, _c: string | null, baselined = false) => void scopes.set(s, baselined || !!scopes.get(s)),
    upsert: async (_t: unknown, row: Record<string, any>, o: { baseline: boolean }) => (writes.push({ row, baseline: o.baseline }), "new"),
  };
  return { store: store as unknown as SourceStore, writes };
}

it("src_meetings: the first pass is a baseline of every published note in full; later edits are changes; a note gone from the vault is a tombstone", async () => {
  const db = openDb(":memory:");
  const insert = db.prepare(
    `INSERT INTO meetings (id, calendar_provider, calendar_event_id, title, start_at, end_at, attendees_json, match_status, canonical_note_path, extraction_json, created_at, updated_at)
     VALUES (?, 'google', ?, ?, '2026-11-10T09:00:00Z', '2026-11-10T09:30:00Z', ?, 'matched', ?, ?, 'x', 'x')`,
  );
  const extraction = JSON.stringify({ summary: "Agreed the launch", actions: [{ owner: "Ann", action: "Ship it", deadline: "Friday" }] });
  insert.run("mtg_1", "ev1", "Launch sync", JSON.stringify([{ name: "Ann", email: "Ann@X.com" }]), "Meetings/a.md", extraction);
  insert.run("mtg_2", "ev2", "1:1", "[]", "Meetings/b.md", null);
  const notes = new Map([["Meetings/a.md", "# Launch sync\n" + "x".repeat(250_000)], ["Meetings/b.md", "# 1:1"]]);
  const vault = { exists: (p: string) => notes.has(p), read: (p: string) => ({ path: p, content: notes.get(p)!, version: "" }) };
  const { store, writes } = fakeStore();
  const sent = new Map<string, string>();

  await syncMeetings(store, { db, vault }, sent);
  expect(writes).toHaveLength(2);
  expect(writes.every((w) => w.baseline)).toBe(true);
  expect(writes[0]!.row).toMatchObject({
    meeting_id: "mtg_1", attendee_emails: ["ann@x.com"], summary: "Agreed the launch", actions: [{ owner: "Ann", action: "Ship it" }],
    note_truncated: true, note_bytes: 250_014, deleted: false,
  });
  expect(Buffer.byteLength(writes[0]!.row.note)).toBe(200_000);

  writes.length = 0;
  await syncMeetings(store, { db, vault }, sent);
  expect(writes).toHaveLength(0); // unchanged notes aren't resent

  notes.set("Meetings/b.md", "# 1:1\nedited");
  notes.delete("Meetings/a.md");
  await syncMeetings(store, { db, vault }, sent);
  expect(writes.map((w) => [w.row.meeting_id, w.baseline, w.row.deleted])).toEqual([["mtg_1", false, true], ["mtg_2", false, false]]);
  expect(writes[0]!.row).not.toHaveProperty("note"); // the tombstone keeps the last stored text
});

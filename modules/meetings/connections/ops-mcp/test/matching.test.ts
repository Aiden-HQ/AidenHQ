import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { decide, scoreCandidates } from "../src/matching/score.js";
import type { SourceEvidence } from "../src/matching/types.js";
import { parseFilename, parseMeetDocTitle } from "../src/sources/parse.js";
import { event, people } from "./helpers.js";

const cfg = ConfigSchema.parse({
  timezone: "Europe/Madrid",
  self: { names: ["Alex"], emails: ["alex@example.com"] },
  transcripts: { roots: ["/x"] },
  vault: { root: "/v", read_roots: ["a"], write_roots: ["a"] },
  routing: { config_path: "/r.yaml" },
  paperclip: { base_url: "http://p:3100" },
});

const ev = (e: Partial<SourceEvidence>): SourceEvidence => ({ titleHints: [], text: "", peopleHints: [], ...e });
const at = (iso: string) => Date.parse(iso);
const run = (e: SourceEvidence, events: Parameters<typeof scoreCandidates>[1]) => decide(scoreCandidates(e, events, cfg), cfg);

const omsNimbus = event({
  id: "oms",
  title: "OMS <> Nimbus Integration",
  start: "2026-10-04T14:00:00+02:00",
  end: "2026-10-04T14:30:00+02:00",
  attendees: people("Alice", "Bob", "Alex"),
});

describe("filename parsing", () => {
  it("parses whisper-style names with and without time", () => {
    const a = parseFilename("/t/Jane-Doe-2026-08-17_22-30-01.txt", cfg.transcripts.filename_patterns, "Europe/Madrid");
    expect(a.title).toBe("Jane Doe");
    expect(new Date(a.startMs!).toISOString()).toBe("2026-08-17T20:30:01.000Z");
    const b = parseFilename("/t/Acmenet-Roadmap-Huddle-2-2026-09-17.txt", cfg.transcripts.filename_patterns, "Europe/Madrid");
    expect(b).toEqual({ title: "Acmenet Roadmap Huddle 2", date: "2026-09-17" });
    const c = parseFilename("/t/2026-10-04_1401.md", cfg.transcripts.filename_patterns, "Europe/Madrid");
    expect(c.date).toBe("2026-10-04");
    expect(new Date(c.startMs!).toISOString()).toBe("2026-10-04T12:01:00.000Z");
  });
});

describe("Meet document titles", () => {
  it("parses transcript and Gemini note titles", () => {
    const a = parseMeetDocTitle("OMS <> Nimbus Integration (2026-10-04 14:00 GMT+02:00) - Transcript", "Europe/Madrid");
    expect(a.title).toBe("OMS <> Nimbus Integration");
    expect(new Date(a.startMs!).toISOString()).toBe("2026-10-04T12:00:00.000Z");
    const b = parseMeetDocTitle("Wallet Weekly - 2026/10/04 14:45 CEST - Notes by Gemini", "Europe/Madrid");
    expect(b.title).toBe("Wallet Weekly");
    expect(new Date(b.startMs!).toISOString()).toBe("2026-10-04T12:45:00.000Z");
    expect(parseMeetDocTitle("Random doc", "Europe/Madrid").startMs).toBeUndefined();
    // Named US/other timezones (the meeting organizer's zone), not the user's.
    const c = parseMeetDocTitle("Confirmed- Northwind <> Acme Weekly Sync - 2026/10/05 09:30 EDT - Notes by Gemini", "Europe/Madrid");
    expect(c.title).toBe("Confirmed- Northwind <> Acme Weekly Sync");
    expect(new Date(c.startMs!).toISOString()).toBe("2026-10-05T13:30:00.000Z");
    expect(new Date(parseMeetDocTitle("X - 2026/01/12 10:00 PST - Notes by Gemini", "Europe/Madrid").startMs!).toISOString()).toBe("2026-01-12T18:00:00.000Z");
  });
});

describe("meeting matching", () => {
  it("exact temporal match with attendee evidence auto-matches", () => {
    const d = run(ev({ startMs: at("2026-10-04T14:03:00+02:00"), text: "Alice: hi Bob, let's talk about Nimbus wallets", titleHints: ["Nimbus wallet integration"] }), [omsNimbus]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("oms");
    expect(d.score).toBeGreaterThanOrEqual(75);
  });

  it("back-to-back meetings without evidence need review", () => {
    const weekly = event({ id: "weekly", title: "Wallet Weekly", start: "2026-10-04T14:45:00+02:00", end: "2026-10-04T15:15:00+02:00", attendees: people("Carol", "Alex") });
    const partner = event({ id: "partner", title: "Partner Wallet Call", start: "2026-10-04T15:00:00+02:00", end: "2026-10-04T15:30:00+02:00", attendees: people("Dan", "Alex") });
    const d = run(ev({ startMs: at("2026-10-04T15:01:00+02:00"), text: "let's discuss the wallet" }), [weekly, partner]);
    expect(d.status).toBe("needs_review");
    expect(d.chosen).toBeUndefined();
    expect(d.candidates.map((c) => c.event_id)).toEqual(["partner", "weekly"]);
  });

  it("ambiguous strong candidates go to review even above the auto threshold", () => {
    const a = event({ id: "a", title: "OMS Nimbus Integration", start: "2026-10-04T14:00:00+02:00", end: "2026-10-04T14:30:00+02:00", attendees: people("Alice", "Alex") });
    const b = event({ id: "b", title: "OMS Nimbus Integration (internal)", start: "2026-10-04T14:00:00+02:00", end: "2026-10-04T14:30:00+02:00", attendees: people("Alice", "Alex") });
    const d = run(ev({ startMs: at("2026-10-04T14:00:00+02:00"), titleHints: ["OMS Nimbus Integration"], text: "alice" }), [a, b]);
    expect(d.candidates[0]!.score).toBeGreaterThanOrEqual(75);
    expect(d.status).toBe("needs_review");
  });

  it("ignores declined, cancelled and all-day events", () => {
    const declined = event({ ...omsNimbus, id: "declined", attendees: [{ email: "alex@example.com", self: true, response_status: "declined" }] });
    const cancelled = event({ ...omsNimbus, id: "cancelled", status: "cancelled" });
    const allDay = event({ ...omsNimbus, id: "allday", all_day: true });
    expect(scoreCandidates(ev({ startMs: at("2026-10-04T14:00:00+02:00") }), [declined, cancelled, allDay], cfg)).toEqual([]);
  });

  it("matches a shared meeting document to an event the user declined", () => {
    const rtb = event({ id: "rtb", title: "OMS RTB (weekly)", start: "2026-10-05T19:00:00+02:00", end: "2026-10-05T19:30:00+02:00", attendees: [...people("Sam"), { email: "alex@example.com", self: true, response_status: "declined" }] });
    const family = event({ id: "family", title: "Family Time (ask before booking)", start: "2026-10-05T19:00:00+02:00", end: "2026-10-05T20:00:00+02:00" });
    const d = run(ev({ startMs: at("2026-10-05T19:02:00+02:00"), filenameTitle: "OMS RTB (weekly)", driveFileId: "doc1" }), [family, rtb]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("rtb");
  });

  it("a Drive document attached to the event is an explicit match", () => {
    const withDoc = event({ ...omsNimbus, id: "withdoc", attachments: [{ file_id: "drive123", title: "Transcript" }] });
    const sibling = event({ ...omsNimbus, id: "sibling" });
    const d = run(ev({ endMs: at("2026-10-04T14:35:00+02:00"), driveFileId: "drive123" }), [sibling, withDoc]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("withdoc");
  });
});

describe("local recordings (start from the filename, end from the audio)", () => {
  const oneOnOne = (id: string, who: string, start: string, end: string) =>
    event({ id, title: `Alex / ${who}`, start, end, attendees: [{ email: "alex@example.com", self: true }, { email: `${who.toLowerCase()}@example.com` }] });
  const dana = oneOnOne("dana", "Dana", "2026-10-07T15:00:00+02:00", "2026-10-07T15:30:00+02:00");
  const eli = oneOnOne("eli", "Eli", "2026-10-07T15:30:00+02:00", "2026-10-07T16:00:00+02:00");

  it("auto-matches the 1:1 the recording sits in, though nothing in the text names it", () => {
    // Started 14 minutes in: by start time alone the next 1:1 is nearly as close (needed review before).
    const d = run(ev({ startMs: at("2026-10-07T15:13:58+02:00"), recordingEndMs: at("2026-10-07T15:22:40+02:00"), dateHint: "2026-10-07" }), [dana, eli]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("dana");
    expect(d.explanation).toMatch(/covers 100% of it, next best 0%/);
  });

  it("a recording that runs a few minutes into the next meeting still matches the first", () => {
    const sync = event({ id: "sync", title: "Team Eng Sync", start: "2026-10-07T16:00:00+02:00", end: "2026-10-07T17:00:00+02:00", attendees: people("Carol", "Dan", "Alex") });
    const d = run(ev({ startMs: at("2026-10-07T15:32:40+02:00"), recordingEndMs: at("2026-10-07T16:02:54+02:00") }), [eli, sync]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("eli");
  });

  it("double-booked or spanning two meetings goes to review", () => {
    const clash = event({ ...dana, id: "clash", title: "Vendor call", attendees: people("Vic", "Alex") });
    expect(run(ev({ startMs: at("2026-10-07T15:02:00+02:00"), recordingEndMs: at("2026-10-07T15:28:00+02:00") }), [dana, clash]).status).toBe("needs_review");
    expect(run(ev({ startMs: at("2026-10-07T15:15:00+02:00"), recordingEndMs: at("2026-10-07T15:45:00+02:00") }), [dana, eli]).status).toBe("needs_review");
  });

});

import { describe, expect, it } from "bun:test";
import { ConfigSchema } from "../src/config.js";
import { decide, scoreCandidates } from "../src/matching/score.js";
import type { SourceEvidence } from "../src/matching/types.js";
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

describe("meeting matching", () => {
  it("exact temporal match with attendee evidence auto-matches", () => {
    const d = run(ev({ startMs: at("2026-10-04T14:03:00+02:00"), text: "Alice: hi Bob, let's talk about Nimbus wallets", titleHints: ["Nimbus wallet integration"] }), [omsNimbus]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("oms");
    expect(d.score).toBeGreaterThanOrEqual(75);
  });

  it("ambiguous strong candidates go to review even above the auto threshold", () => {
    const a = event({ id: "a", title: "OMS Nimbus Integration", start: "2026-10-04T14:00:00+02:00", end: "2026-10-04T14:30:00+02:00", attendees: people("Alice", "Alex") });
    const b = event({ id: "b", title: "OMS Nimbus Integration (internal)", start: "2026-10-04T14:00:00+02:00", end: "2026-10-04T14:30:00+02:00", attendees: people("Alice", "Alex") });
    const d = run(ev({ startMs: at("2026-10-04T14:00:00+02:00"), titleHints: ["OMS Nimbus Integration"], text: "alice" }), [a, b]);
    expect(d.candidates[0]!.score).toBeGreaterThanOrEqual(75);
    expect(d.status).toBe("needs_review");
  });

});

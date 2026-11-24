// "Explain this decision" (src/explain.ts): the history names the tier the record filed at, never its merits as if they were
// the decision. Every raise above 0 is the AI reviewer's (kernel/src/tier.ts); only a cap or the owner's own call lifts it.
import { describe, expect, it } from "vitest";
import { explain, type RecordWhole } from "../src/explain.js";

const record = (o: Partial<RecordWhole>): RecordWhole => ({
  id: "k-0123456789abcdef", kind: "kernel.apply", tier: 1, merit: 1, state: "review", review: null, decided_by: null, outcome: null,
  created_at: "2026-11-24T10:00:00.000Z", task: "WOR-1", requester: { name: "Engineer" },
  card: { sentence: "Apply", changes: "x", reads: "", cost: "", details: "" }, ...o,
});

describe("explain's tier history", () => {
  it("says Tier 1 for a merit-2 record that is the AI reviewer's", () => {
    const e = explain(record({ tier: 1, merit: 2, rule: "test-user-identity" }), null);
    expect(e.path[0]).toBe("Filed by Engineer at Tier 1 (Tier 2 on its merits; every raise above 0 is the AI reviewer's).");
    expect(e.path.join(" ")).not.toMatch(/at Tier 2\b/);
    expect(e.decider.kind).toBe("pending-reviewer");
  });
  it("names it raised to Tier 2 when autonomy caps it there", () => {
    const e = explain(record({ tier: 2, merit: 1, cap: { by: "autonomy", value: "off" }, state: "owner" }), null);
    expect(e.path[0]).toBe("Filed by Engineer at Tier 1, raised to Tier 2 (autonomy is off).");
    expect(e.decider.kind).toBe("pending-owner");
  });
  it("keeps the filing tier when the reviewer escalated it to the owner", () => {
    // records.review() sets tier 2 with no cap on an escalate: the record filed at its merits.
    for (const [merit, tier] of [[1, 2], [2, 2]] as const) {
      const e = explain(record({ tier, merit, state: "owner", review: "send it to the owner" }), null);
      expect(e.path[0]).toBe(`Filed by Engineer at Tier ${merit}, then the AI reviewer sent it to you.`);
      expect(e.decider.kind).toBe("pending-owner");
    }
    // The owner's own veto needs no review: the record is Tier 2 from the start.
    expect(explain(record({ tier: 2, merit: 1, state: "owner", review: null }), null).path[0]).toBe("Filed by Engineer at Tier 1, then yours to decide.");
  });
  it("says the tier plainly when it is its own merits", () => {
    expect(explain(record({ tier: 1, merit: 1 }), null).path[0]).toBe("Filed by Engineer at Tier 1.");
  });
});

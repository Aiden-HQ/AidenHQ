// "Explain this decision" (src/explain.ts): the history names the tier the record filed at, never its merits as if they were
// the decision. Every raise above 0 is the AI reviewer's (kernel/src/tier.ts); only a cap or the owner's own call lifts it.
import { describe, expect, it } from "bun:test";
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
    for (const [merit, maybe] of [[1, ""], [2, " (Tier 2 on its merits)"]] as const) {
      const e = explain(record({ tier: 2, merit, state: "owner", review: "send it to the owner" }), null);
      expect(e.path[0]).toBe(`Filed by Engineer at Tier 1${maybe}, then the AI reviewer sent it to you.`);
      expect(e.decider.kind).toBe("pending-owner");
    }
    // Once the owner decides it, the state leaves `owner` and the review is still the escalation's evidence.
    for (const [state, by, verdictWord] of [["approved", "account:me-1", "You approved it."], ["rejected", "account:me-1", "You rejected it."]] as const) {
      const e = explain(record({ tier: 2, merit: 1, state, review: "send it to the owner", decided_by: by }), null);
      expect(e.path[0]).toBe("Filed by Engineer at Tier 1, then the AI reviewer sent it to you.");
      expect(e.path).toContain(verdictWord);
    }
    expect(explain(record({ tier: 2, merit: 2, state: "approved", review: "send it to the owner", decided_by: "account:me-1" }), null).path[0])
      .toBe("Filed by Engineer at Tier 1 (Tier 2 on its merits), then the AI reviewer sent it to you.");
    // The owner's own veto needs no review: the record is Tier 2 from the start.
    expect(explain(record({ tier: 2, merit: 1, state: "owner", review: null }), null).path[0]).toBe("Filed by Engineer at Tier 1, then yours to decide.");
  });
});

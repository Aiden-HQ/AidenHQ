// "Explain this decision" (explain.ts): a record whole, in plain words.
import { expect, test } from "vitest";
import { explain, type RecordWhole } from "../src/explain.js";

const rec = (o: Partial<RecordWhole>): RecordWhole => ({
  id: "k-0000000000000001", kind: "runner.merge", tier: 1, merit: 1, state: "done", review: null, decided_by: null, outcome: { ok: true, text: "merged" }, created_at: "2026-11-20T10:00:00Z", task: "t1",
  card: { sentence: "Merge acme/app#7", changes: "1 file", reads: "", cost: "", details: "diff --git a/x b/x", reason: "it changes services/runner/src/tiers.mjs (paths.yaml: services/runner/)" }, requester: { name: "Engineer" }, ...o,
});

test("who decided, why, what was asked and what it changes, for the reviewer, code and the owner", () => {
  const reviewed = explain(rec({ rule: "reviewed-path", review: "Does what the task asked.", review_code: "clean", decided_by: "reviewer:openai/gpt-luna" }), "Fix the login\n\nIt 500s.");
  expect(reviewed.decider).toEqual({ kind: "reviewer", words: "The AI reviewer.", models: ["openai/gpt-luna"] });
  expect(reviewed.tier.ruleWords).toBe("It changes a path the AI reviewer reads first (paths.yaml).");
  expect(reviewed.tier.reason).toMatch(/tiers\.mjs/);
  expect(reviewed.review).toEqual({ note: "Does what the task asked.", code: "clean", codeWords: "Nothing malicious: approved." });
  expect([reviewed.asked, reviewed.changes, reviewed.path.at(-1)]).toEqual(["Fix the login\n\nIt 500s.", "1 file", "It ran."]);

  expect(explain(rec({ decided_by: "reviewer:kernel/code", state: "rejected", outcome: null }), null).path).toContain("Code rejected it before any model read it.");
  // The reviewer escalated (tier 2 now, its note kept), then the owner said no with a reason.
  const owner = explain(rec({ tier: 2, merit: 1, state: "rejected", review: "Touches billing.", review_code: "owner_veto", decided_by: "account:u1", owner_reason: "not this week", outcome: null }), "x");
  expect([owner.decider.kind, owner.path]).toEqual(["owner", ["Filed by Engineer at Tier 1, raised to Tier 2.", "The AI reviewer sent it to you.", "You rejected it: not this week"]]);
  expect(explain(rec({ state: "review", outcome: null }), null).decider.kind).toBe("pending-reviewer");
  expect(explain(rec({ tier: 0, merit: 0, outcome: { ok: true, text: "" } }), null).decider).toMatchObject({ kind: "code", words: "Code: its tier rule let it run at once (Tier 0)." });
});

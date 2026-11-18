// Notices inform; only an outcome wakes an agent (notices.ts). What reaches a parent from the runner, decided in one place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterRejection, graderSpeaks, summaryKind } from "../src/notices.ts";

test("a finished turn is news for the parent only when no grade will speak for it, or it asks or failed", () => {
  const row = (over) => ({ status: "in_review", job: "done", committed: true, cards: [{ id: "A1" }], graded: true, ...over });
  assert.equal(summaryKind([row(), row({ status: "cancelled", graded: false })]), "finished");
  assert.equal(summaryKind([row(), row({ graded: false })]), "done");
  // A grade escalated to the delegator (or settled) has had its say: the delegator who reopened it hears the next turn's end.
  for (const s of ["pending", "awaiting_evidence", "needs_revision"]) assert.equal(graderSpeaks(s), true, s);
  for (const s of ["escalated", "satisfied", "not_graded", null, undefined]) assert.equal(graderSpeaks(s), false, String(s));
  assert.equal(summaryKind([row(), row({ cards: [] })]), "decision"); // committed, no card: "reply pr"
  // Committed with no card, but the board shows it published (its PR merged, or the task closed): no "pr" to ask for.
  assert.equal(summaryKind([row(), row({ cards: [], published: true, graded: false })]), "done");
  assert.equal(summaryKind([row({ cards: [], published: true })]), "finished");
  assert.equal(summaryKind([row(), row({ job: "timeout" })]), "failed");
});

test("a rejection goes back to its Engineer until the task is parked; unsure tells the delegator too", () => {
  const at = (over) => afterRejection({ code: "out_of_scope", rejects: 1, maxRejects: 3, unsure: "reviewer_unsure", ...over });
  assert.deepEqual(at({}), { dispatch: true });
  assert.deepEqual(at({ code: "refused_by_code", rejects: 0 }), { dispatch: true });
  assert.deepEqual(at({ code: "reviewer_unsure" }), { dispatch: true, tell: "decision" });
  assert.deepEqual(at({ rejects: 3 }), { dispatch: false, tell: "parked" });
  assert.deepEqual(at({ code: "stale_head" }), { dispatch: false });
});

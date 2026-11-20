// The panel's approve + reject (owner, 2026-11-20): back to the agent with both notes, and the third split on a branch goes to
// the owner instead of parking it. An approve + unsure the reviewer approved still reaches the owner on a card that is theirs
// on its merits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterReview, meritOwner, priorDecisions, requestKey, requestTargets, splitToOwner } from "../src/tier.ts";

const REPO = "acme/aidenhq";
const split = (sha, at) => ({ id: `k-${sha[0]}`, action: "pr", args: { only: [{ repo: REPO, branch: "b1", sha }] }, state: "rejected", decidedBy: "reviewer:~acme/model-b", decidedAt: at, reviewCode: "panel_split", review: "the two reviewers split", digest: `d-${sha[0]}` });
const verdict = { decision: "reject", code: "panel_split", reason: "The two reviewers split: fix it.", model: "~acme/model-b" };

test("the third panel split on a branch goes to the owner; earlier ones go back to the agent", () => {
  const next = { only: [{ repo: REPO, branch: "b1", sha: "c".repeat(40) }] };
  const priorOf = (records) => priorDecisions(records, "pr", [], requestKey("pr", next), undefined, "chain", requestTargets("pr", next));
  const one = priorOf([split("a".repeat(40), "2026-11-20T01:00:00.000Z")]);
  assert.equal(one.splits, 1);
  assert.equal(splitToOwner({ tier: 1, splits: one.splits }, verdict).decision, "reject");
  const two = priorOf([split("a".repeat(40), "2026-11-20T01:00:00.000Z"), split("b".repeat(40), "2026-11-20T02:00:00.000Z")]);
  const third = splitToOwner({ tier: 1, splits: two.splits }, verdict);
  assert.deepEqual([third.decision, third.code], ["escalate", "panel_split"]);
  assert.match(third.reason, /split 3 times on this target, so the owner decides/);
  // Any other reject is left as it is.
  assert.equal(splitToOwner({ tier: 1, splits: 5 }, { ...verdict, code: "gate_change" }).decision, "reject");
});

test("a reviewer approval on a card that is the owner's on its merits still goes to the owner", () => {
  const input = meritOwner({ tier: 2, rule: "owner-veto", reason: "the owner rejected this action" });
  const v = afterReview(input, { decision: "approve", code: "in_scope", reason: "Approved: one reviewer approved and the other was unsure about the request.", model: "~acme/model-a", second: "~acme/model-b" });
  assert.deepEqual([v.decision, v.code], ["escalate", "owner_tier"]);
});

test("a panel record takes two approvals, or one with the other reviewer unsure; one approval alone is refused", async () => {
  const { openRecords } = await import("../src/records.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "panel-")), "kernel.db"));
  const file = (n) => records.file({ kind: "twin.post_note", module: "twin", args: { n }, targets: {}, executor: { module: "twin" }, policy: "p", tier: 1, panel: true,
    card: { sentence: "s", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "t1", state: "review" });
  const alone = file(1);
  assert.match(records.review(alone.id, alone.digest, { decision: "approve", by: "reviewer:~acme/a", note: "ok" }), /needs a second reviewer's approval too/);
  const unsure = file(2);
  assert.equal(records.review(unsure.id, unsure.digest, { decision: "approve", by: "reviewer:~acme/a;unsure:~acme/b", note: "ok" }).state, "approved");
  const two = file(3);
  assert.equal(records.review(two.id, two.digest, { decision: "approve", by: "reviewer:~acme/a+~acme/b", note: "ok" }).state, "approved");
});

test("an approve + unsure on a record that is the owner's on its merits reaches the owner; one without code's attestation is refused", async (t) => {
  const { kernel } = await import("./helpers.mjs");
  const verdicts = [];
  const k = await kernel(t, { reviewer: async () => verdicts.shift() });
  const file = (n, over = {}) => k.records.file({ kind: "acme.post", module: "acme", args: { n }, targets: {}, executor: { module: "acme" }, policy: "p", tier: 1, panel: true, card: { sentence: "x", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "TASK-1", state: "review", ...over });
  const approveUnsure = { decision: "approve", code: "in_scope", reason: "Approved; the second reviewer was unsure.", model: "~acme/model-a", second_unsure: "~acme/model-b", whole: true };
  // Tier 2 on its merits (reviewed first, then the owner's): the approval goes on to the owner, never stuck in review.
  const owners = file(1, { tier: 2, review_first: "owner" });
  verdicts.push(approveUnsure);
  const out = await k.writes.review(owners.id, { input: { tier: 2, reviewFirst: true, byMerit: true, rule: "owner-veto", reason: "the owner's", model: "~acme/model-a" }, request: { card: {} } });
  assert.equal(out.refused, undefined);
  assert.deepEqual([k.records.get(owners.id).state, out.posted.code], ["owner", "owner_tier"]);
  // A Tier 1 panel record: approved, stamped apart from a second approval.
  const tier1 = file(2);
  verdicts.push(approveUnsure);
  await k.writes.review(tier1.id, { input: { tier: 1, model: "~acme/model-a" }, request: { card: {} } });
  assert.deepEqual([k.records.get(tier1.id).state, k.records.get(tier1.id).decided_by], ["approved", "reviewer:~acme/model-a;unsure:~acme/model-b"]);
  // Without code's attestation that the input was verified whole: refused, left in review.
  const bare = file(3);
  verdicts.push({ ...approveUnsure, whole: undefined });
  const refused = await k.writes.review(bare.id, { input: { tier: 1, model: "~acme/model-a" }, request: { card: {} } });
  assert.match(refused.refused, /attests the input was verified whole/);
  assert.equal(k.records.get(bare.id).state, "review");
});

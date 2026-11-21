// Fail open, never stall (owner, 2026-11-21): a panel split is an ordinary rejection; a target parked at MAX_REJECTS waits out
// the cooldown, then a panel reviews it again, and only after PANEL_TRIES panel rejections does the next request reach the
// owner. No independent reviewer model left approves a Tier 1 write. An approve + unsure the reviewer approved still reaches
// the owner on a card that is theirs on its merits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_REJECTS, PANEL_TRIES, REVIEW_COOLDOWN_MS, afterReview, failOpen, meritOwner, priorDecisions, priorPart, requestKey, requestTargets } from "../src/tier.ts";

const REPO = "acme/aidenhq";
const rejected = (sha, at, extra = {}) => ({ id: `k-${sha.slice(0, 2)}-${at}`, action: "pr", args: { only: [{ repo: REPO, branch: "b1", sha }] }, state: "rejected", decidedBy: "reviewer:~acme/model-b", decidedAt: at, reviewCode: "panel_split", review: "the two reviewers split", digest: `d-${sha}-${at}`, ...extra });

test("a parked branch waits out the cooldown, gets a panel on another family, and reaches the owner only after the panel rejects twice", () => {
  const next = { only: [{ repo: REPO, branch: "b1", sha: "f".repeat(40) }] };
  const t0 = Date.parse("2026-11-20T00:00:00.000Z");
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const priorOf = (records, now) => priorDecisions(records, "pr", [], requestKey("pr", next), undefined, "chain", requestTargets("pr", next), now);
  // Splits count as rejections: five on one branch park it.
  const five = Array.from({ length: MAX_REJECTS }, (_, i) => rejected(String(i).repeat(40), at(i)));
  const parked = priorOf(five, t0 + 10 * 60_000);
  assert.equal(parked.rejects, MAX_REJECTS);
  assert.match(priorPart(parked, t0 + 10 * 60_000)?.reason ?? "", /^parked until 2026-11-20T00:34Z: /);
  // Past the cooldown: reviewed again, as a panel, the last rejector's family asked last.
  const later = t0 + (4 + REVIEW_COOLDOWN_MS / 60_000) * 60_000;
  const panel = priorPart(priorOf(five, later), later);
  assert.deepEqual([panel?.tier, panel?.panel, panel?.reject, priorOf(five, later).avoid], [1, true, undefined, "~acme/model-b"]);
  // The panel rejects twice (each after its cooldown): the next request is the owner's card, reviewed first.
  const more = [...five, ...Array.from({ length: PANEL_TRIES }, (_, i) => rejected(String(i + 5).repeat(40), at(40 + i * 40), { reviewCode: "gate_change", panel: true }))];
  const owner = priorPart(priorOf(more, t0 + 600 * 60_000));
  assert.deepEqual([owner?.tier, owner?.rule, owner?.reject], [2, "retries-owner", undefined]);
  assert.equal(meritOwner(owner).byMerit, true);
  assert.equal(priorPart({ ownerVeto: false, same: "no", rejects: 7, panels: PANEL_TRIES, findings: [] })?.rule, "retries-owner", "the same content resent after two panels reaches the owner");
  // Rejections of requests reviewed side by side, before the park was recorded, are never a panel's.
  const burst = [...five, ...[5, 6].map((i) => rejected(String(i).repeat(40), at(4)))];
  const b = priorOf(burst, t0 + 10 * 60_000);
  assert.deepEqual([b.rejects, b.panels, priorPart(b, t0 + 10 * 60_000)?.rule], [7, 0, "retries-exhausted"]);
  // Ordinary (non-panel) reviews whose verdicts land after the cooldown aren't a panel's either.
  const late = [...five, ...[5, 6].map((i) => rejected(String(i).repeat(40), at(40 + i * 40)))];
  assert.equal(priorOf(late, t0 + 600 * 60_000).panels, 0);
});

test("no reviewer model independent of the requester's approves a Tier 1 write; the owner's own cards still go to the owner", () => {
  const v = { decision: "escalate", code: "no_independent_model", reason: "no second reviewer.", model: "~acme/model-a" };
  assert.deepEqual([failOpen({ tier: 1 }, v).decision, failOpen({ tier: 1 }, v).model], ["approve", "kernel/code"]);
  const theirs = meritOwner({ tier: 2, rule: "owner-veto", reason: "the owner rejected this action" });
  assert.equal(afterReview(theirs, failOpen(theirs, v)).decision, "escalate");
  assert.equal(failOpen({ tier: 1 }, { ...v, code: "reviewer_refused" }).decision, "escalate", "only no_independent_model fails open");
  assert.deepEqual([failOpen({ tier: 1 }, v, true).decision, failOpen({ tier: 1 }, v, true).code], ["escalate", "reviewer_failed"], "a panel card is retried, never approved by code alone");
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
  const { kernel } = await import("./helpers.ts");
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

test("a post's rejections count per run: other runs of the task never park it, and one run retried five times is", () => {
  const post = (run, at, extra = {}) => ({ service: true, id: `k-${run}-${at}`, action: "code-review.post", args: { repo: REPO, pr: 7, head: "a".repeat(40), run }, state: "rejected", decidedBy: "reviewer:~acme/model-b", decidedAt: `2026-11-20T${at}:00:00.000Z`, reviewCode: "out_of_scope", review: "no", digest: `d-${run}-${at}`, ...extra });
  const now = Date.parse("2026-11-20T05:10:00.000Z");
  const priorOf = (records, run) => priorDecisions(records, "code-review.post", [], undefined, undefined, "chain", requestTargets("code-review.post", { run }, true), now);
  const others = ["01", "02", "03", "04", "05", "06"].map((at) => post(`run-${at}`, at));
  const sibling = priorOf(others, "run-new");
  assert.deepEqual([sibling.rejects, priorPart(sibling, now)], [0, undefined], "six rejected posts of other runs park nothing");
  assert.equal(priorOf(others, "run-01").rejects, 1, "a run counts its own rejections");
  const same = ["01", "02", "03", "04", "05"].map((at) => post("run-x", at, { digest: `d-x-${at}` }));
  assert.equal(priorPart(priorOf(same, "run-x"), now)?.rule, "retries-exhausted", "one run retried five times is parked");
  assert.equal(priorOf(same, "run-other").rejects, 0);
});

test("an agent's request is never aimed at a run it names: minting run ids doesn't dodge the park", () => {
  assert.equal(requestTargets("code-review.post", { run: "run-1" }), undefined);
  assert.equal(requestTargets("code-review.post", { run: "run-1" }, false), undefined);
});

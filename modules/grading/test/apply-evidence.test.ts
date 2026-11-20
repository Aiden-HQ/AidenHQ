// A `apply` task's deliverable is the kernel.apply card the task filed: its record arrives from /v1/work as the kernel's own
// kind (`kernel.apply`), never the short `apply` a board card carries. Read as `apply`, it was "no apply filed yet" forever,
// even applied and live; and its diff and log (APPLY_CHANGE, APPLY_OUTCOME) must reach the grader, not `[object Object]`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvidence, presentNow } from "../service/src/grader/evidence.ts";

const REPO = "acme/aidenhq-instance";
const SHA = "c".repeat(40);
const DIFF = "diff --git a/instance.yaml b/instance.yaml\n--- a/instance.yaml\n+++ b/instance.yaml\n@@ -1 +1 @@\n-product: aaaa\n+product: bbbb\n";
const LOG = "apply 4: landed on main\ngeneration 305 is healthy\n";

/** One card exactly as kernel-loop.ts recordsOn shapes a task's record: kind as action, state as used/busy, ok as outcome. */
const record = (over = {}) => ({
  id: "k-0123456789abcdef",
  action: "kernel.apply",
  state: "used",
  outcome: { ok: true },
  usedAt: "2026-11-20T16:00:00Z",
  decidedAt: "2026-11-20T15:59:00Z",
  createdAt: "2026-11-20T15:58:00Z",
  args: { repo: REPO, branch: "fleet/handbook", sha: SHA, files: ["instance.yaml"] },
  details: DIFF,
  outcomeText: LOG,
  ...over,
});

const deps = (cards) => ({ approvals: async () => cards });

test("a kernel.apply card is the apply deliverable: its diff and log are the evidence", async () => {
  const ev = await applyEvidence([record()]);
  assert.equal(ev.awaiting, undefined, "an applied apply is never still 'no apply filed yet'");
  assert.equal(ev.version, "k-0123456789abcdef");
  assert.equal(ev.data.APPLY_CHANGE, DIFF, "the card's diff is APPLY_CHANGE");
  assert.equal(ev.data.APPLY_OUTCOME, LOG, "the card's outcome text is APPLY_OUTCOME, never [object Object]");
  assert.ok(ev.facts.some((f) => f.startsWith("apply k-0123456789abcdef: used, apply 4: landed on main")), "the fact line prints the outcome text");
  assert.ok(ev.facts.every((f) => !f.includes("[object Object]")));
  assert.ok(ev.facts.some((f) => f.includes(`landed ${SHA.slice(0, 12)} on ${REPO}`)));
});

test("presentNow reports a used kernel.apply card as the deliverable present", async () => {
  const now = await presentNow({ kind: "apply", ref: "" }, deps([record()]));
  assert.equal(now.present, true);
  assert.ok(!now.facts.includes("no apply filed yet"));
  assert.ok(now.facts.some((f) => f.startsWith("apply k-0123456789abcdef: used, apply 4: landed on main")));
  assert.ok(now.facts.every((f) => !f.includes("[object Object]")));
});

test("a card that has not run is not evidence yet, and a short-name apply card still reads", async () => {
  const pending = await presentNow({ kind: "apply", ref: "" }, deps([record({ state: "pending", outcome: undefined })]));
  assert.equal(pending.present, false);
  const open = await applyEvidence([record({ state: "pending", outcome: undefined })]);
  assert.equal(open.version, "k-0123456789abcdef", "a filed card is graded for what it says, not waited on as missing");
  // A board card names the action `apply` and its outcome `outcomeText`: the same reading, unchanged.
  const short = await presentNow({ kind: "apply", ref: "" }, deps([record({ action: "apply" })]));
  assert.equal(short.present, true);
  const base = await applyEvidence([record({ action: "apply" })]);
  assert.equal(base.data.APPLY_CHANGE, DIFF);
});

test("another kind's card is never an apply, and no card at all is still the missing deliverable", async () => {
  const other = await applyEvidence([record({ action: "kernel.raise_cap" })]);
  assert.equal(other.missing, true);
  assert.equal(other.awaiting, "no apply filed yet");
  const pr = await presentNow({ kind: "apply", ref: "" }, deps([record({ action: "github.pr" })]));
  assert.equal(pr.present, false);
});

test("the kernel's own record spelling of the outcome text is read too, not only recordsOn's", async () => {
  const raw = record({ outcomeText: undefined, outcome_text: LOG });
  const ev = await applyEvidence([raw]);
  assert.equal(ev.data.APPLY_OUTCOME, LOG);
  const now = await presentNow({ kind: "apply", ref: "" }, deps([raw]));
  assert.ok(now.facts.some((f) => f.startsWith("apply k-0123456789abcdef: used, apply 4: landed on main")));
});

test("the newest apply card is the one graded, in either list order the callers use", async () => {
  const older = record({ id: "k-old", createdAt: "2026-11-20T10:00:00Z", details: "old diff\n", outcomeText: "the apply failed\n" });
  const newer = record({ id: "k-new", createdAt: "2026-11-20T16:00:00Z", details: "new diff\n", outcomeText: "landed\n" });
  for (const cards of [[older, newer], [newer, older]]) {
    const ev = await applyEvidence(cards);
    assert.equal(ev.version, "k-new", "/v1/work sends newest first; the board's cards go oldest first");
    assert.equal(ev.data.APPLY_CHANGE, "new diff\n");
    const now = await presentNow({ kind: "apply", ref: "" }, deps(cards));
    assert.ok(now.facts.some((f) => f.startsWith("apply k-new: used, landed")));
  }
});

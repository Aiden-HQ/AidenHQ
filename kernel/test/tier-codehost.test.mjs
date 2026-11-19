// A code host's write kinds are the bare actions (review-loop.ts actionOf): `codehost-github.pr` is a `pr`, so the retry
// bound, the rejected-content check and the merge carry key on the branch or PR the card names, as the code hosts' own
// plan.mjs reads them. Without it three rejections on one branch parked every later branch of the task (AidenHQ#787).
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionOf } from "../src/review-loop.ts";
import { priorDecisions, priorPart, requestKey, requestPatches, requestTargets } from "../src/tier.ts";

const REPO = "acme/aidenhq", HEAD = "a".repeat(40), NEW = "b".repeat(40);
/** A judged rejection of a `codehost-github.pr` card, as the kernel stores it: the module kind and its `only` args. */
const rejectedPr = (branch, sha, at) => ({
  id: `k-${branch}-${at}`, action: actionOf("codehost-github.pr"), args: { workspace: "WOR-1", only: [{ repo: REPO, branch, sha }] },
  state: "rejected", decidedBy: "reviewer:~acme/model-a", decidedAt: at, reviewCode: null, review: "it leaks a secret", digest: `d-${at}`,
});
const target = (branch, sha) => ({ workspace: "WOR-1", only: [{ repo: REPO, branch, sha }] });

test("three rejected codehost-github.pr cards park their branch, not the task's other branches", () => {
  const records = ["2026-11-19T10:00:00.000Z", "2026-11-19T11:00:00.000Z", "2026-11-19T12:00:00.000Z"].map((at, i) => rejectedPr("b1", HEAD, at));
  // (a) A different branch at a new head: no rejection was raised against it, so it is not parked and its scope names it.
  const next = target("b2", NEW);
  const targets = requestTargets("pr", next);
  assert.equal(targets?.label, "branch `b2`");
  const prior = priorDecisions(records, "pr", [], requestKey("pr", next), undefined, "chain-hash", targets);
  assert.deepEqual([prior.rejects, prior.scope, prior.same], [0, "branch `b2`", undefined]);
  assert.equal(priorPart(prior), undefined, "a never-reviewed branch is not parked by another branch's rejections");

  // (c) A merge card keeps the CI note's action (modules/ai-reviewer/service/src/review.mjs).
  assert.equal(actionOf("codehost-github.merge"), "merge");
  assert.equal(actionOf("codehost-local.merge"), "merge");
  assert.equal(actionOf("codehost-github.pr"), "pr");
  assert.equal(actionOf("codehost-local.push"), "push");
  // Other module kinds still read by their own name: their digest keying depends on it.
  assert.deepEqual([actionOf("acme.post"), actionOf("primer.publish"), actionOf("apps-platform.deploy")], ["acme.post", "primer.publish", "deploy_app"]);
});

test("the same head on a renamed branch is refused as rejected content", () => {
  const records = [rejectedPr("b1", HEAD, "2026-11-19T10:00:00.000Z")];
  // A module PR record carries `only`, so its key (the commit) is read the same as a verified request's `branches`.
  const renamed = target("b3", HEAD);
  assert.equal(requestKey("pr", renamed), requestKey("pr", { branches: renamed.only }));
  const prior = priorDecisions(records, "pr", [], requestKey("pr", renamed), undefined, "chain-hash", requestTargets("pr", renamed));
  assert.equal(prior.same, "it leaks a secret");
  const part = priorPart(prior);
  assert.deepEqual([part?.rule, part?.reject], ["rejected-content", true]);
  // The patch key reads `only` too (an amended resubmission on a new branch).
  const patched = [{ repo: REPO, branch: "b4", sha: NEW, patch: "patch-key" }];
  assert.deepEqual([requestPatches("pr", { only: patched }), requestPatches("pr", { branches: patched })], ["patch-key", "patch-key"]);
});

// A code host's write kinds are the bare actions (review-loop.ts actionOf): `github.pr` is a `pr`, so the rejected-content
// check and the merge carry key on the content the card names, as the code hosts' own plan.ts reads them. Only a rejection
// for malice refuses the same content again (owner, 2026-11-22): an older scope rejection never strands a resubmission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionOf } from "../src/review-loop.ts";
import { priorDecisions, priorPart, requestKey } from "../src/tier.ts";

const REPO = "acme/aidenhq", HEAD = "a".repeat(40), NEW = "b".repeat(40);
/** A judged rejection of a `github.pr` card, as the kernel stores it: the module kind and its `only` args. */
const rejectedPr = (branch, sha, at, reviewCode = "malicious") => ({
  id: `k-${branch}-${at}`, action: actionOf("github.pr"), args: { workspace: "WOR-1", only: [{ repo: REPO, branch, sha }] },
  state: "rejected", decidedBy: "reviewer:~acme/model-a", decidedAt: at, reviewCode, review: "it leaks a secret", digest: `d-${at}`,
});
const target = (branch, sha) => ({ workspace: "WOR-1", only: [{ repo: REPO, branch, sha }] });

test("the code host's kinds read as bare actions; other module kinds by their own name", () => {
  assert.deepEqual([actionOf("github.merge"), actionOf("codehost-local.merge"), actionOf("github.pr"), actionOf("codehost-local.push"), actionOf("github.close")], ["merge", "merge", "pr", "push", "close"]);
  assert.deepEqual([actionOf("acme.post"), actionOf("primer.publish"), actionOf("apps-platform.deploy")], ["acme.post", "primer.publish", "deploy_app"]);
});

test("the same head rejected as malice is refused on any branch; other content, or an older scope rejection, is reviewed", () => {
  const records = [rejectedPr("b1", HEAD, "2026-11-19T10:00:00.000Z")];
  const renamed = target("b3", HEAD);
  assert.equal(requestKey("pr", renamed), requestKey("pr", { branches: renamed.only }));
  const part = priorPart(priorDecisions(records, "pr", requestKey("pr", renamed)));
  assert.deepEqual([part?.rule, part?.reject], ["rejected-content", true]);
  assert.equal(priorPart(priorDecisions(records, "pr", requestKey("pr", target("b2", NEW)))), undefined, "new content is reviewed");
  // Rejections from before the malice-only reviewer (out_of_scope, policy_other, unsure, a panel split) never refuse it again.
  for (const code of ["out_of_scope", "policy_other", "reviewer_unsure", "panel_split", null]) {
    assert.equal(priorPart(priorDecisions([rejectedPr("b1", HEAD, "2026-11-19T10:00:00.000Z", code)], "pr", requestKey("pr", renamed))), undefined, String(code));
  }
});

test("the owner's own no on the action is his veto until his yes", () => {
  const no = { ...rejectedPr("b1", HEAD, "2026-11-19T10:00:00.000Z", null), decidedBy: "account:o1" };
  assert.equal(priorPart(priorDecisions([no], "pr", requestKey("pr", target("b2", NEW))))?.rule, "owner-veto");
  const yes = { ...no, id: "k-yes", state: "approved", decidedAt: "2026-11-19T11:00:00.000Z" };
  assert.equal(priorPart(priorDecisions([no, yes], "pr", requestKey("pr", target("b2", NEW)))), undefined);
});

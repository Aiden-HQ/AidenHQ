// A code host's write kinds are the bare actions (review-loop.ts actionOf): `github.pr` is a `pr`, so the rejected-content
// check and the merge carry key on the content the card names, as the code hosts' own plan.ts reads them. Only a rejection
// for malice refuses the same content again (owner, 2026-11-22): an older scope rejection never strands a resubmission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionOf } from "../src/review-loop.ts";
import { priorDecisions, priorPart, requestKey, requestTargets } from "../src/tier.ts";

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

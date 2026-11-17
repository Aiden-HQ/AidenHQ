// A branch whose PR another task already opened: the runner adopts that PR instead of failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceOf, existingPrUrl, withEvidence } from "../src/describe.ts";
import { reviewRequest } from "../src/review-request.mjs";

test("gh's 'already exists' error gives the open PR's URL; other errors give nothing", () => {
  const err = 'a pull request for branch "fix/archived-leak-and-shipped-state" into branch "main" already exists:\nhttps://github.com/acme-agents/roadmap-keeper/pull/26\n';
  assert.equal(existingPrUrl(err, "acme-agents/roadmap-keeper"), "https://github.com/acme-agents/roadmap-keeper/pull/26");
  assert.equal(existingPrUrl(err, "other/repo"), undefined, "only a PR in the same repository");
  assert.equal(existingPrUrl("GraphQL: Resource not accessible by integration", "acme-agents/roadmap-keeper"), undefined);
});

test("a PR's Evidence section: kept as written, stubbed when missing, and the reviewer's request carries it", () => {
  const body = "Fixes the wrap.\n\n## Evidence\n\n- `npm test`: 12 passed\n- after: .aidenhq/out/home-390-light.png\n\n## Notes\n\nnone";
  assert.equal(withEvidence(body), body);
  assert.equal(withEvidence("Fixes the wrap."), "Fixes the wrap.\n\nEvidence: none given");
  assert.equal(withEvidence(withEvidence("")), "Evidence: none given");
  assert.equal(evidenceOf(body), "- `npm test`: 12 passed\n- after: .aidenhq/out/home-390-light.png");
  assert.equal(evidenceOf("Fixes the wrap.\n\nEvidence: none given"), "none given");
  const card = { action: "pr", target: "acme-agents/app fix/wrap", sentence: "Open a PR" };
  assert.equal(reviewRequest(card, { rule: "agents-pr", diff: "+x", evidence: evidenceOf(body) }, "").evidence, evidenceOf(body));
  assert.equal(reviewRequest({ ...card, action: "push" }, { rule: "push", diff: "+x" }, "").evidence, undefined);
});

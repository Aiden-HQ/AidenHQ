// A branch whose PR another task already opened: the runner adopts that PR instead of failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existingPrUrl } from "../src/describe.mjs";

test("gh's 'already exists' error gives the open PR's URL; other errors give nothing", () => {
  const err = 'a pull request for branch "fix/archived-leak-and-shipped-state" into branch "main" already exists:\nhttps://github.com/acme-agents/roadmap-keeper/pull/26\n';
  assert.equal(existingPrUrl(err, "acme-agents/roadmap-keeper"), "https://github.com/acme-agents/roadmap-keeper/pull/26");
  assert.equal(existingPrUrl(err, "other/repo"), undefined, "only a PR in the same repository");
  assert.equal(existingPrUrl("GraphQL: Resource not accessible by integration", "acme-agents/roadmap-keeper"), undefined);
});

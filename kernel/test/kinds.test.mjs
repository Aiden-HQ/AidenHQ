// The runner kinds on the on-server code host (docs/design/codehost-local.md §4): a local change request's URL is accepted
// beside a GitHub PR's, and a local merge is never below the AI reviewer (local-merge: no CI review read it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { KERNEL_KINDS, runnerFacts, urlRepo } from "../src/kinds.ts";
import { validate } from "../src/writes.ts";

const repos = { product: "acme/aidenhq", instance: "local/aidenhq-instance", agentsOrg: "acme-agents", agentsOrgs: ["acme-agents", "local"] };
const merge = (repo, url) => ({ prs: [{ repo, number: 3, url, head: "a".repeat(40) }] });

test("a codehost:local/x/change/3 merge is accepted and its floor is 1; a GitHub agents-org merge stays at 0", () => {
  validate(KERNEL_KINDS["runner.merge"].args, merge("local/x", "codehost:local/x/change/3"));
  assert.throws(() => validate(KERNEL_KINDS["runner.merge"].args, merge("local/x", "codehost:local/x/pull/3")));
  assert.equal(urlRepo("codehost:local/x/change/3"), "local/x");
  const local = runnerFacts("runner.merge", merge("local/x", "codehost:local/x/change/3"), repos);
  assert.equal(local.refuse, undefined);
  assert.deepEqual([local.floor, local.target], [1, "local/x#3"]);
  assert.equal(runnerFacts("runner.merge", merge("acme-agents/x", "https://github.com/acme-agents/x/pull/3"), repos).floor, 0);
  assert.match(runnerFacts("runner.merge", merge("local/x", "codehost:local/y/change/3"), repos).refuse, /another repository/);
  // A local branch push runs at once like any agents-org branch; a repository is created only in an agents org.
  assert.equal(runnerFacts("runner.push", { only: [{ repo: "local/x", branch: "feat/a", sha: "b".repeat(40) }] }, repos).floor, 0);
  assert.equal(runnerFacts("runner.create_repo", { repo: "local/new-app" }, repos).refuse, undefined);
  assert.match(runnerFacts("runner.create_repo", { repo: "local/new-app" }, { ...repos, agentsOrgs: undefined }).refuse, /only in the agents org/);
});

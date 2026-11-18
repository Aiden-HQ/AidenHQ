import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planParts, plan } from "../src/plan.mjs";

const s = { agentsOrgs: ["acme-agents", "local"], productRepo: "acme/aidenhq", instanceRepo: "local/aidenhq-instance", requester: {} };
const green = [{ name: "tests", ok: true }, { name: "secrets", ok: true }];
const pr = (repo, extra = {}) => ({ repo, number: 3, head: "a".repeat(40), files: ["src/app.ts"], checks: green, headMatches: true, ownHead: true, ...extra });

describe("plan: local change requests", () => {
  it("a local/* merge is local-merge at Tier 1; a GitHub agents-org merge is still agents-org-merge at Tier 0", () => {
    assert.deepEqual(planParts("merge", { ...s, prs: [pr("local/expense-tracker")] })[0].map((p) => [p.rule, p.tier]), [["local-merge", 1]]);
    assert.deepEqual(planParts("merge", { ...s, prs: [pr("acme-agents/expense-tracker")] })[0].map((p) => [p.rule, p.tier]), [["agents-org-merge", 0]]);
    assert.deepEqual(planParts("merge", { agentsOrg: "acme-agents", productRepo: s.productRepo, instanceRepo: "acme/inst", prs: [pr("acme-agents/x")] })[0][0].reason, "acme-agents/x#3: 2 named checks, all green on the exact head");
    const out = plan({ kind: "codehost.merge", args: {} }, { ...s, prs: [pr("local/expense-tracker")] });
    assert.equal(out.raise.rule, "local-merge");
    assert.equal(out.targets["local/expense-tracker#3"].ref, "change/3");
  });

  it("local repos are in the agents orgs: create_repo is Tier 0, a red check is refused with the local readout", () => {
    const allowedOrgs = ["acme-agents", "local", "other-org"];
    for (const repo of ["local/expense-tracker", "acme-agents/expense-tracker", "other-org/expense-tracker"]) assert.deepEqual(planParts("create_repo", { ...s, allowedOrgs, repo })[0].map((p) => [p.rule, p.tier]), [["create-repo", 0]], repo);
    assert.equal(planParts("create_repo", { ...s, allowedOrgs, repo: "stranger/expense-tracker" })[0][0].rule, "outside-create-repo", "an org nobody allowed");
    assert.equal(planParts("create_repo", { ...s, repo: "other-org/expense-tracker" })[0][0].rule, "outside-create-repo", "no allowedOrgs: the agents orgs only");
    // A workflow file pushed to a repository is the reviewer's (Tier 1) in any org; a new repo is no exception.
    const wf = { repo: "other-org/expense-tracker", branch: "feat/x", defaultBranch: "main", sha: "a".repeat(40), files: [".github/workflows/x.yml"] };
    assert.ok(planParts("push", { ...s, branches: [wf] })[0].every((p) => p.tier >= 1), "outside the agents org");
    assert.ok(planParts("push", { ...s, branches: [{ ...wf, repo: "acme-agents/expense-tracker" }] })[0].some((p) => p.rule === "github-dir" && p.tier === 1), "in the agents org");
    for (const repo of [s.productRepo, s.instanceRepo, "acme-agents/Apps", "acme-agents/.github"]) assert.equal(planParts("create_repo", { ...s, repo })[0][0].tier, 2, repo);
    const red = planParts("merge", { ...s, prs: [pr("local/expense-tracker", { checks: [{ name: "tests", ok: false }] })] })[0][0];
    assert.equal(red.rule, "checks-not-green");
    assert.match(red.reason, /aidenhq status/);
    assert.equal(planParts("merge", { ...s, prs: [pr("local/aidenhq-instance")] })[0][0].rule, "core-repo-merge");
  });
});

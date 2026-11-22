import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planParts, plan } from "../service/src/plan.ts";

const s = { agentsOrgs: ["acme-agents", "local"], productRepo: "acme/aidenhq", instanceRepo: "local/aidenhq-instance", requester: {} };
const green = [{ name: "tests", ok: true }, { name: "secrets", ok: true }];
const pr = (repo, extra = {}) => ({ repo, number: 3, head: "a".repeat(40), files: ["src/app.ts"], checks: green, headMatches: true, ownHead: true, ...extra });

describe("plan: local change requests", () => {
  it("a local/* merge is local-merge at Tier 1; a GitHub agents-org merge is still agents-org-merge at Tier 0", () => {
    assert.deepEqual(planParts("merge", { ...s, prs: [pr("local/expense-tracker")] })[0].map((p) => [p.rule, p.tier]), [["local-merge", 1]]);
    assert.deepEqual(planParts("merge", { ...s, prs: [pr("acme-agents/expense-tracker")] })[0].map((p) => [p.rule, p.tier]), [["agents-org-merge", 0]]);
    assert.deepEqual(planParts("merge", { agentsOrg: "acme-agents", productRepo: s.productRepo, instanceRepo: "acme/inst", prs: [pr("acme-agents/x")] })[0][0].reason, "acme-agents/x#3: 2 named checks, all green on the exact head");
    const out = plan({ kind: "codehost.merge", args: {} }, { ...s, prs: [pr("local/expense-tracker")] }, { target: "", sentence: "", diff: "" });
    assert.equal(out.raise.rule, "local-merge");
    assert.equal(out.targets["local/expense-tracker#3"].ref, "change/3");
  });

});

describe("plan: the product repo", () => {
  const engineer = { ...s, workspace: "ACME-7", requester: { platform: false } };
  const branch = (files, name = "agent/ACME-7/fix", repo = s.productRepo) => ({ repo, branch: name, defaultBranch: "main", files });
  const rules = (action, st, b) => planParts(action, { ...st, branches: [b] })[0].map((p) => [p.tier, p.rule]);

  it("a job without the platform role pushes only its own task's branches, on the product repo and outside the agents org", () => {
    assert.deepEqual(rules("pr", engineer, branch(["kernel/src/a.ts"], "fix/x")), [[2, "branch-namespace"]]);
    assert.deepEqual(rules("pr", engineer, branch(["kernel/src/a.ts"], "agent/ACME-8/fix")), [[2, "branch-namespace"]]);
    assert.deepEqual(rules("pr", engineer, branch(["src/a.ts"], "fix/x", "other/lib")), [[2, "branch-namespace"]]);
    assert.deepEqual(rules("pr", engineer, branch(["src/a.ts"], "agent/ACME-7/fix", "other/lib")), [[1, "outside-pr"]]);
    assert.deepEqual(rules("pr", { ...s, requester: { platform: true } }, branch(["kernel/src/a.ts"], "fix/x")), [[1, "product-pr"]]);
  });

});

describe("plan: maintained repos (maintainer_repos)", () => {
  const m = { ...s, maintained: ["globex/payments", s.productRepo, s.instanceRepo] };
  const rules = (action, st, p) => planParts(action, { ...st, prs: [p] })[0].map((x) => [x.rule, x.tier]);

  it("merge on a maintained repo outside the agents org is planned like an agents-org merge, a Dependabot head at Tier 1", () => {
    assert.deepEqual(rules("merge", m, pr("globex/payments")), [["maintained-merge", 0]]);
    assert.deepEqual(rules("merge", m, pr("Globex/Payments", { checks: [{ name: "tests", pending: true }] })), [["maintained-merge-checks-running", 0]]);
    assert.deepEqual(rules("merge", m, pr("globex/payments", { ownHead: false, dependabot: true })), [["maintained-merge-foreign-head", 1], ["maintained-merge", 0]]);
    assert.match(planParts("merge", { ...m, prs: [pr("globex/payments", { ownHead: false })] })[0][0].reason, /the owner listed it in maintainer_repos/);
    assert.equal(rules("merge", m, pr("globex/payments", { checks: [{ name: "tests", ok: false }] }))[0][0], "maintained-merge-checks-running", "red is the queue's: filed");
    assert.match(planParts("merge", { ...m, prs: [pr("globex/payments", { checks: [] })] })[0][0].reason, /none registered yet/);
    assert.equal(rules("merge", m, pr("globex/payments", { headMatches: false }))[0][0], "head-moved");
    // Listing the product or instance repo changes nothing: their own rules come first.
    assert.deepEqual(rules("merge", m, pr(s.productRepo)), [["product-merge", 1]]);
    assert.equal(rules("merge", m, pr(s.instanceRepo))[0][0], "core-repo-merge");
  });

});

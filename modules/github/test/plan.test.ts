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
    assert.equal(red.rule, "checks-not-green", "a local change has no waiting queue: refused here");
    assert.match(red.reason, /aidenhq status/);
    assert.equal(planParts("merge", { ...s, prs: [pr("local/aidenhq-instance")] })[0][0].rule, "core-repo-merge");
  });
});

describe("plan: the product repo", () => {
  const engineer = { ...s, workspace: "ACME-7", requester: { platform: false } };
  const branch = (files, name = "agent/ACME-7/fix", repo = s.productRepo) => ({ repo, branch: name, defaultBranch: "main", files });
  const rules = (action, st, b) => planParts(action, { ...st, branches: [b] })[0].map((p) => [p.tier, p.rule]);

  it("a product PR is a proposal: an Engineer job without the platform role opens one; its bare push and a .github change stay the platform line's", () => {
    assert.deepEqual(rules("pr", engineer, branch(["kernel/src/a.ts"])), [[1, "product-pr"]]);
    assert.equal(planParts("pr", { ...engineer, branches: [branch([".github/workflows/ci.yml"])] })[0][0].reject, true);
    assert.equal(planParts("push", { ...engineer, branches: [branch(["kernel/src/a.ts"])] })[0][0].reject, true);
  });

  it("the platform line's refusal is one stable code naming its remedy, for a .github PR and a bare push alike", () => {
    for (const [action, files, rule] of [["pr", [".github/x.ts"], "product-pr-workflow"], ["push", ["kernel/src/a.ts"], "product-push"]]) {
      const p = planParts(action, { ...engineer, branches: [branch(files)] })[0][0];
      assert.equal(p.reject, true);
      assert.equal(p.rule, rule, `${action} keeps its own rule name`);
      assert.equal(p.code, "platform-only", `${action} carries the rule's fixed code`);
      assert.match(p.reason, /file this change on a task the owner, the Agent Architect or the Fleet Steward filed/, "the reason names the way out");
    }
    // The plan's refusal carries the same code as a caller reads it (the executor's 422 answers it).
    const thrown = (() => { try { plan({ kind: "github.pr", args: {} }, { ...engineer, branches: [branch([".github/x.ts"])] }, { diff: "" }); } catch (e) { return e as Error & { rule?: string; code?: string }; } })();
    assert.deepEqual([thrown?.rule, thrown?.code], ["product-pr-workflow", "platform-only"]);
    // A platform requester's same PR is still an ordinary Tier 1 product PR, and so is a non-.github one from a non-platform job.
    const platform = { ...s, requester: { platform: true } };
    assert.deepEqual(rules("pr", platform, branch([".github/x.ts"])), [[1, "product-pr"]]);
    const ordinary = plan({ kind: "github.pr", args: {} }, { ...engineer, branches: [branch(["kernel/src/a.ts"])] }, { diff: "" });
    assert.deepEqual([ordinary.raise?.tier, ordinary.raise?.rule], [1, "product-pr"]);
  });

  it("a job without the platform role pushes only its own task's branches, on the product repo and outside the agents org", () => {
    assert.deepEqual(rules("pr", engineer, branch(["kernel/src/a.ts"], "fix/x")), [[2, "branch-namespace"]]);
    assert.deepEqual(rules("pr", engineer, branch(["kernel/src/a.ts"], "agent/ACME-8/fix")), [[2, "branch-namespace"]]);
    assert.deepEqual(rules("pr", engineer, branch(["src/a.ts"], "fix/x", "other/lib")), [[2, "branch-namespace"]]);
    assert.deepEqual(rules("pr", engineer, branch(["src/a.ts"], "agent/ACME-7/fix", "other/lib")), [[1, "outside-pr"]]);
    assert.deepEqual(rules("pr", { ...s, requester: { platform: true } }, branch(["kernel/src/a.ts"], "fix/x")), [[1, "product-pr"]]);
  });

  it("a merge: an Engineer job asks only for its own task's head, never a .github change; the platform line asks for any", () => {
    const merge = (st, extra) => planParts("merge", { ...s, ...st, prs: [{ repo: s.productRepo, number: 7, head: "a".repeat(40), headMatches: true, files: ["kernel/src/a.ts"], checks: [{ name: "tests", ok: true }], ownHead: true, ...extra }] })[0][0];
    const own = merge({ requester: { platform: false }, task: "t-7" }, { pushedBy: "t-7" });
    assert.deepEqual([own.tier, own.rule], [1, "product-merge-engineer-head"]);
    assert.match(own.reason, /NOT the Platform Engineer's line/);
    assert.equal(merge({ requester: { platform: false }, task: "t-7" }, { pushedBy: "t-8" }).rule, "product-merge-requester", "another requester's head");
    assert.equal(merge({ requester: { platform: false }, task: "t-7" }, { pushedBy: "t-7", files: [".github/workflows/ci.yml"] }).rule, "product-merge-workflow");
    assert.equal(merge({ requester: { platform: true } }, { platformHead: true }).rule, "product-merge");
    assert.equal(merge({ requester: { platform: true } }, { pushedBy: "t-7" }).rule, "product-merge-engineer-head");
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
    assert.deepEqual(rules("merge", { ...m, requester: { platform: true } }, pr(s.productRepo, { platformHead: true })), [["product-merge", 1]]);
    assert.equal(rules("merge", m, pr(s.instanceRepo))[0][0], "core-repo-merge");
  });

  it("close on a maintained repo is Tier 0; the product and instance repos keep their rules when listed", () => {
    assert.deepEqual(rules("close", m, { repo: "globex/payments", number: 4 }), [["maintained-close", 0]]);
    assert.deepEqual(rules("close", { ...m, requester: { platform: true } }, { repo: "globex/payments", number: 4, dependabot: true }), [["maintained-close", 0]]);
    assert.equal(rules("close", m, { repo: s.productRepo, number: 4 })[0][0], "core-repo-close");
    assert.equal(rules("close", m, { repo: s.instanceRepo, number: 4 })[0][0], "core-repo-close");
  });

  it("a repo the App is installed on but not maintained is still outside-merge and outside-close", () => {
    assert.equal(rules("merge", m, pr("globex/other"))[0][0], "outside-merge");
    assert.equal(rules("close", m, { repo: "globex/other", number: 4 })[0][0], "outside-close");
    assert.equal(rules("merge", s, pr("globex/payments"))[0][0], "outside-merge", "no maintained list in the state: nothing widens");
  });
});

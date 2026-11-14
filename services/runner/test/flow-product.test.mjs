// End to end (see flow-harness.mjs), the product repo's PR pipeline (owner, 2026-11-13): acme/app plays the product repo and
// Ada is the Platform Engineer. One `pr` card pushes, opens and later merges the PR; a Dependabot PR becomes one task once
// its checks finish; an agent's PR that conflicts with main wakes its task once per main commit.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";
import { State } from "../src/state.mjs";

const PR9 = "https://github.com/acme/app/pull/9";

describe("flow-product", () => {
  const t = flow({
    grants: { autonomy: "off", agents: { "engineer-claude": { key: "fleet-engineer" } } },
    env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
  });
  const setPrs = (prs) => writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify(prs));
  const merged = () => t.fakeLog().filter((e) => e.kind === "gh" && e.data.some((a) => /pulls\/\d+\/merge$/.test(a)));
  const busy = () => (t.paperclip.activity.at(-1)?.running ?? []).some((r) => r.mode !== "merging PRs");
  /** A fresh runner (state kept): its once-a-minute checks run at once. */
  const restart = async () => {
    await t.waitFor("no run going", () => !busy());
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    t.startRunner();
  };

  it("one pr card pushes the branch, and merges it at that commit once the checks turn green", async () => {
    await t.settled();
    const state = new State(join(t.dir, "state"));
    state.saveBranch("part", { repo: "acme/app", branch: "fix/remove-legacy", base: "main" });
    state.updateBranch("part", "acme/app", "fix/remove-legacy", { pr_url: PR9 });
    state.db.close();
    setPrs({ 9: { branch: "fix/remove-legacy", files: ["chains.txt"], checks: "PENDING" } });
    t.step("none\naidenhq pr acme/app fix/remove-legacy");
    await t.turn("Ship it.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    const card = t.paperclip.decide("pr", "approved");
    assert.equal(card.args.merge, true, "the PR card carries the merge");
    const sha = card.args.only[0].sha;
    const tip = () => {
      try {
        return t.githubTip();
      } catch {
        return ""; // not on GitHub yet
      }
    };
    await t.waitFor("the push", () => tip() === sha);
    await t.waitFor("the merge queued", () => t.partComments().some((c) => /On it: merging 1 PR/.test(c)));
    await t.idle(1500);
    assert.equal(merged().length, 0, "not merged while its checks run");
    setPrs({ 9: { branch: "fix/remove-legacy", files: ["chains.txt"], checks: "SUCCESS" } });
    await restart(); // a card queue steps once a minute: a fresh runner steps it now
    await t.waitFor("the merge", () => merged().length === 1);
    assert.ok(merged()[0].data.includes(`sha=${sha}`), "at exactly the approved commit");
    assert.equal(t.paperclip.approvals.size, 1, "no second card");
  });

  it("a Dependabot PR becomes one Platform Engineer task, once its checks have finished", async () => {
    const dependabot = (checks) => ({ 10: { branch: "main", files: ["package-lock.json"], checks, author: "dependabot" } });
    setPrs(dependabot("PENDING"));
    await restart();
    await t.idle(2000);
    assert.equal(t.paperclip.created.length, 0, "not while its checks run");
    setPrs(dependabot("SUCCESS"));
    await restart();
    await t.waitFor("the task", () => t.paperclip.created.length === 1);
    const task = t.paperclip.created[0];
    assert.equal(task.assigneeAgentId, "engineer-claude");
    assert.match(task.description, /pull\/10[\s\S]*<!-- source:dependabot:acme\/app\/10 -->$/);
    assert.doesNotMatch(task.description, /package-lock/, "nothing of the PR's own text");
    await t.waitFor("its run", () => t.claudeRuns().some((r) => /Dependabot PR acme\/app#10/.test(r.prompt)));
    await restart();
    await t.idle(2000);
    assert.equal(t.paperclip.created.length, 1, "filed once");
  });

  it("an agent's PR that conflicts with main wakes its task once", async () => {
    const pings = () => t.partComments().filter((c) => /now conflicts with `main`/.test(c));
    setPrs({ 9: { branch: "fix/remove-legacy", files: ["chains.txt"], checks: "SUCCESS", mergeable: "CONFLICTING" } });
    await restart();
    await t.waitFor("the ping", () => pings().length === 1);
    await t.waitFor("the rebase run", () => t.claudeRuns().some((r) => /Rebase the PR's branch onto `origin\/main`/.test(r.prompt)));
    await restart();
    await t.idle(2000);
    assert.equal(pings().length, 1, "once per main commit");
  });

  it("a conflicting PR of a done or cancelled task is never reopened or worked on: one note", async () => {
    await t.waitFor("no run going", () => !busy());
    const state = new State(join(t.dir, "state"));
    state.saveBranch("part", { repo: "acme/app", branch: "feat/old", base: "main" });
    state.updateBranch("part", "acme/app", "feat/old", { pr_url: "https://github.com/acme/app/pull/11" });
    state.db.close();
    t.paperclip.issues.get("part").status = "cancelled";
    const runs = t.claudeRuns().length;
    const notes = () => t.partComments().filter((c) => /pull\/11 now conflicts[\s\S]*nobody was woken/.test(c));
    setPrs({ 11: { branch: "main", files: ["a.txt"], checks: "SUCCESS", mergeable: "CONFLICTING" } });
    await restart();
    await t.waitFor("the note", () => notes().length === 1);
    await restart();
    await t.idle(2000);
    assert.equal(notes().length, 1, "one note per PR");
    assert.equal(t.paperclip.issues.get("part").status, "cancelled", "not reopened");
    assert.equal(t.claudeRuns().length, runs, "nothing dispatched");
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

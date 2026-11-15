// End to end (see flow-harness.mjs): a UI PR's design review, and the review task the runner files for each head. Owner,
// 2026-11-13: when the head moved on, the earlier head's task sat in the owner's queue after its verdict had been posted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";
import { State } from "../src/state.mjs";

describe("flow-design-review", () => {
  const t = flow({
    env: { AIDENHQ_PRODUCT_REPO: "acme/aidenhq", AIDENHQ_GITHUB_AGENTS_ORG: "acme" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
  });
  const reviews = () => t.paperclip.created.filter((c) => c.title === "Design review: acme/app#9");
  const head = (task) => /@([0-9a-f]{40}) -->/.exec(String(task.description))?.[1];
  const identifier = (task) => t.paperclip.issues.get(task.id).identifier;
  const closed = (task) => t.paperclip.patches.find((p) => p.issue === identifier(task) && p.status === "cancelled");

  it("closes the earlier head's review task as superseded when the PR moves to a new head", async () => {
    await t.settled();
    // Tier 0 in the agents org, with a design reviewer in the fleet: a green UI PR's merge waits for its review.
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    mkdirSync(join(t.dir, "config/grants"), { recursive: true });
    writeFileSync(join(t.dir, "config/grants/grants.json"), JSON.stringify({ autonomy: "tier0", agents: { "designer-1": { key: "ui-reviewer", roles: ["design-review"] } } }));
    writeFileSync(join(t.dir, "secrets/reviewer_key"), `${"r".repeat(64)}\n`, { mode: 0o600 });
    t.startRunner();

    t.step("ui\naidenhq push acme/app feat/ui");
    await t.turn("Restyle the page and push it.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    // The PR opens on that branch, its checks green, changing UI files.
    const state = new State(join(t.dir, "state"));
    state.updateBranch("part", "acme/app", "feat/ui", { pr_url: "https://github.com/acme/app/pull/9" });
    state.db.close();
    writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 9: { branch: "feat/ui", files: ["web/app.css"], checks: "SUCCESS" } }));

    // A new commit moves the head on: its task asks for that head.
    t.step("ui-more\naidenhq push acme/app feat/ui");
    await t.turn("Tweak it and push.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    await t.waitFor("the review task for that head", () => reviews().length === 1);
    const first = reviews()[0];
    assert.equal(head(first), t.githubTip("feat/ui"), "the task names the head it asks about");
    assert.equal(first.assigneeAgentId, "designer-1");
    assert.equal(closed(first), undefined, "the live review stays open");

    // Another commit: the new head gets its own task, and the earlier head's task closes as superseded rather than
    // staying open (and, once handed back, in the owner's queue) after its head stopped being the PR's.
    t.step("ui-next\naidenhq push acme/app feat/ui");
    await t.turn("One more tweak, then push.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    await t.waitFor("the review task for the new head", () => reviews().length === 2);
    await t.waitFor("the earlier head's task closed as superseded", () => Boolean(closed(first)));
    const second = reviews().find((c) => c.id !== first.id);
    assert.equal(head(second), t.githubTip("feat/ui"), "the live task is the current head's");
    assert.notEqual(head(first), head(second), "one task per head");
    assert.match(String(closed(first).comment), /Closed as superseded: its PR has moved on to head `[0-9a-f]{12}`/);
    assert.equal(closed(second), undefined, "the current head's task stays open for its verdict");
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-design-review: the task is one its reviewer can run", () => {
  // The reviewer is an agent in a computer (the design module's UI Reviewer), as it is on the fleet: Paperclip holds a shared
  // folder for a whole run, so a task filed into it without a folder of its own never starts, is left in progress with no run
  // and is blocked for having no live execution path. A task with `agent_default` gets the reviewer's own folder and runs.
  const t = flow({
    env: { AIDENHQ_PRODUCT_REPO: "acme/aidenhq", AIDENHQ_GITHUB_AGENTS_ORG: "acme" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
    computers: ["designer-1"],
  });
  const reviews = () => t.paperclip.created.filter((c) => c.title === "Design review: acme/app#9");

  it("a board-filed design-review task starts a run instead of sitting in progress with none", async () => {
    await t.settled();
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    mkdirSync(join(t.dir, "config/grants"), { recursive: true });
    writeFileSync(join(t.dir, "config/grants/grants.json"), JSON.stringify({ autonomy: "tier0", agents: { "designer-1": { key: "ui-reviewer", roles: ["design-review"] } } }));
    writeFileSync(join(t.dir, "secrets/reviewer_key"), `${"r".repeat(64)}\n`, { mode: 0o600 });
    t.startRunner();

    t.step("ui\naidenhq push acme/app feat/ui");
    await t.turn("Restyle the page and push it.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    const state = new State(join(t.dir, "state"));
    state.updateBranch("part", "acme/app", "feat/ui", { pr_url: "https://github.com/acme/app/pull/9" });
    state.db.close();
    writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 9: { branch: "feat/ui", files: ["web/app.css"], checks: "SUCCESS" } }));

    t.step("ui-more\naidenhq push acme/app feat/ui");
    await t.turn("Tweak it and push.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    await t.waitFor("the review task for that head", () => reviews().length === 1);
    const task = reviews()[0];
    const filed = t.paperclip.issues.get(task.id);
    assert.ok(t.paperclip.runs.some((r) => r.issueId === task.id && r.agentId === "designer-1"), "a run is attached to it");
    assert.equal(filed.status, "in_progress", "claimed and running, not blocked with no run");
    assert.ok(!t.paperclip.comments.get(task.id).some((c) => /no live execution path/.test(String(c.body))), "never blocked for having no run");
    assert.equal(filed.executionWorkspacePreference, "agent_default", "the reviewer's own folder, as every delegation carries");
    assert.deepEqual(filed.executionWorkspaceSettings, { mode: "agent_default" });
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

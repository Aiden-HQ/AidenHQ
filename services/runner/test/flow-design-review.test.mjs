// End to end (see flow-harness.mjs): a UI PR's design review, and the review task the runner files for each head. Owner,
// 2026-11-13: when the head moved on, the earlier head's task sat in the owner's queue after its verdict had been posted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

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
    // The task and the run its wake starts: a task filed already assigned, and never woken, would sit with none.
    await t.waitFor("the review task for that head and its run", () => reviews().length === 1 && t.paperclip.runs.some((r) => r.issueId === reviews()[0].id));
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

describe("flow-design-review: a pending design-review wakes its reviewer", () => {
  // Owner, 2026-11-15: a UI head went pending on `design-review`, the task was filed already assigned, and nothing started
  // it — Paperclip starts no run for a task that arrives assigned, so only the UI Reviewer's 4-hourly heartbeat picked it
  // up (roadmap-keeper#159 and #161 waited on it). The filing path now wakes the reviewer on that task, the way the board's
  // wake-ups do, once per head, and only while the head is still the PR's.
  const t = flow({
    env: { AIDENHQ_PRODUCT_REPO: "acme/aidenhq", AIDENHQ_GITHUB_AGENTS_ORG: "acme" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
    computers: ["designer-1"],
  });
  const reviews = (n = 9) => t.paperclip.created.filter((c) => c.title === `Design review: acme/app#${n}`);
  const wakesOf = (task) => t.paperclip.wakes.filter((w) => w.issueId === task.id && w.agentId === "designer-1");
  // The `design-review` statuses the runner itself wrote (the fake gh records them): the pending wait of a head.
  const statuses = () => t.fakeLog().filter((e) => e.kind === "status").map((e) => e.data);
  const runsOf = (task) => t.paperclip.runs.filter((r) => r.issueId === task.id && r.agentId === "designer-1");
  const setPrs = (prs) => writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify(prs));
  const restart = async () => {
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    t.startRunner();
  };
  const uiHead = async (number) => {
    t.step("ui\naidenhq push acme/app feat/ui");
    await t.turn("Restyle the page and push it.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    const state = new State(join(t.dir, "state"));
    state.updateBranch("part", "acme/app", "feat/ui", { pr_url: `https://github.com/acme/app/pull/${number}` });
    state.db.close();
    // Its checks all green on the head, no `design-review` verdict: the head is waiting for its reviewer.
    setPrs({ [number]: { branch: "feat/ui", files: ["web/app.css"], checks: "SUCCESS" } });
    t.step("ui-more\naidenhq push acme/app feat/ui");
    await t.turn("Tweak it and push.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
  };

  it("a head going pending on design-review starts a run on the reviewer's task at once, without the heartbeat", async () => {
    await t.settled();
    const exited = new Promise((r) => t.runner.once("exit", r));
    t.runner.kill("SIGTERM");
    await exited;
    mkdirSync(join(t.dir, "config/grants"), { recursive: true });
    writeFileSync(join(t.dir, "config/grants/grants.json"), JSON.stringify({ autonomy: "tier0", agents: { "designer-1": { key: "ui-reviewer", roles: ["design-review"] } } }));
    writeFileSync(join(t.dir, "secrets/reviewer_key"), `${"r".repeat(64)}\n`, { mode: 0o600 });
    t.startRunner();
    await uiHead(21);

    // No heartbeat routine runs here (the flow's runner has none): the run can only be the wake's.
    await t.waitFor("the review task and the run its wake started", () => reviews(21).length === 1 && runsOf(reviews(21)[0]).length === 1);
    const task = reviews(21)[0];
    assert.deepEqual(wakesOf(task).map((w) => w.agentId), ["designer-1"], "one wake, of the reviewer, on that task");
    assert.equal(t.paperclip.issues.get(task.id).status, "in_progress", "the reviewer is running it");
    assert.match(String(wakesOf(task)[0].body), /design-review/);
    // The same step marked the head waiting: the pending status the check shows, written by the runner, then the wake.
    const pending = statuses().filter((s) => s.number === 21 && s.status?.context === "design-review");
    assert.equal(pending.length, 1, "the head is marked pending once");
    assert.equal(pending[0].status.state, "pending");
    assert.equal(pending[0].status.description, "Waiting for the UI Reviewer");
  });

  it("the same head does not wake the reviewer again while its review is in flight", async () => {
    // The queue re-reads this PR every poll and a restart re-reads it too: neither starts a second task or a second run.
    const task = reviews(21)[0];
    const [patches, created] = [t.paperclip.patches.length, t.paperclip.created.length];
    await restart();
    await t.idle(2500);
    assert.equal(reviews(21).length, 1, "one task for the head");
    assert.equal(wakesOf(task).length, 1, "one wake for the head");
    assert.equal(runsOf(task).length, 1, "one run for it");
    assert.equal(t.paperclip.created.length, created, "nothing filed again");
    assert.equal(t.paperclip.patches.length, patches, "nothing else written");
    assert.equal(statuses().filter((s) => s.number === 21).length, 1, "one pending status for the head, not another");
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

describe("flow-design-review: a head that is gone when its check would go pending", () => {
  // The merge gate reads a green UI PR and asks for its design review; the PR merges as that review task is filed, before the
  // runner wakes it (onIssueCreated, in the fake Paperclip). A head that is gone by then has nothing to review, so its task
  // wakes nobody: it is closed as superseded, as any task whose head moved on is.
  let mergedNow = false;
  const t = flow({
    env: { AIDENHQ_PRODUCT_REPO: "acme/aidenhq", AIDENHQ_GITHUB_AGENTS_ORG: "acme" },
    runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
    computers: ["designer-1"],
    onIssueCreated: ({ issue }) => {
      if (!/^Design review: acme\/app#31$/.test(String(issue.title)) || mergedNow) return;
      mergedNow = true;
      const fixture = join(t.dir, "github-prs.json");
      const prs = JSON.parse(readFileSync(fixture, "utf8"));
      prs[31].merged = true;
      writeFileSync(fixture, JSON.stringify(prs));
    },
  });
  const reviews = () => t.paperclip.created.filter((c) => c.title === "Design review: acme/app#31");

  it("wakes nobody", async () => {
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
    state.updateBranch("part", "acme/app", "feat/ui", { pr_url: "https://github.com/acme/app/pull/31" });
    state.db.close();
    // Open and green when the gate reads it; it merges as the review task is filed.
    writeFileSync(join(t.dir, "github-prs.json"), JSON.stringify({ 31: { branch: "feat/ui", files: ["web/app.css"], checks: "SUCCESS" } }));
    t.step("ui-more\naidenhq push acme/app feat/ui");
    await t.turn("Tweak it and push.");
    assert.equal(t.toolRuns().at(-1).code, 0, t.toolRuns().at(-1).out);
    await t.idle(3000);
    assert.equal(mergedNow, true, "the race ran: the PR merged as its review task was filed");
    assert.equal(t.paperclip.wakes.length, 0, "nobody woken for a head that merged");
    assert.equal(t.fakeLog().filter((e) => e.kind === "status").length, 0, "and nothing marked it waiting either");
    assert.equal(t.paperclip.runs.length, 0, "no run started for it");
    // The task the filing left behind is closed as superseded, not left for a reviewer to pick up.
    for (const task of reviews()) assert.equal(t.paperclip.issues.get(task.id).status, "cancelled", "its task closes as superseded");
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

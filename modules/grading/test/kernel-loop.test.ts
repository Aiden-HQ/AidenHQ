// W7 end to end: the grade loop in the module, on a fake kernel and a fake model gateway. A finished kernel job's graded task is
// graded once the loop runs; a failed criterion reopens it through the finish check's resolve with the note, a pass closes it; the
// model call carries the grader token the kernel minted. The loop is never started by the service until the switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { completionGate, rubricHash } from "../service/src/grades.ts";
import { createGrading } from "../service/src/server.ts";
import { createKernelGradeLoop, verifiedMerges } from "../service/src/kernel-loop.ts";
import { wordsEvidence } from "../service/src/grader/evidence.ts";

const answer = (met) => ({ verdict: met.every((m) => m === "yes") ? "satisfied" : "needs_revision", criteria: met.map((m, i) => ({ id: String(i + 1), met: m, evidence: m === "yes" ? "shown" : "missing" })) });

const noGithub = { pr: async () => { throw new Error("no github"); }, issue: async () => { throw new Error("no github"); }, diff: async () => "", job: async () => null };

test("a kernel job's graded task is graded, reopened with the unmet criterion, then closed on a pass", async (t) => {
  const models = [];
  const answers = [answer(["yes", "no", "yes"]), answer(["yes", "yes", "yes"])];
  const gateway = http.createServer(async (req, res) => {
    models.push({ auth: req.headers.authorization, path: req.url });
    for await (const _ of req);
    if (req.url !== "/api/v1/chat/completions") return void res.writeHead(404).end(JSON.stringify({ error: { code: 404, type: "not_found", message: "no such route" } }));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  }).listen(0);
  t.after(() => gateway.close());

  const issue = { id: "t1", identifier: "WOR-1", title: "report", description: "Report on Legacy.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] }, facts = [];
  const kernel = async (method, path, body) => {
    if (path === "/v1/cp/read/api/issues/t1") return issue;
    if (path === "/v1/cp/read/api/issues/t1/comments") return [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "Legacy is used in acme/app and acme/lib; next step: port app.", createdAt: "2026-11-18T09:00:00Z" }];
    if (path === "/v1/cp/read/api/issues/t1/attachments") return [];
    if (path === "/v1/cp/read/api/agents/eng") return { id: "eng", name: "Dana" };
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === "/v1/work?task=t1") return { busy: false, jobs: [{ id: "j-1", state: "done", engine: "codex", ended_at: new Date(Date.now() - 60_000).toISOString() }], records: [] };
    if (path === "/v1/work/grader-token") return { token: `tok-${body.task}` };
    if (path === "/v1/checks/t1") return calls.resolve.push(body), (issue.status = body.verdict === "ok" ? "done" : "todo"), {};
    if (path === "/v1/wakes") return calls.wake.push(body), { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", runner: "r", board: "b" } });
  grades.file("t1", ["says where Legacy is used", "links each source", "names the next step"], { kind: "report", ref: "" });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => { throw new Error("no attachment bytes"); }, apps: async () => { throw new Error("no apps"); }, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {}, emit: (f) => facts.push(f) });

  completionGate(grades, "t1", "finish_turn"); // the agent finished: the gate holds the task and the row waits for the grader
  // A just-filed row waits 5 s for a bridge close's comment; the clock moves past it.
  const realNow = Date.now;
  let skew = 10_000;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  await loop.runGrades();
  assert.equal(calls.resolve.length, 1);
  assert.equal(calls.resolve[0].verdict, "reopen");
  assert.match(calls.resolve[0].comment, /links each source/);
  assert.equal(models[0].auth, "Bearer tok-t1", "the model call carries the kernel's grader token");

  issue.status = "in_review";
  completionGate(grades, "t1", "finish_turn"); // finished again
  skew += 10_000;
  await loop.runGrades();
  assert.deepEqual(calls.resolve.map((c) => c.verdict), ["reopen", "ok"]);
  assert.equal(grades.get("t1").state, "satisfied");
  // Flow: each attempt is a requested/verdict pair on its own subject, and the reopen is a grade_retry wait that the next attempt ends.
  assert.deepEqual(facts.map((f) => [f.type, f.subject, f.version, f.data.pass ?? f.data.reason]), [
    ["grade.requested", "grade:t1:1", "1", undefined], ["grade.verdict", "grade:t1:1", "1", false], ["work.waiting", "task:t1", "1", "grade_retry"],
    ["work.resumed", "task:t1", "1", "grade_retry"], ["grade.requested", "grade:t1:2", "2", undefined], ["grade.verdict", "grade:t1:2", "2", true],
  ]);
  assert.ok(facts.every((f) => f.task === "t1"));
});

test("a graded PR task's PR is read through the broker's token and graded; a PR GitHub cannot be read holds the row", async (t) => {
  const answers = [];
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  }).listen(0);
  t.after(() => gateway.close());

  const issue = { id: "t2", identifier: "WOR-2", title: "fix", description: "Fix it.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], tokens: [] };
  const pr = { number: 7, url: "https://github.com/acme-agents/app/pull/7", state: "MERGED", title: "Fix it", body: "Fixes the thing.", headRefOid: "a".repeat(40), headRefName: "fix-it", baseRefName: "main", mergedAt: "2026-11-18T09:00:00Z", mergeCommit: { oid: "b".repeat(40) },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] }, history: { nodes: [] }, files: { pageInfo: {}, nodes: [] } };
  const kernel = async (method, path, body) => {
    if (path === "/v1/cp/read/api/issues/t2") return issue;
    if (path === "/v1/cp/read/api/issues/t2/comments") return [];
    if (path === "/v1/cp/read/api/issues/t2/attachments") return [];
    if (path === "/v1/cp/read/api/agents/eng") return { id: "eng", name: "Dana" };
    if (path === "/v1/work?task=t2") return { busy: false, jobs: [{ id: "j-2", state: "done", engine: "codex", ended_at: new Date(Date.now() - 60_000).toISOString() }], records: [{ id: "r1", kind: "github.pr", state: "done", ok: true, args: { workspace: "WOR-2", only: [{ repo: "acme-agents/app", branch: "fix-it", sha: "a".repeat(40) }] }, outcome_text: "PRs: https://github.com/acme-agents/app/pull/7" }] };
    if (path === "/v1/work/grader-token") return { token: "tok" };
    if (path === "/v1/checks/t2") return calls.resolve.push(body), {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  let readable = true;
  const github = { pr: async (repo, n) => { calls.tokens.push(`${repo}#${n}`); if (!readable) throw new Error("GitHub has no readable PR"); return { repository: { pullRequest: pr } }; }, diff: async () => "diff --git a/x b/x\n+fixed" };
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", runner: "r", board: "b" } });
  grades.file("t2", ["the change fixes the thing"], { kind: "pr", ref: "https://github.com/acme-agents/app/pull/7" });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => { throw new Error("no bytes"); }, apps: async () => { throw new Error("no apps"); }, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github, log: () => {} });
  completionGate(grades, "t2", "finish_turn");
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  t.after(() => { Date.now = realNow; });

  readable = false;
  await loop.runGrades().catch(() => {});
  assert.equal(calls.resolve.length, 0, "an unreadable PR is no evidence: nothing is passed or reopened");

  readable = true;
  Date.now = () => realNow() + 20 * 60_000; // past the retry wait
  answers.push(answer(["yes"]));
  await loop.runGrades();
  assert.deepEqual(calls.resolve.map((c) => c.verdict), ["ok"]);
  assert.equal(grades.get("t2").state, "satisfied");
});

test("a revision move queued by a verdict on a rubric since amended never reopens the task", async () => {
  // The store and the owed queue are separate: amend() restarts the row, but a reopen a needs_revision verdict already queued
  // would still move the task back to todo. The loop reads the row's state first and drops that step.
  const issue = { id: "t5", identifier: "WOR-5", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  grades.file("t5", filed, { kind: "report", ref: "" });
  grades.record("t5", { version: "v1", outcome: "needs_revision", model: "m", criteria: [{ id: "1", met: "no", evidence: "missing" }], rubric: rubricHash(filed, { kind: "report", ref: "" }, 0) });
  const corrected = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  grades.amend("t5", corrected, { by: "agent:cos", delegator: "agent:cos" });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  // The reopen the old verdict queued, as the pass before the amendment left it.
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t5', ?)").run(JSON.stringify([{ do: "reopen", note: "the grader sent it back" }]));
  await loop.runGrades();
  assert.equal(calls.resolve.length, 0, "the stale reopen is dropped, not resolved");
  assert.equal(issue.status, "in_review");
  assert.deepEqual(grades.get("t5").rubric, corrected);
  // A reopen queued for a row still in needs_revision does move the task: the guard is the amended row, not the step.
  grades.record("t5", { version: "v2", outcome: "needs_revision", model: "m", criteria: [{ id: "1", met: "no", evidence: "missing" }], rubric: rubricHash(corrected, { kind: "report", ref: "" }, 1) });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t5', ?)").run(JSON.stringify([{ do: "reopen", note: "the grader sent it back" }]));
  await loop.runGrades();
  assert.equal(issue.status, "todo");
});

test("a close queued before filings were named is checked against the row, and dropped when it was amended", async () => {
  // A step saved before closes carried a filing names none. It must not replay onto a rubric amended since: the row is read
  // instead, and the close is dropped rather than closing the task on a criterion the amendment replaced.
  const issue = { id: "t9", identifier: "WOR-9", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  grades.file("t9", filed, { kind: "report", ref: "" });
  const corrected = ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"];
  grades.amend("t9", corrected, { by: "agent:cos", delegator: "agent:cos" });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  // A close the pass before the amendment queued: it carries no filing, and its version is whatever the report's evidence
  // reads now, so the version check passes and only the filing check can stop it landing on the amended row.
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t9', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", deliverable: { kind: "report", ref: "" }, rubric: filed }]));
  await loop.runGrades();
  assert.equal(issue.status, "in_review", "the stale close is not replayed onto the amended row");
  assert.deepEqual(calls.resolve, [], "the task is not closed on a filing the amendment replaced");
  // Neither the close nor the notice worded for it is owed any more: the queue is cleared, not retried every pass.
  assert.equal(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t9'").get()?.v ?? "", "", "the stale steps are dropped from the queue");
});

test("a close queued before filings were named still lands when its row is the same satisfied one", async () => {
  // The recovery must not over-drop: a step saved before filings were named, on a row that is still satisfied at the same
  // rubric and deliverable, is that row's close and lands.
  const issue = { id: "t11", identifier: "WOR-11", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  grades.file("t11", filed, { kind: "report", ref: "" });
  grades.record("t11", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, { kind: "report", ref: "" }, 0) });
  assert.equal(grades.get("t11").state, "satisfied");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t11', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", deliverable: { kind: "report", ref: "" }, rubric: filed }]));
  await loop.runGrades();
  assert.equal(issue.status, "done", "the close lands on the row it was queued for");
});

test("a wake for missing evidence is not applied to a row amended while the pass ran", async (t) => {
  // The wake moves the task back to todo, so it is the same staleness as a verdict: only the filing the pass read may wake it.
  // An app deliverable that is not deployed awaits evidence, so the pass reaches the wake path.
  const issue = { id: "t10", identifier: "WOR-10", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const kernel = async (method, path, body) => {
    if (path === "/v1/cp/read/api/issues/t10") return issue;
    if (path.endsWith("/comments")) return [];
    if (path.endsWith("/attachments")) return [];
    if (path === "/v1/cp/read/api/agents/eng") return { id: "eng", name: "Dana" };
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === "/v1/work?task=t10") return { busy: false, jobs: [], records: [] };
    if (path === "/v1/checks/t10") return calls.resolve.push(body.verdict), (issue.status = body.verdict === "ok" ? "done" : "todo"), {};
    if (path === "/v1/wakes") return calls.wake.push(body), { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  grades.file("t10", ["says where Legacy is used", "links each source", "names the next step"], { kind: "app", ref: "roadmap-keeper" });
  completionGate(grades, "t10", "finish_turn");
  // The amendment lands after the pass took the row it is grading, before it acts on the wait.
  let amended = false;
  const loop = createKernelGradeLoop({ db, runner, due: () => {
    const list = grades.due();
    if (!amended && list.some((x) => x.issueId === "t10")) {
      amended = true;
      grades.amend("t10", ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"], { by: "agent:cos", delegator: "agent:cos" });
    }
    return { grades: list, resubmitted: [] };
  }, kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  // Past the wake grace (two minutes), well inside the day a grade waits.
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  t.after(() => { Date.now = realNow; });
  await loop.runGrades();
  assert.deepEqual(calls.wake, [], "an amended row is not woken for evidence its old filing was waiting on");
  assert.equal(issue.status, "in_review", "the task is not moved back to todo for a filing it no longer holds");
});

test("a reopen whose grade-state read fails is retried, never replayed or dropped", async () => {
  // A failed read is not "the row was amended": replaying the move would reopen a task the amendment restarted, and dropping
  // it would lose a revision the grader still owes. The step stays queued and the next pass asks again.
  const issue = { id: "t6", identifier: "WOR-6", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  grades.file("t6", filed, { kind: "report", ref: "" });
  grades.record("t6", { version: "v1", outcome: "needs_revision", model: "m", criteria: [{ id: "1", met: "no", evidence: "missing" }], rubric: rubricHash(filed, { kind: "report", ref: "" }, 0) });
  // The loop's own api: the grade-state read fails on the first pass, then answers.
  let reads = 0;
  const loop = createKernelGradeLoop({ db, runner: async (m, p, b) => {
    if (m === "GET" && /^\/internal\/grades\/[^/]+$/.test(p)) { reads++; if (reads === 1) throw new Error("grading is restarting"); }
    return runner(m, p, b);
  }, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t6', ?)").run(JSON.stringify([{ do: "reopen", note: "the grader sent it back" }]));
  await loop.runGrades();
  assert.equal(calls.resolve.length, 0, "a failed read never moves the task");
  assert.equal(issue.status, "in_review");
  assert.ok(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t6'").get()?.v, "the step is still queued");
  await loop.runGrades();
  assert.equal(issue.status, "todo", "the retried read says needs_revision, so the move lands");
});

test("an amended rubric on work already in review is graded at once, without another finish", async (t) => {
  // The row restarts open, as a differing re-file's does. `resume` is what has the runner grade the work already submitted
  // against the new list: without it the row would sit open until the assignee finished again for a change they did not make.
  const answers = [];
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t7", identifier: "WOR-7", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  grades.file("t7", filed, { kind: "report", ref: "" });
  const corrected = ["the report names the Legacy callers", "it links each source", "it names the next step"];
  // In review, so the amendment restarts the row open and requeues it; the assignee never finishes again.
  grades.amend("t7", corrected, { by: "agent:cos", delegator: "agent:cos", held: true });
  assert.equal(grades.get("t7").state, "open");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  t.after(() => { Date.now = realNow; });
  answers.push(answer(["yes", "yes", "yes"]));
  await loop.runGrades();
  assert.deepEqual(calls.resolve, ["ok"], "the resumed row is graded and the task closes");
  const g = grades.get("t7");
  assert.equal(g.state, "satisfied");
  assert.equal(g.resume, false, "a settled row is no longer the restarted one the runner had to pick up");
});

test("a resumed row waits out the completion-comment grace before it is graded", async (t) => {
  // The assignee finishes and the delegator amends before the bridge posts the finishing comment: grading the restarted row in
  // that window would send the task back for evidence the incoming comment supplies.
  const answers = [];
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t8", identifier: "WOR-8", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  grades.file("t8", filed, { kind: "report", ref: "" });
  grades.amend("t8", ["the report names the Legacy callers", "it links each source", "it names the next step"], { by: "agent:cos", delegator: "agent:cos", held: true });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  // Inside the grace: nothing is asked of the grader.
  await loop.runGrades();
  assert.equal(calls.resolve.length, 0);
  assert.equal(grades.get("t8").state, "open");
  // Past it, the same resumed row is graded.
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  t.after(() => { Date.now = realNow; });
  answers.push(answer(["yes", "yes", "yes"]));
  await loop.runGrades();
  assert.deepEqual(calls.resolve, ["ok"]);
});

test("a merge counts only as its executor wrote it on a record that ended ok, never by the args an agent filed", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  const line = `merged-prs: ${JSON.stringify([{ repo: "acme-agents/app", number: 7, head: a, sha: b }])}`;
  const args = { prs: [{ repo: "acme-agents/app", number: 9, head: a }] };
  assert.deepEqual(verifiedMerges({ state: "done", ok: true, args, outcome_text: `${line}\n\nMerged #7.` }), [{ repo: "acme-agents/app", number: 7, head: a, sha: b }]);
  assert.deepEqual(verifiedMerges({ state: "failed", ok: false, args, outcome_text: `${line}\n\nStopped.` }), [], "a failed merge never counts");
  assert.deepEqual(verifiedMerges({ state: "done", ok: true, args, outcome_text: "Merged #9." }), [], "args naming a PR are no evidence");
  assert.deepEqual(verifiedMerges({ state: "done", ok: true, args, outcome_text: `merged-prs: []\n\n${line}` }), [], "only the first line counts");
});

// The kernel's finish-check hold as checks.ts keeps it: the grader token and a resolve (ok, reopen, block) need it.
function heldKernel(issue, calls) {
  let held = true;
  const kernel = async (method, path, body) => {
    if (path === `/v1/cp/read/api/issues/${issue.id}`) return issue;
    if (path.endsWith("/comments")) return [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }];
    if (path.endsWith("/attachments")) return [];
    if (path === "/v1/cp/read/api/agents/eng") return { id: "eng", name: "Dana" };
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === `/v1/work?task=${issue.id}`) return { busy: false, jobs: [], records: [] };
    if (path === "/v1/work/grader-token") { if (!held) throw new Error("kernel POST /v1/work/grader-token → 403"); return { token: "tok" }; }
    if (path === `/v1/checks/${issue.id}`) {
      calls.resolve.push(body.verdict);
      if (!held) throw new Error("kernel POST /v1/checks → 409: holds no finish");
      held = false;
      issue.status = { ok: "done", reopen: "todo", block: "blocked" }[body.verdict];
      return {};
    }
    if (path === "/v1/wakes") return calls.wake.push(body), { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { kernel };
}

test("a grader that keeps failing keeps its hold, then closes the task done, ungraded, and tells its parent", async (t) => {
  let n = 0;
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req);
    n++;
    res.writeHead(502).end("upstream down");
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t4", identifier: "WOR-4", title: "report", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  grades.file("t4", ["says it"], { kind: "report", ref: "" });
  completionGate(grades, "t4", "finish_turn");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  const realNow = Date.now;
  let skew = 10_000;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  for (let i = 0; i < 5; i++) { await loop.runGrades(); skew += 2 * 60 * 60_000; }
  assert.equal(n, 5, "a 5xx is never retried on the next model, and every pass got its token");
  assert.deepEqual(calls.resolve, ["ok"]);
  assert.equal(issue.status, "done");
  assert.equal(calls.wake.length, 1);
  assert.equal(calls.wake[0].task, "p1");
  assert.match(calls.wake[0].text, /WOR-4 .* is done, ungraded: /);
  await loop.runGrades();
  assert.equal(n, 5, "a closed task is not graded again");
});

/**
 * A fake kernel for a grade whose rubric names another task: the graded task, the named task's read and attachments, and the
 * agents read. `named` and `attachments` are what those reads answer, so a test can make them a 404, a 5xx or another company.
 */

test("a claimed record keeps its task's grade open, and the grade runs once it ends", async (t) => {
  // The kernel's `claimed` state is a live record (the board's `running`): the grade must wait on it rather than read it as a
  // consumed card, which is what folding `claimed` into `used` with no outcome did.
  const prompts = [];
  const gateway = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    prompts.push(JSON.parse(body).messages.at(-1).content);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(["yes"])) } }] }));
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t12", identifier: "WOR-12", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const record = { id: "k-claim1", kind: "github.merge", state: "claimed", ok: null, args: {}, wait: "code review: 1 important finding open", updated_at: "2026-11-20T16:00:00Z", created_at: "2026-11-20T15:58:00Z" };
  const kernel = async (method, path, body) => {
    if (path === `/v1/cp/read/api/issues/${issue.id}`) return issue;
    if (path.endsWith("/comments")) return [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "Done.", createdAt: "2026-11-18T09:00:00Z" }];
    if (path.endsWith("/attachments")) return [];
    if (path === "/v1/cp/read/api/agents/eng") return { id: "eng", name: "Dana" };
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === `/v1/work?task=${issue.id}`) return { busy: false, jobs: [{ id: "j", state: "done", engine: "codex", ended_at: new Date(Date.now() - 60_000).toISOString() }], records: [record] };
    if (path === "/v1/work/grader-token") return { token: "tok" };
    if (path === `/v1/checks/${issue.id}`) return calls.resolve.push(body.verdict), (issue.status = body.verdict === "ok" ? "done" : "todo"), {};
    if (path === "/v1/wakes") return calls.wake.push(body), { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release: async () => {} }, keys: { check: "c", runner: "r", board: "b" } });
  grades.file(issue.id, ["it says it"], { kind: "report", ref: "" });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  completionGate(grades, issue.id, "finish_turn");
  const realNow = Date.now;
  let skew = 10_000;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  await loop.runGrades();
  // The row's own state is the wait: an awaiting verdict goes to the grade store, never a resolve on the task.
  assert.equal(grades.get(issue.id).state, "awaiting_evidence", "a claimed record holds the grade open");
  assert.equal(prompts.length, 0, "nothing is graded while the record is still claimed");
  assert.deepEqual(calls.wake, [], "a live record is never a stalled wait");
  assert.deepEqual(calls.resolve, [], "a live record is not a verdict on the task");

  record.state = "done"; record.ok = true; record.updated_at = "2026-11-20T17:00:00Z";
  issue.status = "in_review";
  completionGate(grades, issue.id, "finish_turn");
  skew += 2 * 60_000; // an awaiting row is looked at again a minute later
  await loop.runGrades();
  assert.deepEqual(calls.resolve, ["ok"], "the grade runs once the record ends");
  assert.equal(prompts.length, 1);
});

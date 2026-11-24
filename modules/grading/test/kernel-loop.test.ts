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
    ["grade.requested", "grade:t1:1:1", "1:1", undefined], ["grade.verdict", "grade:t1:1:1", "1:1", false], ["work.waiting", "task:t1", "1", "grade_retry"],
    ["work.resumed", "task:t1", "1", "grade_retry"], ["grade.requested", "grade:t1:3:2", "3:2", undefined], ["grade.verdict", "grade:t1:3:2", "3:2", true],
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

test("a filing-less close is dropped when the rubric was amended away and back", async () => {
  // The words cannot tell the filings apart: A→B→A leaves the row holding A, so only the revision shows the close is stale.
  const issue = { id: "t12", identifier: "WOR-12", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  grades.file("t12", filed, { kind: "report", ref: "" });
  grades.amend("t12", ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"], { by: "agent:cos", delegator: "agent:cos" });
  grades.amend("t12", filed, { by: "agent:cos", delegator: "agent:cos" });
  assert.equal(grades.get("t12").revision, 2);
  grades.record("t12", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, { kind: "report", ref: "" }, 2) });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  // A close from before filings were named: same words, but the row is at revision 2, so it is not that close.
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t12', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", deliverable: { kind: "report", ref: "" }, rubric: filed }]));
  await loop.runGrades();
  assert.equal(issue.status, "in_review", "the close from the first A does not land on the row amended back to A");
  assert.equal(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t12'").get()?.v ?? "", "", "the stale steps are dropped");
});

test("an amendment landing between the checks and the close stops the close", async () => {
  // The close's checks (evidence, presence, children) take time, and an amendment can land inside it. The filing is read once
  // more immediately before the close, so the task is not closed on a rubric replaced while the pass was deciding.
  const issue = { id: "t13", identifier: "WOR-13", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  grades.file("t13", filed, { kind: "report", ref: "" });
  grades.record("t13", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, { kind: "report", ref: "" }, 0) });
  // The amendment lands on the second row read of the close (the one just before it): the first read still matches.
  let reads = 0, amended = false;
  const loop = createKernelGradeLoop({ db, runner: async (m, p, b) => {
    if (m === "GET" && /^\/internal\/grades\/[^/]+$/.test(p)) {
      reads++;
      if (reads === 2 && !amended) {
        amended = true;
        grades.amend("t13", ["the diff removes every `Linus` line from docs/a.md", "merged into main", "checks green on the head"], { by: "agent:cos", delegator: "agent:cos" });
      }
    }
    return runner(m, p, b);
  }, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t13', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", deliverable: { kind: "report", ref: "" }, rubric: filed, filing: rubricHash(filed, { kind: "report", ref: "" }, 0) }]));
  await loop.runGrades();
  assert.equal(issue.status, "in_review", "the close does not land after an amendment mid-check");
  assert.deepEqual(calls.resolve, [], "no close is sent");
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
  const models = [];
  const gateway = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    models.push(JSON.parse(body).model);
    n++;
    res.writeHead(502).end("upstream down");
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t4", identifier: "WOR-4", title: "report", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] }, facts = [];
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  grades.file("t4", ["says it"], { kind: "report", ref: "" });
  completionGate(grades, "t4", "finish_turn");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {}, emit: (f) => facts.push(f) });
  const realNow = Date.now;
  let skew = 10_000;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  for (let i = 0; i < 5; i++) {
    await loop.runGrades();
    const posted = calls.wake.length;
    await loop.runGrades(); // the row is not due again before its retry wait: nothing is asked or posted
    assert.equal(calls.wake.length, posted, `pass ${i + 1}: a row waiting out its retry ladder posts nothing more`);
    assert.equal(models.length, 2 * (i + 1), `pass ${i + 1}: one failed pass asks both models once`);
    skew += 2 * 60 * 60_000;
  }
  assert.equal(n, 10, "a 5xx falls over to the next model: both are asked on every one of the 5 passes");
  assert.deepEqual(models.slice(0, 2), ["~openai/gpt-luna-latest", "~z-ai/glm-flash-latest"], "Luna first, then GLM Flash");
  // Each of the first four failed passes leaves one note on the task, saying why and when the ladder asks again; the fifth
  // settles the row satisfied and closes it, so its note is the close's, not a retry note.
  const notes = calls.wake.filter((w) => w.task === "t4");
  assert.equal(notes.length, 4, "one note per failed pass, and none for the pass that closes");
  assert.ok(notes.every((w) => /Grading failed; retrying/.test(w.text) && /OpenRouter 502/.test(w.text)), "the note names the grader's reason");
  assert.deepEqual(notes.map((w) => /the grader runs again in (\d+) minutes?/.exec(w.text)?.[1]), ["1", "5", "15", "60"], "and the retry ladder's wait");
  assert.equal(new Set(notes.map((w) => w.id)).size, 4, "each pass's note carries its own id, so a retried post lands once");
  assert.ok(notes.every((w) => w.quiet === true), "the note wakes nobody: a failed pass has nothing for the agent to act on");
  assert.ok(notes.every((w) => !w.text.includes("aidenhq:grader")), "the kernel writes the grader's marker itself; the note's text carries no escaped copy");
  // Each failed pass is a grade_retry wait on the task, as a rejected version is: one fact per pass, not one per subject version.
  const waits = facts.filter((f) => f.type === "work.waiting" && f.task === "t4" && f.data.reason === "grade_retry");
  assert.equal(waits.length, 4);
  assert.equal(new Set(waits.map((f) => f.subject)).size, 1, "all four waits are on the task's one subject");
  assert.equal(new Set(waits.map((f) => f.version)).size, 4, "and each pass has its own version, so the log keeps all four");
  // A retry after a failed pass keeps the attempt (nothing was rejected) but moves the round, so its stage facts are their own:
  // keyed by the attempt alone they would reuse the failed pass's ids and Flow would drop them as duplicates.
  const requested = facts.filter((f) => f.type === "grade.requested" && f.task === "t4");
  assert.equal(requested.length, 5, "every pass asks the grader once");
  assert.equal(new Set(requested.map((f) => f.subject)).size, 5, "and each pass's request is its own stage");
  assert.equal(new Set(requested.map((f) => f.version)).size, 5, "the log keeps all five");
  const verdicts = facts.filter((f) => f.type === "grade.verdict" && f.task === "t4");
  assert.equal(new Set(verdicts.map((f) => f.subject)).size, 5, "so is each verdict");
  // Each wait is ended by the next pass's resumed fact on the same subject: a retrying task is not counted as waiting while it
  // is being graded again.
  const resumed = facts.filter((f) => f.type === "work.resumed" && f.task === "t4");
  assert.equal(resumed.length, 4, "passes 2-5 each resume the wait the pass before them left");
  assert.ok(waits.slice(0, 4).every((w, i) => resumed[i].version === w.version), "each resume names the wait it ends");
  assert.deepEqual(calls.resolve, ["ok"]);
  assert.equal(issue.status, "done");
  assert.equal(calls.wake.length, 5, "four failed-pass notes and one parent notice");
  assert.equal(calls.wake.at(-1).task, "p1");
  assert.match(calls.wake.at(-1).text, /WOR-4 .* is done, ungraded: /);
  await loop.runGrades();
  assert.equal(n, 10, "a closed task is not graded again");
});

test("a grading-failed note is posted for the pass it reports, and dropped once the row has moved on", async () => {
  const issue = { id: "t9", identifier: "WOR-9", title: "report", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const rubric = ["says it"];
  grades.file("t9", rubric, { kind: "report", ref: "" });
  const row = grades.record("t9", { version: "v1", outcome: "grading_failed", model: "m", criteria: [], rubric: rubricHash(rubric, { kind: "report", ref: "" }, 0) });
  assert.equal(row.state, "grading_failed");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const step = (round) => JSON.stringify([{ do: "note", note: "**Grading failed; retrying.** (the grader failed).", id: "grade-retry-t9-1", round }]);
  // A note queued for a round the row has moved past (a later pass, or an amendment) is stale: it is dropped, not posted.
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t9', ?)").run(step(row.round + 5));
  await loop.runGrades();
  assert.equal(calls.wake.length, 0, "a note for another round is not posted");
  // The row's own pass is still grading_failed: its note lands, carrying the id a retried post is deduped on.
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t9', ?)").run(step(row.round));
  await loop.runGrades();
  assert.equal(calls.wake.length, 1);
  assert.equal(calls.wake[0].task, "t9");
  assert.equal(calls.wake[0].id, "grade-retry-t9-1");
  assert.equal(calls.wake[0].quiet, true, "posted as a quiet note, never a wake");
});

test("a deferred failed-pass note says what is left of the retry when it is posted, not when it was queued", async () => {
  // The note's post can be delayed (a 502 from the kernel). Its text is rendered when it lands, from the ladder's due time, so a
  // note that waited out the first minute does not promise a retry that has already happened.
  const issue = { id: "t32", identifier: "WOR-32", title: "report", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const rubric = ["says it"];
  grades.file("t32", rubric, { kind: "report", ref: "" });
  const row = grades.record("t32", { version: "v1", outcome: "grading_failed", model: "m", criteria: [], rubric: rubricHash(rubric, { kind: "report", ref: "" }, 0) });
  const realNow = Date.now;
  let now = Date.parse(row.failedAt!);
  Date.now = () => now;
  try {
    const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
    const step = (retryAt) => JSON.stringify([{ do: "note", note: "**Grading failed; retrying.** (stale).", id: "grade-retry-t32-1", round: row.round, retryAt,
      render: { g: { model: "m", criteria: [], reason: "the grader failed (OpenRouter 502)" }, rubric, version: "v1" } }]);
    // The post was tried when the note was queued, failed, and is retried 50 s into the ladder's one-minute wait.
    now += 50_000;
    db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t32', ?)").run(step(new Date(Date.parse(row.failedAt!) + 60_000).toISOString()));
    await loop.runGrades();
    assert.equal(calls.wake.length, 1);
    assert.match(calls.wake[0].text, /the grader runs again in 1 minute/, "50 s left of the wait, not the 1 minute the note was queued with");
    // Posted after the wait is spent: it says the retry is due now rather than promising a minute that has passed.
    now += 30_000;
    db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t32', ?)").run(step(new Date(Date.parse(row.failedAt!) + 60_000).toISOString()));
    await loop.runGrades();
    assert.equal(calls.wake.length, 2);
    assert.match(calls.wake[1].text, /the grader runs again shortly/);
  } finally {
    Date.now = realNow;
  }
});

test("an amendment that replaces the failed round ends its retry wait", async () => {
  // The owner amends the rubric while the grader waits out the ladder. The row restarts `open` at a new round, so the failed
  // round's pass is never retried; without this, Flow reports grade_retry for the task forever. The amended pass here finds its
  // evidence unavailable (an app that is not deployed), which is exactly the branch that leaves the row waiting on something
  // other than the retry ladder.
  const issue = { id: "t33", identifier: "WOR-33", title: "app", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] }, facts = [];
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const rubric = ["the app is deployed"];
  grades.file("t33", rubric, { kind: "app", ref: "roadmap-keeper" });
  const row = grades.record("t33", { version: "v1", outcome: "grading_failed", model: "m", criteria: [], rubric: rubricHash(rubric, { kind: "app", ref: "roadmap-keeper" }, 0) });
  // No row is due: the amended row is open and not resumed (the agent is still working), so no pass will look at it. The wait
  // must end anyway.
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {}, emit: (f) => facts.push(f) });
  // The failed pass left its wait (the loop recorded it when it queued the note).
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('grade-wait:t33', ?)").run(JSON.stringify({ round: row.round }));
  grades.amend("t33", ["the app is deployed", "and it serves the page", "and the page loads"], { by: "agent:cos", delegator: "agent:cos" });
  assert.equal(grades.get("t33").state, "open");
  assert.equal(grades.get("t33").resume, false, "not resumed: nothing grades it until the agent finishes");
  await loop.runGrades();
  const resumed = facts.filter((f) => f.type === "work.resumed" && f.task === "t33");
  assert.equal(resumed.length, 1, "the failed round's wait is resumed");
  assert.equal(resumed[0].version, `round:${row.round}`, "naming the round the failed pass left");
  assert.equal(db.prepare("SELECT v FROM loop_state WHERE k = 'grade-wait:t33'").get()?.v ?? "", "", "and the marker is cleared");
  // A row still on the failed round keeps its wait: the ladder has not asked again yet.
  const again = grades.record("t33", { version: "v2", outcome: "grading_failed", model: "m", criteria: [], rubric: rubricHash(["the app is deployed", "and it serves the page", "and the page loads"], { kind: "app", ref: "roadmap-keeper" }, 1) });
  assert.equal(again.state, "grading_failed");
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('grade-wait:t33', ?)").run(JSON.stringify({ round: again.round }));
  await loop.runGrades();
  assert.equal(facts.filter((f) => f.type === "work.resumed" && f.task === "t33").length, 1, "a row still failed keeps its wait open");
  assert.ok(db.prepare("SELECT v FROM loop_state WHERE k = 'grade-wait:t33'").get()?.v, "and its marker stays");
});

test("a failed pass whose verdict the store dropped posts no note and no wait", async () => {
  // The store drops a verdict computed on a filing or round that moved while the pass ran, and answers the row as it stands.
  // The note is worded from this pass's verdict and keyed on the round it produced, so a dropped pass must not post it or
  // claim a wait: the next pass grades what the row holds now, and its own note reports that pass.
  const issue = { id: "t30", identifier: "WOR-30", title: "report", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] }, facts = [];
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const rubric = ["says it"];
  grades.file("t30", rubric, { kind: "report", ref: "" });
  const row = grades.record("t30", { version: "v1", outcome: "grading_failed", model: "m", criteria: [], rubric: rubricHash(rubric, { kind: "report", ref: "" }, 0) });
  assert.equal(row.state, "grading_failed");
  const gateway = http.createServer(async (req, res) => { for await (const _ of req); res.writeHead(502).end("upstream down"); }).listen(0);
  const drop = async (m, p, b) => {
    // The store took nothing: its answer is the row as it stood before the pass.
    if (m === "POST" && p === "/internal/grades/t30/verdict") return grades.get("t30");
    return runner(m, p, b);
  };
  const loop = createKernelGradeLoop({ db, runner: drop, due: () => ({ grades: [grades.get("t30")], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {}, emit: (f) => facts.push(f) });
  try {
    await loop.runGrades();
  } finally {
    gateway.close();
  }
  assert.deepEqual(calls.wake, [], "a dropped pass posts no note");
  assert.equal(facts.filter((f) => f.type === "work.waiting").length, 0, "and claims no wait");
  assert.equal(grades.get("t30").round, row.round, "the row is where it was");
});

test("a retry that finds its evidence unavailable still ends the failed pass's wait", async () => {
  // The resumed fact is emitted before the pass can branch: a retry whose evidence is not there yet goes back to
  // awaiting_evidence, and a wait left open would have Flow report grade_retry for a task that left the ladder.
  const issue = { id: "t31", identifier: "WOR-31", title: "report", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] }, facts = [];
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const rubric = ["the app is deployed"];
  grades.file("t31", rubric, { kind: "app", ref: "roadmap-keeper" });
  const row = grades.record("t31", { version: "v1", outcome: "grading_failed", model: "m", criteria: [], rubric: rubricHash(rubric, { kind: "app", ref: "roadmap-keeper" }, 0) });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [grades.get("t31")], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {}, emit: (f) => facts.push(f) });
  await loop.runGrades();
  const resumed = facts.filter((f) => f.type === "work.resumed" && f.task === "t31");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].version, `round:${row.round}`, "it names the wait the failed pass left");
  assert.equal(grades.get("t31").state, "awaiting_evidence", "the retry is waiting for evidence, not on the retry ladder");
  assert.deepEqual(calls.wake, [], "nothing is posted on the task for a wait");
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

test("a close is bound to the round it was decided on: a re-filed submission is not closed by the pass before it", async () => {
  // The assignee submits again while the close is waiting: the row goes back to pending for the new submission, but the filing
  // (its rubric and deliverable) is unchanged, so only the round tells the two passes apart.
  const issue = { id: "t14", identifier: "WOR-14", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t14", filed, deliverable);
  grades.record("t14", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  const before = grades.get("t14");
  // The assignee finishes again: the gate parks the row for the new submission, leaving the filing's words as they were.
  completionGate(grades, "t14", "finish_turn");
  assert.equal(grades.get("t14").state, "pending");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t14', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", round: before.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }]));
  await loop.runGrades();
  assert.equal(issue.status, "in_review", "the close from the satisfied pass does not land on the new submission");
  assert.deepEqual(calls.resolve, [], "no close is sent");
});

test("a close queued for a task cancelled meanwhile is dropped, not applied", async () => {
  // An owner cancels the task while the grader is checking its evidence. The close must not overwrite `cancelled` with `done`
  // and tell the parent the work passed. The cancel lands on the close's last read of the row (just before the write), so the
  // stale-evidence branch above never sees it: only the guard before the write keeps `cancelled`.
  const issue = { id: "t15", identifier: "WOR-15", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t15", filed, deliverable);
  const g = grades.record("t15", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  let reads = 0;
  const read = async (m, p, b) => {
    const r = await runner(m, p, b);
    // The row's reads: the first when the step is replayed, the second immediately before the close.
    if (m === "GET" && /^\/internal\/grades\/[^/]+$/.test(p) && ++reads === 2) issue.status = "cancelled";
    return r;
  };
  // The kernel refuses a resolve whose task moved on since the decision: `cancelled` is not `in_review`.
  const held = kernel;
  const strict = async (m, p, b) => {
    if (m === "POST" && p === "/v1/checks/t15" && b?.expectStatus !== undefined && b.expectStatus !== issue.status)
      throw Object.assign(new Error(`the task is ${issue.status}, not ${b.expectStatus}`), { status: 409 });
    return held(m, p, b);
  };
  const loop = createKernelGradeLoop({ db, runner: read, due: () => ({ grades: [], resubmitted: [] }), kernel: strict, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t15', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", round: g.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }, { do: "tell", issue: { id: "t15", parentId: "p1" }, kind: "done", who: "WOR-15 (Dana)", title: "report", identifier: "WOR-15" }]));
  await loop.runGrades();
  assert.equal(issue.status, "cancelled", "the cancel stands");
  assert.deepEqual(calls.resolve, [], "no close is sent");
  assert.deepEqual(calls.wake, [], "the parent is not told the work passed");
  assert.equal(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t15'").get()?.v ?? "", "", "the close and its notice are dropped together");
});

test("a graded close refused because the owner handed the task back is requeued, not left satisfied", async () => {
  // The owner moves the task from in_review back to todo while the close is being decided. The kernel refuses the close (the
  // state it was decided on is gone), and the row must go back to grading: left satisfied, the new submission is never picked
  // up and the task sits in review forever.
  const issue = { id: "t18", identifier: "WOR-18", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t18", filed, deliverable);
  const g = grades.record("t18", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  // The hand-back lands after the close read the task and before the kernel writes: the kernel's status precondition refuses it.
  const handed = async (m, p, b) => {
    if (m === "POST" && p === "/v1/checks/t18" && b?.verdict === "ok" && b.expectStatus === "in_review") {
      issue.status = "todo";
      throw Object.assign(new Error("WOR-18 is todo, not in_review"), { status: 409 });
    }
    return kernel(m, p, b);
  };
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel: handed, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t18', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", round: g.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }]));
  await loop.runGrades();
  assert.equal(issue.status, "todo", "the hand-back stands");
  assert.equal(grades.get("t18").state, "awaiting_evidence", "the row is requeued for grading, not left satisfied");
  assert.deepEqual(grades.due().map((x) => x.issueId), ["t18"], "the next pass grades the handed-back work again");
});

test("a deferred notice naming no filing or round is not sent", async () => {
  // A notice that names neither cannot be checked against the row, so it could describe a grade that was restarted since.
  // Telling the parent "graded against its rubric" then is worse than the notice being lost: the task is done either way.
  const issue = { id: "t22", identifier: "WOR-22", title: "report", description: "Report.", status: "done", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t22", filed, deliverable);
  // The row is satisfied at revision 0, so a legacy-shaped step naming its rubric and deliverable would pass the old
  // status-only check and be sent — even though it cannot name the round it reports.
  grades.record("t22", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t22', ?)").run(JSON.stringify([{ do: "tell", issue: { id: "t22", parentId: "p1" }, kind: "done", who: "WOR-22 (Dana)", title: "report", identifier: "WOR-22", deliverable, rubric: filed }]));
  await loop.runGrades();
  assert.deepEqual(calls.wake, [], "an unverifiable notice is never sent");
  assert.equal(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t22'").get()?.v ?? "", "", "and it is not left owed");
});

test("a cancel landing after the round check stops the deferred notice", async () => {
  // The round is read first, then the task: the owner can cancel in that window. The status read is what decides, and it comes
  // after the round read, so a cancel there is not overwritten by a notice the close queued before it.
  const issue = { id: "t23", identifier: "WOR-23", title: "report", description: "Report.", status: "done", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t23", filed, deliverable);
  const g = grades.record("t23", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  let reads = 0;
  const read = async (m, p, b) => {
    const r = await runner(m, p, b);
    // The round read is the first grade-state read; the owner cancels right after it.
    if (m === "GET" && p === "/internal/grades/t23" && ++reads === 1) issue.status = "cancelled";
    return r;
  };
  const loop = createKernelGradeLoop({ db, runner: read, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t23', ?)").run(JSON.stringify([{ do: "tell", issue: { id: "t23", parentId: "p1" }, kind: "done", who: "WOR-23 (Dana)", title: "report", identifier: "WOR-23", round: g.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }]));
  await loop.runGrades();
  assert.deepEqual(calls.wake, [], "a task cancelled after the round check is not told as done");
  assert.equal(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t23'").get()?.v ?? "", "", "the notice is dropped");
});

test("a deferred notice is dropped when the row moved past the round it reports", async () => {
  // The close resolved, and the notice waited for the task to be done. While it waited, the assignee submitted again: the row
  // is `pending` on a new round. Telling the parent "done, graded against its rubric" would describe a grade the row no longer
  // holds. The notice names its filing and round, and is dropped; the new pass queues its own notice.
  const issue = { id: "t21", identifier: "WOR-21", title: "report", description: "Report.", status: "done", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t21", filed, deliverable);
  const g = grades.record("t21", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  // The row moves on after the close: a later submission bumps the round without changing the filing's words.
  grades.pend("t21");
  assert.notEqual(grades.get("t21").round, g.round);
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t21', ?)").run(JSON.stringify([{ do: "tell", issue: { id: "t21", parentId: "p1" }, kind: "done", who: "WOR-21 (Dana)", title: "report", identifier: "WOR-21", round: g.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }]));
  await loop.runGrades();
  assert.deepEqual(calls.wake, [], "the parent is not told a result the row no longer holds");
  assert.equal(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t21'").get()?.v ?? "", "", "the stale notice is dropped");
});

test("a refused close's reset never parks a newer submission's row", async () => {
  // The close is refused (409) after the assignee submitted again: the row is `pending` on a new round. The reset that requeues
  // a refused close names the round it was decided on, so the store drops it and the new submission's own pass keeps its row.
  const issue = { id: "t20", identifier: "WOR-20", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t20", filed, deliverable);
  const g = grades.record("t20", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  // The close is refused, and by then the assignee has submitted again: a new round, still pending.
  const busy = async (m, p, b) => {
    if (m === "POST" && p === "/v1/checks/t20" && b?.verdict === "ok") {
      completionGate(grades, "t20", "finish_turn");
      throw Object.assign(new Error("WOR-20 is todo, not in_review"), { status: 409 });
    }
    return kernel(m, p, b);
  };
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel: busy, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t20', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", round: g.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }]));
  await loop.runGrades();
  assert.equal(grades.get("t20").state, "pending", "the new submission's own row stands, not this close's wait");
  assert.equal(grades.get("t20").round, g.round + 1, "and its round is the submission's");
  assert.deepEqual(grades.due().map((x) => x.issueId), ["t20"], "its own pass grades it");
});

test("the parent is told the task is done only once it actually is, and the close is never replayed", async () => {
  // The kernel's ok resolves the grading check's hold in the same step, so a task another check still holds cannot be closed
  // again: replaying the close would be refused (the hold is gone) and could never land. The close resolves once; the parent's
  // notice waits, queued, until the task is actually done.
  const issue = { id: "t19", identifier: "WOR-19", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  // The resolve answers ok, releases the grading hold, but another check keeps the task in review.
  const held = async (m, p, b) => {
    if (m === "POST" && p === "/v1/checks/t19" && b?.verdict === "ok") return calls.resolve.push(b.verdict), {};
    return kernel(m, p, b);
  };
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t19", filed, deliverable);
  const g = grades.record("t19", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel: held, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  // The notice carries the same filing and round as the close, as the loop queues it: a notice naming neither is dropped.
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t19', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", round: g.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }, { do: "tell", issue: { id: "t19", parentId: "p1" }, kind: "done", who: "WOR-19 (Dana)", title: "report", identifier: "WOR-19", round: g.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }]));
  await loop.runGrades();
  assert.deepEqual(calls.resolve, ["ok"], "the close was accepted once");
  assert.deepEqual(calls.wake, [], "the parent is not told while another check still holds the task");
  // Only the notice is left owed: the close is resolved and must not be sent again (the kernel would refuse it).
  const left = JSON.parse(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t19'").get()?.v ?? "[]");
  assert.deepEqual(left.map((x) => x.do), ["tell"], "the close is not replayed; only the notice waits");
  const n = calls.resolve.length;
  await loop.runGrades();
  assert.equal(calls.resolve.length, n, "a replay never re-sends the resolved close");

  // The other check releases: the task is done, and the queued notice now goes out.
  issue.status = "done";
  await loop.runGrades();
  assert.deepEqual(calls.wake.map((w) => w.task), ["p1"], "the parent hears it once the task is done");
  assert.equal(db.prepare("SELECT v FROM loop_state WHERE k = 'owed:t19'").get()?.v ?? "", "", "nothing is left owed");
});

test("a legacy close whose evidence changed is requeued, not left satisfied", async () => {
  // A close saved before steps carried a filing matches a satisfied revision-zero row, but the assignee added evidence since.
  // The stale close resets the row to be graded again; without the verified row's filing hash the reset is dropped by the
  // store and the task sits in review on a satisfied row that is never picked up.
  const issue = { id: "t16", identifier: "WOR-16", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t16", filed, deliverable);
  grades.record("t16", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  // The step names no filing and a version the report's evidence no longer reads: the version check makes it stale.
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t16', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: "an-older-version", status: "in_review", deliverable, rubric: filed }]));
  await loop.runGrades();
  assert.equal(issue.status, "in_review", "the stale close does not land");
  assert.equal(grades.get("t16").state, "awaiting_evidence", "the row is requeued for the evidence it now holds, not left satisfied");
  assert.deepEqual(grades.due().map((x) => x.issueId), ["t16"], "the next pass picks the row up again");
});

test("a re-submission landing between the close's last read and its write still stops the close", async () => {
  // The close decides on a satisfied row, then spends several awaits (the task, its evidence, its children, its cards) before
  // it writes. The assignee can submit again in that window, which sends the row from satisfied back to pending without
  // changing the filing's words. The row is read once more immediately before the write, and the re-submission's own round is
  // what refuses the close: nothing is left to claim, so nothing can be left claimed.
  const issue = { id: "t17", identifier: "WOR-17", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const { kernel } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  const filed = ["says where Legacy is used", "links each source", "names the next step"];
  const deliverable = { kind: "report", ref: "" };
  grades.file("t17", filed, deliverable);
  const g = grades.record("t17", { version: "v1", outcome: "satisfied", model: "m", criteria: [], rubric: rubricHash(filed, deliverable, 0) });
  // The re-submission lands in the window the close spends gathering: the row is read once when the close starts deciding, and
  // once more immediately before the write. The second read is where the new round is seen.
  let reads = 0, again = false;
  const read = async (m, p, b) => {
    if (m === "GET" && p === "/internal/grades/t17" && ++reads === 2 && !again) {
      again = true;
      completionGate(grades, "t17", "finish_turn");
    }
    return runner(m, p, b);
  };
  const loop = createKernelGradeLoop({ db, runner: read, due: () => ({ grades: [], resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: "http://127.0.0.1:1", github: noGithub, log: () => {} });
  const now = await wordsEvidence({ comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }], attachments: async () => [], assignee: "eng", delegator: { agentId: "cos" } });
  db.prepare("INSERT OR REPLACE INTO loop_state (k, v) VALUES ('owed:t17', ?)").run(JSON.stringify([{ do: "done", note: "graded against its rubric", version: now.version, status: "in_review", round: g.round, deliverable, rubric: filed, filing: rubricHash(filed, deliverable, 0) }]));
  await loop.runGrades();
  assert.equal(issue.status, "in_review", "the close does not land on the re-submitted row");
  assert.deepEqual(calls.resolve, [], "no close is sent");
  assert.equal(grades.get("t17").state, "pending", "the re-submitted row is left for its own grading pass");
});


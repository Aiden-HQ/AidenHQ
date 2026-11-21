// W7 end to end: the grade loop in the module, on a fake kernel and a fake model gateway. A finished kernel job's graded task is
// graded once the loop runs; a failed criterion reopens it through the finish check's resolve with the note, a pass closes it; the
// model call carries the grader token the kernel minted. The loop is never started by the service until the switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { completionGate } from "../service/src/grades.ts";
import { createGrading } from "../service/src/server.ts";
import { createKernelGradeLoop, verifiedMerges } from "../service/src/kernel-loop.ts";

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
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release: async () => {} }, keys: { check: "c", runner: "r", board: "b" } });
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
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release: async () => {} }, keys: { check: "c", runner: "r", board: "b" } });
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

test("a merge counts only as its executor wrote it on a record that ended ok, never by the args an agent filed", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  const line = `merged-prs: ${JSON.stringify([{ repo: "acme-agents/app", number: 7, head: a, sha: b }])}`;
  const args = { prs: [{ repo: "acme-agents/app", number: 9, head: a }] };
  assert.deepEqual(verifiedMerges({ state: "done", ok: true, args, outcome_text: `${line}\n\nMerged #7.` }), [{ repo: "acme-agents/app", number: 7, head: a, sha: b }]);
  assert.deepEqual(verifiedMerges({ state: "failed", ok: false, args, outcome_text: `${line}\n\nStopped.` }), [], "a failed merge never counts");
  assert.deepEqual(verifiedMerges({ state: "done", ok: true, args, outcome_text: "Merged #9." }), [], "args naming a PR are no evidence");
  assert.deepEqual(verifiedMerges({ state: "done", ok: true, args, outcome_text: `merged-prs: []\n\n${line}` }), [], "only the first line counts");
});

// The kernel's finish-check hold as checks.ts keeps it: the grader token and a resolve (ok, reopen, block) need it; release drops it.
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
      if (body.verdict !== "release" && !held) throw new Error("kernel POST /v1/checks → 409: holds no finish");
      held = false;
      if (body.verdict !== "release") issue.status = { ok: "done", reopen: "todo", block: "blocked" }[body.verdict];
      return {};
    }
    if (path === "/v1/wakes") return calls.wake.push(body), { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { kernel, release: async () => void (await kernel("POST", `/v1/checks/${issue.id}`, { verdict: "release" })) };
}

test("a kernel.apply record on the task reaches the grader as its apply deliverable: action normalised, diff and log carried", async (t) => {
  // The model answers for the apply's rubric, and the prompt code hands it is what this test reads: the trusted facts and
  // APPLY_CHANGE/APPLY_OUTCOME, never "no apply filed yet" and never an object printed into a fact.
  const prompts = [];
  const gateway = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    prompts.push(JSON.parse(body).messages.at(-1).content);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(["yes", "yes", "yes"])) } }] }));
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t4", identifier: "WOR-4", title: "apply", description: "Land it.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const DIFF = "diff --git a/instance.yaml b/instance.yaml\n+product: bbbb\n";
  const record = {
    id: "k-apply1", kind: "kernel.apply", state: "done", ok: true,
    args: { repo: "acme/aidenhq-instance", branch: "fleet/handbook", sha: "c".repeat(40), files: ["instance.yaml"] },
    outcome_text: "apply 305: landed on main\ngeneration 305 is healthy\n", details: DIFF,
    decided_at: "2026-11-20T15:59:00Z", updated_at: "2026-11-20T16:00:00Z", created_at: "2026-11-20T15:58:00Z",
  };
  const kernel = async (method, path, body) => {
    if (path === `/v1/cp/read/api/issues/${issue.id}`) return issue;
    if (path.endsWith("/comments")) return [];
    if (path.endsWith("/attachments")) return [];
    if (path === "/v1/cp/read/api/agents/eng") return { id: "eng", name: "Dana" };
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === `/v1/work?task=${issue.id}`) return { busy: false, jobs: [{ id: "j", state: "done", engine: "codex", ended_at: new Date(Date.now() - 60_000).toISOString() }], records: [record] };
    if (path === "/v1/work/grader-token") return { token: "tok" };
    if (path === `/v1/checks/${issue.id}`) return calls.resolve.push(body), (issue.status = body.verdict === "ok" ? "done" : "todo"), {};
    if (path === "/v1/wakes") return calls.wake.push(body), { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release: async () => {} }, keys: { check: "c", runner: "r", board: "b" } });
  grades.file(issue.id, ["the apply's record ended applied, and its log shows no error", "the diff makes the change asked for", "the diff changes nothing else"], { kind: "apply", ref: "" });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  completionGate(grades, issue.id, "finish_turn"); // the held-and-waiting row the loop picks up (as in the W7 test)
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  t.after(() => { Date.now = realNow; });
  await loop.runGrades();
  assert.deepEqual(calls.resolve.map((c) => c.verdict), ["ok"], "the applied card is graded, not woken as 'no apply filed yet'");
  assert.equal(calls.wake.length, 0);
  const prompt = prompts[0];
  assert.match(prompt, /apply k-apply1: used, apply 305: landed on main/, "the fact prints the outcome text");
  assert.doesNotMatch(prompt, /no apply filed yet|\[object Object\]/);
  assert.match(prompt, /the diff it carried is in APPLY_CHANGE; its log is in APPLY_OUTCOME/);
  assert.ok(prompt.includes(`<<<APPLY_CHANGE\n${DIFF}`), "the card's diff is the APPLY_CHANGE block");
  assert.ok(prompt.includes("<<<APPLY_OUTCOME\napply 305: landed on main"));
});

test("a model with no route grades with the next one, and the hold lasts until the verdict's resolve", async (t) => {
  const asked = [];
  const gateway = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const { model } = JSON.parse(body);
    asked.push(model);
    // OpenRouter's answer for a model with no ZDR endpoint.
    if (model === "~openai/gpt-luna-latest") return void res.writeHead(404).end(JSON.stringify({ error: { code: 404, message: "No endpoints found matching your data policy" } }));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(["yes"])) } }] }));
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t3", identifier: "WOR-3", title: "report", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  const { kernel, release } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release }, keys: { check: "c", board: "b" } });
  grades.file("t3", ["says it"], { kind: "report", ref: "" });
  completionGate(grades, "t3", "finish_turn");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  t.after(() => { Date.now = realNow; });
  await loop.runGrades();
  assert.deepEqual(asked, ["~openai/gpt-luna-latest", "~z-ai/glm-flash-latest"]);
  assert.deepEqual(calls.resolve, ["ok"]);
  assert.equal(grades.get("t3").verdicts.at(-1).model, "~z-ai/glm-flash-latest");
});

test("a grader that keeps failing keeps its hold, then blocks the task with the error and tells its delegator", async (t) => {
  let n = 0;
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req);
    n++;
    res.writeHead(502).end("upstream down");
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t4", identifier: "WOR-4", title: "report", description: "", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  const { kernel, release } = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release }, keys: { check: "c", board: "b" } });
  grades.file("t4", ["says it"], { kind: "report", ref: "" });
  completionGate(grades, "t4", "finish_turn");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  const realNow = Date.now;
  let skew = 10_000;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  for (let i = 0; i < 5; i++) { await loop.runGrades(); skew += 2 * 60 * 60_000; }
  assert.equal(n, 5, "a 5xx is never retried on the next model, and every pass got its token");
  assert.deepEqual(calls.resolve, ["block"]);
  assert.equal(issue.status, "blocked");
  assert.equal(calls.wake.length, 1);
  assert.equal(calls.wake[0].task, "p1");
  assert.match(calls.wake[0].text, /WOR-4 is blocked: its grader failed 5 times/);
  await loop.runGrades();
  assert.equal(n, 5, "a blocked task is not graded again");
});

test("a verdict's reopen and its parent's notice that hit a kernel 5xx land on the next pass, never lost", async (t) => {
  const answers = [answer(["no"]), answer(["yes"])];
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  }).listen(0);
  t.after(() => gateway.close());
  const issue = { id: "t3", identifier: "WOR-3", title: "report", description: "Report.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: "p1" };
  const calls = { resolve: [], wake: [] };
  let fail = 0;
  const flaky = () => { if (fail) { fail--; throw Object.assign(new Error("kernel 502"), { status: 502 }); } };
  const kernel = async (method, path, body) => {
    if (path === "/v1/cp/read/api/issues/t3") return issue;
    if (path === "/v1/cp/read/api/issues/t3/comments") return [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "Here it is.", createdAt: "2026-11-18T09:00:00Z" }];
    if (path === "/v1/cp/read/api/issues/t3/attachments") return [];
    if (path === "/v1/cp/read/api/agents/eng") return { id: "eng", name: "Dana" };
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === "/v1/work?task=t3") return { busy: false, jobs: [{ id: "j", state: "done", engine: "codex", ended_at: new Date(Date.now() - 60_000).toISOString() }], records: [] };
    if (path === "/v1/work/grader-token") return { token: "tok" };
    if (path === "/v1/checks/t3") return flaky(), calls.resolve.push(body.verdict), (issue.status = body.verdict === "ok" ? "done" : "todo"), {};
    if (path === "/v1/wakes") return flaky(), calls.wake.push(body.task), { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release: async () => {} }, keys: { check: "c", runner: "r", board: "b" } });
  grades.file("t3", ["says it"], { kind: "report", ref: "" });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => { throw new Error("no"); }, apps: async () => { throw new Error("no"); }, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  completionGate(grades, "t3", "finish_turn");
  const realNow = Date.now;
  let skew = 10_000;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  fail = 1; // the reopen gets a 502
  await loop.runGrades();
  assert.deepEqual(calls.resolve, [], "the reopen failed");
  await loop.runGrades();
  assert.deepEqual(calls.resolve, ["reopen"], "the next pass reopens it");

  issue.status = "in_review";
  completionGate(grades, "t3", "finish_turn");
  skew += 10_000;
  // The close lands; the parent's notice gets a 502 (the second kernel call fails, so let the close through first).
  const close = kernel;
  let closed = false;
  const k2 = async (m, p, b) => { if (p === "/v1/wakes" && !closed) { closed = true; throw Object.assign(new Error("kernel 502"), { status: 502 }); } return close(m, p, b); };
  const loop2 = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel: k2, kernelBytes: async () => { throw new Error("no"); }, apps: async () => { throw new Error("no"); }, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  await loop2.runGrades();
  assert.deepEqual(calls.resolve, ["reopen", "ok"]);
  assert.deepEqual(calls.wake, [], "the parent's notice failed");
  await loop2.runGrades();
  assert.deepEqual(calls.wake, ["p1"], "the next pass tells the parent");
});

/**
 * A fake kernel for a grade whose rubric names another task: the graded task, the named task's read and attachments, and the
 * agents read. `named` and `attachments` are what those reads answer, so a test can make them a 404, a 5xx or another company.
 */
async function namedTaskHarness(t, { id, identifier, rubric, named, attachments = [], agentRead = async (aid) => ({ id: aid, name: aid === "art" ? "Ada" : "Dana" }), other = [] }) {
  const prompts = [];
  const gateway = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    prompts.push(JSON.parse(body).messages.at(-1).content);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(["yes"])) } }] }));
  }).listen(0);
  t.after(() => gateway.close());
  const task = (tid, ident, companyId = "co") => ({ id: tid, identifier: ident, title: "report", description: "", status: "in_review", companyId, assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null });
  const calls = { resolve: [], attachments: [] };
  const kernel = async (method, path, body) => {
    const namedId = named?.id ?? "t101";
    for (const [p, answer] of other) if (path === p) return answer();
    if (path === `/v1/cp/read/api/issues/${id}`) return task(id, identifier);
    if (path === `/v1/cp/read/api/issues/${id}/comments`) return [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: `Done; the mockup is on ${named?.identifier ?? "WOR-101"}.`, createdAt: "2026-11-20T11:00:00Z" }];
    if (path === `/v1/cp/read/api/issues/${id}/attachments`) return [];
    if (path === `/v1/cp/read/api/issues/${named?.identifier ?? "WOR-101"}`) return named;
    if (path === `/v1/cp/read/api/issues/${namedId}/attachments`) return calls.attachments.push(path), attachments;
    if (path.startsWith("/v1/cp/read/api/agents/")) return agentRead(path.split("/").at(-1));
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === `/v1/work?task=${id}` || path === `/v1/work?task=${namedId}`) return { busy: false, jobs: [], records: [] };
    if (path === "/v1/work/grader-token") return { token: "tok" };
    if (path === `/v1/checks/${id}`) return calls.resolve.push(body), {};
    if (path === "/v1/wakes") return { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const db = new DatabaseSync(":memory:");
  const byRef = { [id]: task(id, identifier), [identifier]: task(id, identifier) };
  const { runner, grades } = createGrading({ db, kernel: { issue: async (ref) => byRef[ref], settings: async () => ({}), release: async () => {} }, keys: { check: "c", runner: "r", board: "b" } });
  grades.file(id, [rubric], { kind: "report", ref: "" });
  const loop = () => createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => { throw new Error("no bytes"); }, apps: async () => { throw new Error("no apps"); }, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  completionGate(grades, id, "finish_turn");
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  t.after(() => { Date.now = realNow; });
  return { prompts, calls, grades, loop };
}

test("a rubric naming another task reads its file list as evidence, not a wait", async (t) => {
  const mockup = { id: "f1", originalFilename: "mockup.png", contentType: "image/png", byteSize: 1200, createdByAgentId: "art", createdAt: "2026-11-20T10:00:00Z" };
  const h = await namedTaskHarness(t, {
    id: "t9", identifier: "WOR-9", rubric: "the mockup on WOR-101 is the one applied here",
    named: { id: "t101", identifier: "WOR-101", title: "the mockups", status: "done", companyId: "co" }, attachments: [mockup],
  });
  await h.loop().runGrades();
  assert.deepEqual(h.calls.resolve.map((c) => c.verdict), ["ok"], "the grade completes: the named read is not a wait");
  assert.equal(h.grades.get("t9").state, "satisfied");
  assert.ok(h.calls.attachments.length > 0 && h.calls.attachments.every((p) => p === "/v1/cp/read/api/issues/t101/attachments"), "the named task's file list is read from cp-read");
  const prompt = h.prompts[0];
  assert.match(prompt, /WOR-101 \(another task the rubric names; its file list read now, not the files' contents\): 1 file attached/);
  assert.match(prompt, /agent Ada/, "the uploader is named from the agents read");
  assert.match(prompt, /mockup\.png \(image\/png\)/, "the file's name and type are in OTHER_TASK_FILES");
});

test("a rubric-named task that 404s is a fact, not a wait", async (t) => {
  const notFound = () => { throw Object.assign(new Error("kernel GET → 404: no task WOR-404"), { status: 404 }); };
  const h = await namedTaskHarness(t, {
    id: "t10", identifier: "WOR-10", rubric: "WOR-404 says where the mockup came from",
    named: { identifier: "WOR-404" },
    other: [["/v1/cp/read/api/issues/WOR-404", notFound]],
  });
  await h.loop().runGrades();
  assert.deepEqual(h.calls.resolve.map((c) => c.verdict), ["ok"], "a 404 completes the grade");
  assert.equal(h.grades.get("t10").state, "satisfied");
  assert.deepEqual(h.calls.attachments, [], "nothing is read from a task that does not exist");
  assert.match(h.prompts[0], /WOR-404: no such task in this company \(nothing read from it\)/, "a 404 is a fact, not a wait");
});

test("a rubric-named task in another company is no such task, and its files are not read", async (t) => {
  const h = await namedTaskHarness(t, {
    id: "t11", identifier: "WOR-11", rubric: "the mockup on WOR-101 is the one applied here",
    named: { id: "t101", identifier: "WOR-101", title: "someone else's", status: "done", companyId: "other" },
    attachments: [{ id: "f2", originalFilename: "secret.png", contentType: "image/png", byteSize: 1, createdAt: "2026-11-20T10:00:00Z" }],
  });
  await h.loop().runGrades();
  assert.equal(h.grades.get("t11").state, "satisfied", "the grade settles instead of reading across companies");
  assert.deepEqual(h.calls.attachments, [], "another company's files are never read");
  assert.match(h.prompts[0], /WOR-101: no such task in this company \(nothing read from it\)/);
});

test("a rubric-named task's transient read failure leaves the row awaiting, never not met", async (t) => {
  const down = () => { throw Object.assign(new Error("kernel 502"), { status: 502 }); };
  const h = await namedTaskHarness(t, {
    id: "t12", identifier: "WOR-12", rubric: "the mockup on WOR-101 is the one applied here",
    named: { id: "t101", identifier: "WOR-101", title: "the mockups", status: "done", companyId: "co" },
    other: [["/v1/cp/read/api/issues/WOR-101", down]],
  });
  await h.loop().runGrades();
  assert.deepEqual(h.calls.resolve, [], "a 502 on the named task's read passes no verdict");
  assert.equal(h.grades.get("t12").state, "awaiting_evidence", "a 502 waits for the next look");
});

test("a transient agent-name read failure is a wait, not 'another agent'", async (t) => {
  const mockup = { id: "f1", originalFilename: "mockup.png", contentType: "image/png", byteSize: 1200, createdByAgentId: "art", createdAt: "2026-11-20T10:00:00Z" };
  const h = await namedTaskHarness(t, {
    id: "t13", identifier: "WOR-13", rubric: "the mockup on WOR-101 is the one applied here",
    named: { id: "t101", identifier: "WOR-101", title: "the mockups", status: "done", companyId: "co" }, attachments: [mockup],
    agentRead: async (aid) => { if (aid === "art") throw Object.assign(new Error("kernel 502"), { status: 502 }); return { id: aid, name: "Dana" }; },
  });
  await h.loop().runGrades();
  assert.deepEqual(h.calls.resolve, [], "a failed uploader read passes no verdict");
  assert.equal(h.grades.get("t13").state, "awaiting_evidence", "it waits instead of naming an unknown agent");
});

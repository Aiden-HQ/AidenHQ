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

test("a kernel job's graded task is graded, reopened with the unmet criterion, then closed on a pass", async (t) => {
  const models = [];
  const answers = [answer(["yes", "no", "yes"]), answer(["yes", "yes", "yes"])];
  const gateway = http.createServer(async (req, res) => {
    models.push({ auth: req.headers.authorization, path: req.url });
    for await (const _ of req);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  }).listen(0);
  t.after(() => gateway.close());

  const issue = { id: "t1", identifier: "WOR-1", title: "report", description: "Report on Legacy.", status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const calls = { resolve: [], wake: [] };
  const kernel = async (method, path, body) => {
    if (path === "/v1/cp/read/api/issues/t1") return issue;
    if (path === "/v1/cp/read/api/issues/t1/comments") return [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "Legacy is used in acme/app and acme/lib; next step: port app.", createdAt: "2026-11-18T09:00:00Z" }];
    if (path === "/v1/cp/read/api/issues/t1/attachments") return [];
    if (path === "/v1/cp/read/api/companies/co/agents") return [{ id: "eng", name: "Dana" }];
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
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => { throw new Error("no attachment bytes"); }, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, log: () => {} });

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
    if (path === "/v1/cp/read/api/companies/co/agents") return [{ id: "eng", name: "Dana" }];
    if (path === "/v1/work?task=t2") return { busy: false, jobs: [{ id: "j-2", state: "done", engine: "codex", ended_at: new Date(Date.now() - 60_000).toISOString() }], records: [{ id: "r1", kind: "codehost-github.pr", state: "done", ok: true, args: { workspace: "WOR-2", only: [{ repo: "acme-agents/app", branch: "fix-it", sha: "a".repeat(40) }] }, outcome_text: "PRs: https://github.com/acme-agents/app/pull/7" }] };
    if (path === "/v1/work/grader-token") return { token: "tok" };
    if (path === "/v1/checks/t2") return calls.resolve.push(body), {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  let readable = true;
  const github = { pr: async (repo, n) => { calls.tokens.push(`${repo}#${n}`); if (!readable) throw new Error("GitHub has no readable PR"); return { repository: { pullRequest: pr } }; }, diff: async () => "diff --git a/x b/x\n+fixed" };
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release: async () => {} }, keys: { check: "c", runner: "r", board: "b" } });
  grades.file("t2", ["the change fixes the thing"], { kind: "pr", ref: "https://github.com/acme-agents/app/pull/7" });
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => { throw new Error("no bytes"); }, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github, log: () => {} });
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

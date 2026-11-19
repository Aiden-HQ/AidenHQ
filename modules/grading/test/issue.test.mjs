// A task a module files with a rubric (POST /v1/tasks, filed through the kernel's /check/rubric) is graded, and an issue
// deliverable is read from GitHub: the task closes only once its issue is closed with a cited, merged PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { completionGate } from "../service/src/grades.ts";
import { createGrading } from "../service/src/server.ts";
import { createKernelGradeLoop } from "../service/src/kernel-loop.ts";

const KEY = "c".repeat(32);
const DONE = ["The issue is resolved on GitHub: closed, or parked by the repo's owner in a comment.", "Its resolution is shown there: a merged fixing PR cited, or the reason for not planned or a duplicate.", "The task's comment names the issue as owner/name#number with its resolution."];
const answer = (met) => ({ verdict: met.every((m) => m === "yes") ? "satisfied" : "needs_revision", criteria: met.map((m, i) => ({ id: String(i + 1), met: m, evidence: m === "yes" ? "shown" : "the issue is open" })) });

test("a module-filed task with a rubric is graded: an open issue reopens it, a closed one with a merged PR closes it; a forged filing is refused", async (t) => {
  const answers = [];
  const prompts = [];
  const gateway = http.createServer(async (req, res) => {
    for await (const c of req) prompts.push(String(c));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }));
  }).listen(0);
  t.after(() => gateway.close());

  const issue = { id: "t1", identifier: "WOR-1", title: "Maintainer: acme/app#7", description: "acme/app#7", status: "in_review", companyId: "co", assigneeAgentId: "mnt", createdByAgentId: null, parentId: null };
  const calls = [];
  const kernel = async (method, path, body) => {
    if (path === "/v1/cp/read/api/issues/t1") return issue;
    if (path === "/v1/cp/read/api/issues/t1/comments") return [{ id: "c1", authorType: "agent", authorAgentId: "mnt", body: "acme/app#7 verified; fix handed on.", createdAt: "2026-11-19T09:00:00Z" }];
    if (path === "/v1/cp/read/api/issues/t1/attachments") return [];
    if (path === "/v1/cp/read/api/companies/co/agents") return [{ id: "mnt", name: "Maintainer" }];
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === "/v1/work?task=t1") return { busy: false, jobs: [], records: [] };
    if (path === "/v1/work/grader-token") return { token: "tok" };
    if (path === "/v1/checks/t1") return calls.push(body.verdict), (issue.status = body.verdict === "ok" ? "done" : "todo"), {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  let gh = { state: "OPEN", stateReason: null, closedAt: null, closedEvents: { nodes: [] }, comments: { nodes: [] }, labels: { nodes: [{ name: "fix" }] } };
  const pr = { number: 9, state: "MERGED", mergedAt: "2026-11-19T10:00:00Z", mergeCommit: { oid: "b".repeat(40) }, headRefOid: "a".repeat(40) };
  const github = { issue: async () => ({ repository: { issue: gh }, appSlug: "aidenhq-app" }), pr: async () => ({ repository: { pullRequest: pr } }), diff: async () => "" };
  const db = new DatabaseSync(":memory:");
  const { server, runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}), release: async () => {} }, keys: { check: KEY, board: "b" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const file = (key, body) => fetch(`http://127.0.0.1:${server.address().port}/check/rubric`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const body = { task: { id: "t1", identifier: "WOR-1" }, module: "maintainer", rubric: DONE, deliverable: { kind: "issue", ref: "acme/app#7" } };

  assert.equal((await file("x".repeat(32), body)).status, 403, "only the kernel's key files a module task's rubric");
  assert.equal(grades.get("t1"), undefined);
  assert.equal((await file(KEY, { ...body, deliverable: { kind: "issue", ref: "acme/app" } })).status, 400, "an issue deliverable names owner/name#number");
  assert.equal((await file(KEY, body)).status, 200);
  assert.equal(grades.get("t1").state, "open");
  assert.equal((await file(KEY, body)).status, 200, "the same filing again is a retry");
  assert.equal((await file(KEY, { ...body, rubric: [...DONE].reverse() })).status, 409, "a row stays as its filer made it");
  const finish = (graded, id = "t2") => fetch(`http://127.0.0.1:${server.address().port}/check/finish`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ task: { ...issue, id, ...(graded ? { graded } : {}) }, agent: "mnt", tool: "task_finish", via: "task_finish" }) }).then((r) => r.json());
  assert.equal((await finish(true)).verdict, "deny", "a task marked graded with no row never passes ungraded");
  assert.equal((await finish(false)).verdict, "ok");

  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => { throw new Error("no bytes"); }, apps: async () => { throw new Error("no apps"); }, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github, log: () => {} });
  completionGate(grades, "t1", "finish_turn"); // the Maintainer finishes with the issue still open
  const realNow = Date.now;
  let skew = 10_000; // past the 5 s a just-finished row waits for its closing comment
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });

  answers.push(answer(["no", "no", "no"]));
  await loop.runGrades();
  assert.deepEqual(calls, ["reopen"], "an open issue sends the task back");

  gh = { ...gh, state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-11-19T10:05:00Z", closedEvents: { nodes: [{ actor: { __typename: "Bot", login: "aidenhq-app" } }] },
    comments: { nodes: [{ author: { login: "aidenhq-app" }, authorAssociation: "NONE", createdAt: "2026-11-19T10:04:50Z", body: "Fixed by https://github.com/acme/app/pull/9 (merged)." }] } };
  issue.status = "in_review";
  Date.now = realNow;
  completionGate(grades, "t1", "finish_turn"); // finished again, the issue now closed
  Date.now = () => realNow() + skew + 10_000;
  answers.push(answer(["yes", "yes", "yes"]));
  await loop.runGrades();
  assert.deepEqual(calls, ["reopen", "ok"]);
  assert.match(prompts.at(-1), /closed as completed at 2026-11-19T10:05:00Z by aidenhq-app/);
  assert.match(prompts.at(-1), /acme\/app\/pull\/9: merged at 2026-11-19T10:00:00Z/, "the cited PR's merge is read by code");
  assert.equal(grades.get("t1").state, "satisfied");
});

test("issue evidence counts a close only by the App or an owner, member or collaborator, and a fix PR only in the issue's repo", async () => {
  const { issueEvidence } = await import("../service/src/grader/evidence.ts");
  const issue = (closer, association, body, bot = false) => ({ repository: { issue: { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-11-19T10:05:00Z", labels: { nodes: [] }, closedEvents: { nodes: [{ actor: { __typename: bot ? "Bot" : "User", login: closer } }] },
    comments: { nodes: [{ author: { login: closer }, authorAssociation: association, createdAt: "2026-11-19T10:04:50Z", body }] } } }, appSlug: "aidenhq-app" });
  const read = [];
  const pr = async (repo, n) => (read.push(`${repo}#${n}`), { repository: { pullRequest: { state: "MERGED", mergeCommit: { oid: "b".repeat(40) } } } });
  const ev = async (closer, assoc, body, bot) => issueEvidence("acme/app#7", { issue: async () => issue(closer, assoc, body, bot), pr });
  const fake = await ev("stranger", "NONE", "Fixed by acme/app#9");
  assert.match(fake.facts.join("\n"), /the close does not count/);
  assert.deepEqual(read, [], "an untrusted close's PR is never read");
  assert.match((await ev("aidenhq-app", "NONE", "Fixed by acme/app#9")).facts.join("\n"), /the close does not count/, "a user named like the App's slug is not the App");
  assert.match((await ev("aidenhq-app", "NONE", "Fixed by acme/app#9", true)).facts.join("\n"), /pull\/9: merged/);
  assert.match((await ev("maintainer", "MEMBER", "Fixed by acme/app#9")).facts.join("\n"), /pull\/9: merged/);
  const other = await ev("aidenhq-app", "NONE", "Fixed by evil/repo#1", true);
  assert.match(other.facts.join("\n"), /not in acme\/app/);
  assert.deepEqual(read, ["acme/app#9", "acme/app#9"]);
});

// A graded task's delegator is the task that asked for it. When Paperclip's agent task-tree cap places the task beside its
// requester instead of under it (2026.1117.0), the task records that requester (requested-parent.ts), and the done notice
// follows it. A task that wasn't adjusted resolves to its parent, as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { completionGate } from "../service/src/grades.ts";
import { createGrading } from "../service/src/server.ts";
import { createKernelGradeLoop } from "../service/src/kernel-loop.ts";

const MARK = (id: string) => `<!-- aidenhq:requested-parent:${id} -->`;
const noGithub = { issue: async () => { throw new Error("no github"); }, pr: async () => { throw new Error("no github"); }, diff: async () => { throw new Error("no github"); } };

/** The kernel with a task the owner closed under it, and its requester's task. A failing grader closes the task ungraded. */
function heldKernel(issue, calls) {
  const company = (ref) => (ref === "WOR3" ? { id: "eng", companyId: "co" } : ref === "WOR2" ? { id: "WOR2", companyId: "co" } : { id: ref, companyId: "co" });
  return async (method, path, body) => {
    if (path === `/v1/cp/read/api/issues/${issue.id}`) return issue;
    const read = /^\/v1\/cp\/read\/api\/issues\/([^/?]+)/.exec(path);
    if (read) {
      const ref = decodeURIComponent(read[1]);
      if (path.endsWith("/comments")) return [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "It is said.", createdAt: "2026-11-18T09:00:00Z" }];
      if (path.endsWith("/attachments")) return [];
      return company(ref);
    }
    if (path === "/v1/cp/read/api/agents/eng") return { id: "eng", name: "Dana" };
    if (path.startsWith("/v1/cp/read/api/companies/co/issues")) return [];
    if (path === `/v1/work?task=${issue.id}`) return { busy: false, jobs: [], records: [] };
    if (path === "/v1/work/grader-token") return { token: "tok" };
    if (path === `/v1/checks/${issue.id}`) return calls.resolve.push(body.verdict), void (issue.status = body.verdict === "ok" ? "done" : "todo"), {};
    if (path === "/v1/wakes") return calls.wake.push(body), { posted: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
}

async function world(t, { adjusted }) {
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(502).end("upstream down");
  }).listen(0);
  t.after(() => gateway.close());
  const issue = {
    id: "eng", identifier: "WOR-3", title: "Build the totals page", description: `Build it.${adjusted ? `\n\n${MARK("WOR2")}` : ""}`,
    status: "in_review", companyId: "co", assigneeAgentId: "eng", createdByAgentId: "arch", parentId: adjusted ? "WOR1" : "WOR2",
  };
  const calls = { resolve: [], wake: [] };
  const kernel = heldKernel(issue, calls);
  const db = new DatabaseSync(":memory:");
  const { runner, grades } = createGrading({ db, kernel: { issue: async () => issue, settings: async () => ({}) }, keys: { check: "c", board: "b" } });
  grades.file("eng", ["says it"], { kind: "report", ref: "" });
  completionGate(grades, "eng", "task_finish");
  const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: [] }), kernel, kernelBytes: async () => Buffer.alloc(0), apps: async () => ({}), gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, github: noGithub, log: () => {} });
  const realNow = Date.now;
  // The grader's gateway fails every pass, so the row walks its retry ladder; the fifth pass settles it satisfied and the task
  // closes done, ungraded, with the notice this test reads.
  let skew = 10_000;
  Date.now = () => realNow() + skew;
  t.after(() => { Date.now = realNow; });
  for (let i = 0; i < 5; i++) {
    await loop.runGrades();
    skew += 2 * 60 * 60_000;
  }
  return { calls, issue };
}

test("an ungraded close on a task placed beside its requester tells that requester", async (t) => {
  const { calls, issue } = await world(t, { adjusted: true });
  assert.deepEqual(calls.resolve, ["ok"]);
  assert.equal(issue.status, "done");
  // The four failed passes left their retry notes on the task itself; the close's notice alone goes to the task that asked for it.
  const told = calls.wake.filter((w) => w.task !== "eng");
  assert.deepEqual(told.map((w) => w.task), ["WOR2"], "the Architect's task, which asked for it, not the chief of staff's");
  assert.equal(calls.wake.some((w) => w.task === "WOR1"), false, "never the flattened parent");
  assert.match(told[0].text, /WOR-3 \(Dana\) is done, ungraded: /);
});

test("a task the cap didn't move tells its parent, as before", async (t) => {
  const { calls } = await world(t, { adjusted: false });
  assert.deepEqual(calls.wake.filter((w) => w.task !== "eng").map((w) => w.task), ["WOR2"]);
});

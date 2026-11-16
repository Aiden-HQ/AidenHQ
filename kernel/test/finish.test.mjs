// The finish gate (checks.ts): a module's task.finish check on every move to done, the tasks module's through
// /v1/cp/agent and the runner's through /v1/finish; holds placed as the owner, released or resolved by the check's module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel, moduleServer, readBody, serve } from "./helpers.mjs";

const conn = (url, module, tools) => ({ url: `${url}/mcp`, auth_secret: `${module}_service_key`, module, returns: "trusted", tools: { read: [], write: [], destructive: [], ...tools } });
const agents = { "run-jwt-ada": { id: "ag-ada", name: "Ada" } };
const grants = { "ag-ada": { key: "ada", roles: [], tools: { tasks: ["task_finish"] } } };
const TASK = "11111111-1111-1111-1111-111111111111";

/** A kernel with the tasks connection, one finish check answering `verdict(body)`, and a control plane holding one task. */
async function setup(t, verdict, { agentsScope } = {}) {
  const asked = [];
  const check = await serve(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    asked.push({ auth: req.headers.authorization, body });
    const v = await verdict(body);
    if (v === "hang") return;
    res.writeHead(v.http ?? 200, { "content-type": "application/json" }).end(JSON.stringify(v.body ?? v));
  });
  t.after(() => check.s.close());
  const issue = { id: TASK, identifier: "WOR-1", companyId: "co", status: "in_progress", assigneeAgentId: "ag-ada", assigneeUserId: null, createdByAgentId: "ag-cos", parentId: null, labelIds: ["lbl-x"], executionPolicy: { mode: "normal" } };
  const writes = [];
  let k;
  const tasks = await moduleServer(t, { key: "tasks-key", tools: ["task_finish"], answer: async (msg, req) => {
    const r = await fetch(`${k.url}/v1/cp/agent/api/issues/${msg.params.arguments.task}`, { method: "PATCH", headers: { authorization: "Bearer tasks-key", "x-aidenhq-caller": req.headers["x-aidenhq-caller"], "content-type": "application/json" }, body: JSON.stringify(msg.params.arguments.body) });
    return { content: [{ type: "text", text: JSON.stringify({ status: r.status, json: await r.json() }) }] };
  } });
  k = await kernel(t, {
    agents, grants, secrets: { tasks_service_key: "tasks-key", grading_check_key: "check-key", grading_token: "grading-tok", other_token: "other-tok" },
    connections: { tasks: conn(tasks.url, "tasks", { write: ["task_finish"] }) },
    modules: { modules: { grading: { roles: ["kernel.cp-read"], token: "grading_token" }, other: { roles: ["kernel.cp-read"], token: "other_token" } } },
    checks: { "grading.finish": { module: "grading", at: "task.finish", url: `${check.url}/check/finish`, auth_secret: "grading_check_key", label: "grading", ...(agentsScope ? { agents: agentsScope } : {}) } },
    onControl: async (req, body, auth) => {
      if (req.method === "GET" && (req.url === `/api/issues/${TASK}` || req.url === "/api/issues/WOR-1")) return { body: issue };
      if (req.method === "GET" && req.url === "/api/companies/co/labels") return { body: [{ id: "lbl-x", name: "x" }, { id: "lbl-grading", name: "grading" }] };
      if (req.method === "PATCH") { const b = JSON.parse(body); writes.push({ as: auth, body: b }); Object.assign(issue, b); return { body: issue }; }
    },
  });
  const finish = async (body) => JSON.parse((await (await k.call("tasks", "run-jwt-ada", { method: "tools/call", params: { name: "task_finish", arguments: { task: TASK, body } } })).json()).result.content[0].text);
  return { k, asked, writes, issue, finish };
}

test("a holding check: the move to done isn't forwarded; the owner holds the task in review with the check's label and a scheduled check", async (t) => {
  const until = "2026-11-17T12:00:00.000Z";
  const { asked, writes, finish } = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "The grader checks this task against its rubric.", until }));
  const r = await finish({ status: "done", comment: "Merged." });
  assert.deepEqual(r, { status: 202, json: { held: { state: "pending", reason: "The grader checks this task against its rubric." } } });
  // The check heard who is finishing, with what, on which task; with its own key.
  assert.equal(asked[0].auth, "Bearer check-key");
  assert.deepEqual(asked[0].body, { task: { id: TASK, identifier: "WOR-1", status: "in_progress", assigneeAgentId: "ag-ada", assigneeUserId: null, createdByAgentId: "ag-cos", parentId: null }, agent: "ag-ada", tool: "task_finish", via: "task_finish" });
  // One write, as the owner (the board key); the agent's own move to done never reached the control plane.
  assert.deepEqual(writes, [{ as: "board-key", body: { status: "in_review", labelIds: ["lbl-x", "lbl-grading"], executionPolicy: { mode: "normal", monitor: { nextCheckAt: until, notes: "The grader checks this task against its rubric." } } } }]);
});

test("a deny refuses the close with its status and reason, and a failed check refuses it too: nothing moves either way", async (t) => {
  let answer = { verdict: "deny", status: 403, reason: "only its assignee finishes it" };
  const { writes, finish } = await setup(t, () => answer);
  let r = await finish({ status: "done" });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /only its assignee finishes it/);
  answer = { verdict: "deny", status: 409, reason: "the task is cancelled" };
  assert.equal((await finish({ status: "done" })).status, 409);
  // Fail closed: an error status, a malformed verdict, a hang past 10 s are all a refusal (503), never a pass.
  for (const bad of [{ http: 500, body: { error: "boom" } }, { verdict: "maybe" }]) {
    answer = bad;
    r = await finish({ status: "done" });
    assert.equal(r.status, 503, JSON.stringify(bad));
    assert.match(r.json.error.message, /the finish check grading\.finish failed/);
  }
  assert.deepEqual(writes, []);
});

test("ok passes the agent's own change through as the agent; ok with unlabel drops the check's label first; other changes skip the gate", async (t) => {
  let answer = { verdict: "ok" };
  const { asked, writes, issue, finish } = await setup(t, () => answer);
  let r = await finish({ status: "done", comment: "Done." });
  assert.equal(r.status, 200);
  assert.deepEqual(writes, [{ as: "run-jwt-ada", body: { status: "done", comment: "Done." } }]);
  writes.length = 0;
  Object.assign(issue, { status: "in_review", labelIds: ["lbl-x", "lbl-grading"] });
  answer = { verdict: "ok", unlabel: true };
  await finish({ status: "done" });
  assert.deepEqual(writes, [{ as: "board-key", body: { labelIds: ["lbl-x"] } }, { as: "run-jwt-ada", body: { status: "done" } }]);
  const n = asked.length;
  await finish({ status: "blocked" });
  assert.equal(asked.length, n, "only a move to done asks the checks");
});

test("a check scoped to agents is asked only for their tasks", async (t) => {
  const { asked, finish } = await setup(t, () => ({ verdict: "deny", reason: "no" }), { agentsScope: ["someone-else"] });
  assert.equal((await finish({ status: "done" })).status, 200);
  assert.equal(asked.length, 0);
});

test("/v1/finish: the runner's own closes, with its key only", async (t) => {
  const { k, asked, writes } = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" }));
  assert.equal((await k.v1("POST", "/v1/finish", { task: TASK, via: "finish_turn" }, "tasks-key")).status, 401);
  assert.equal((await k.v1("POST", "/v1/finish", { task: TASK, via: "task_finish" }, "the-runners-key")).status, 400);
  const r = await k.v1("POST", "/v1/finish", { task: TASK, via: "finish_turn" }, "the-runners-key");
  assert.deepEqual(r.json, { pass: false, state: "pending" });
  assert.deepEqual(asked.at(-1).body.agent, null);
  assert.equal(asked.at(-1).body.via, "finish_turn");
  assert.equal(writes.at(-1).body.status, "in_review");
});

test("/v1/checks/:task: only the check's module; release drops its label; ok and reopen only resolve a hold it placed", async (t) => {
  const { k, writes, issue } = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" }));
  const resolve = (body, token = "grading-tok") => k.v1("POST", `/v1/checks/${TASK}`, body, token);
  assert.equal((await resolve({ verdict: "release" }, "other-tok")).status, 403);
  assert.equal((await resolve({ verdict: "ok" })).status, 409, "no hold yet");
  Object.assign(issue, { labelIds: ["lbl-x", "lbl-grading"] });
  assert.equal((await resolve({ verdict: "release" })).status, 200);
  assert.deepEqual(writes.at(-1), { as: "board-key", body: { labelIds: ["lbl-x"] } });
  await k.v1("POST", "/v1/finish", { task: TASK, via: "finish_turn" }, "the-runners-key");
  assert.equal((await resolve({ verdict: "ok", comment: "Graded: satisfied." })).status, 200);
  assert.deepEqual(writes.at(-1), { as: "board-key", body: { status: "done", comment: "Graded: satisfied." } });
  assert.equal((await resolve({ verdict: "reopen" })).status, 409, "the hold was resolved once");
});

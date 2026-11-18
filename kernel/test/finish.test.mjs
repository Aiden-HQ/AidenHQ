// The finish gate (checks.ts): a module's task.finish check on every move to done, a module acting for an agent through
// /v1/cp/agent; holds placed as the owner, released or resolved by the check's module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel, moduleServer, readBody, serve } from "./helpers.mjs";
import { HARD_GATES } from "../src/gates.ts";

const conn = (url, module, tools) => ({ url: `${url}/mcp`, auth_secret: `${module}_service_key`, module, returns: "trusted", tools: { read: [], write: [], destructive: [], ...tools } });
const agents = { "run-jwt-ada": { id: "ag-ada", name: "Ada" } };
const grants = { "ag-ada": { key: "ada", roles: [], tools: { todo: ["task_finish"] } } };
const TASK = "11111111-1111-1111-1111-111111111111";

/** A kernel with a task connection, one finish check answering `verdict(body)`, and a control plane holding one task. */
async function setup(t, verdict, { agentsScope, checks, graded = false } = {}) {
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
  const todo = await moduleServer(t, { key: "todo-key", tools: ["task_finish"], answer: async (msg, req) => {
    const r = await fetch(`${k.url}/v1/cp/agent/api/issues/${msg.params.arguments.task}`, { method: "PATCH", headers: { authorization: "Bearer todo-key", "x-aidenhq-caller": req.headers["x-aidenhq-caller"], "content-type": "application/json" }, body: JSON.stringify(msg.params.arguments.body) });
    return { content: [{ type: "text", text: JSON.stringify({ status: r.status, json: await r.json() }) }] };
  } });
  k = await kernel(t, {
    agents, grants: { "ag-ada": { ...grants["ag-ada"], ...(graded ? { graded: true } : {}) } }, secrets: { todo_service_key: "todo-key", judge_check_key: "check-key", judge_token: "judge-tok", other_token: "other-tok" },
    connections: { todo: conn(todo.url, "todo", { write: ["task_finish"] }) },
    modules: { modules: { judge: { roles: ["kernel.cp-read"], token: "judge_token" }, other: { roles: ["kernel.cp-read"], token: "other_token" } } },
    checks: checks ?? ({ "judge.finish": { module: "judge", at: "task.finish", url: `${check.url}/check/finish`, auth_secret: "judge_check_key", label: "held", ...(agentsScope ? { agents: agentsScope } : {}) } }),
    onControl: async (req, body, auth) => {
      if (req.method === "GET" && (req.url === `/api/issues/${TASK}` || req.url === "/api/issues/WOR-1")) return { body: issue };
      if (req.method === "GET" && req.url === "/api/companies/co/labels") return { body: [{ id: "lbl-x", name: "x" }, { id: "lbl-held", name: "held" }] };
      if (req.method === "PATCH") { const b = JSON.parse(body); writes.push({ as: auth, body: b }); Object.assign(issue, b); return { body: issue }; }
    },
  });
  const finish = async (body) => JSON.parse((await (await k.call("todo", "run-jwt-ada", { method: "tools/call", params: { name: "task_finish", arguments: { task: TASK, body } } })).json()).result.content[0].text);
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
  assert.deepEqual(writes, [{ as: "board-key", body: { status: "in_review", labelIds: ["lbl-x", "lbl-held"], executionPolicy: { mode: "normal", monitor: { nextCheckAt: until, notes: "The grader checks this task against its rubric." } } } }]);
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
    assert.match(r.json.error.message, /the finish check judge\.finish failed/);
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
  Object.assign(issue, { status: "in_review", labelIds: ["lbl-x", "lbl-held"] });
  answer = { verdict: "ok", unlabel: true };
  await finish({ status: "done" });
  assert.deepEqual(writes, [{ as: "board-key", body: { labelIds: ["lbl-x"] } }, { as: "run-jwt-ada", body: { status: "done" } }]);
  const n = asked.length;
  await finish({ status: "blocked" });
  assert.equal(asked.length, n, "only a move to done asks the checks");
});

test("/v1/checks/:task: only the check's module; release drops its label; ok and reopen only resolve a hold it placed", async (t) => {
  const { k, writes, issue, finish } = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" }));
  const resolve = (body, token = "judge-tok") => k.v1("POST", `/v1/checks/${TASK}`, body, token);
  assert.equal((await resolve({ verdict: "release" }, "other-tok")).status, 403);
  assert.equal((await resolve({ verdict: "ok" })).status, 409, "no hold yet");
  Object.assign(issue, { labelIds: ["lbl-x", "lbl-held"] });
  assert.equal((await resolve({ verdict: "release" })).status, 200);
  assert.deepEqual(writes.at(-1), { as: "board-key", body: { labelIds: ["lbl-x"] } });
  await finish({ status: "done" });
  assert.equal((await resolve({ verdict: "ok", comment: "Graded: satisfied." })).status, 200);
  assert.deepEqual(writes.at(-1), { as: "board-key", body: { status: "done", comment: "Graded: satisfied." } });
  assert.equal((await resolve({ verdict: "reopen" })).status, 409, "the hold was resolved once");
});

test("the finish gate never fails open: a graded assignee's task with no check covering it, or a checks file that won't load, refuses the close", async (t) => {
  // No finish check registered (the check's module isn't installed, or compile wrote none): an ungraded agent's close goes
  // ahead, a graded agent's is refused and nothing moves.
  let s = await setup(t, () => ({ verdict: "ok" }), { checks: {} });
  assert.equal((await s.finish({ status: "done" })).status, 200);
  s = await setup(t, () => ({ verdict: "ok" }), { checks: {}, graded: true });
  let r = await s.finish({ status: "done" });
  assert.equal(r.status, 503);
  assert.match(r.json.error.message, /the finish gate is unavailable: WOR-1's assignee is graded and no finish check covers it/);
  assert.deepEqual(s.writes, []);
  // A check scoped to other agents covers nothing here either.
  s = await setup(t, () => ({ verdict: "ok" }), { agentsScope: ["someone-else"], graded: true });
  assert.equal((await s.finish({ status: "done" })).status, 503);
  // checks.json missing or unparsable: a load error, for every close (graded or not), never "no checks".
  s = await setup(t, () => ({ verdict: "ok" }), { checks: () => { throw new SyntaxError("Unexpected end of JSON input"); } });
  r = await s.finish({ status: "done" });
  assert.equal(r.status, 503);
  assert.match(r.json.error.message, /the finish gate is unavailable: the finish checks didn't load \(Unexpected end of JSON input\)/);
  assert.deepEqual(s.writes, []);
});

test("an undecided approval card of the task refuses the close, whatever the checks say; once decided or run, the same finish passes", async (t) => {
  const card = { sentence: "Post the note.", changes: "", reads: "", cost: "", details: "" };
  const file = (k, state, task = TASK) => k.records.file({ kind: "conn.tool", module: "twin", args: { connection: "twin", tool: "post", arguments: { note: state } }, targets: {}, executor: { module: "twin" }, policy: "", tier: 1, panel: false, card, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task, state });
  for (const state of ["review", "owner"]) {
    // No module check installed either: the gate holds its own line.
    for (const checks of [undefined, {}]) {
      const s = await setup(t, () => ({ verdict: "ok" }), { checks });
      const rec = file(s.k, state);
      file(s.k, state, "another-task");
      let r = await s.finish({ status: "done", comment: "Done." });
      assert.equal(r.status, 409, state);
      assert.match(r.json.error.message, /^1 approval is on WOR-1 still undecided: k-[0-9a-f]+ \(conn\.tool\)\. They run when approved/);
      assert.deepEqual(s.writes, [], "nothing moved");
      assert.equal(s.issue.status, "in_progress");
      // Decided: the review rejects it, the owner's card is approved and its write runs.
      if (state === "review") s.k.records.review(rec.id, rec.digest, { decision: "reject", by: "reviewer:x", note: "no" });
      else { s.k.records.decide(rec.id, rec.digest, "approve", "owner:board", "board"); s.k.records.claim(rec.id); s.k.records.finish(rec.id, true, "posted"); }
      r = await s.finish({ status: "done", comment: "Done." });
      assert.equal(r.status, 200, state);
      assert.deepEqual(s.writes, [{ as: "run-jwt-ada", body: { status: "done", comment: "Done." } }]);
    }
  }
});

test("observe mode (gates.ts): a check's deny becomes a would-block entry and the close goes ahead; the same check enforcing refuses; a hard gate can't observe", async (t) => {
  const judge = (url, mode) => ({ "judge.finish": { module: "judge", at: "task.finish", url: `${url}/check/finish`, auth_secret: "judge_check_key", label: "held", ...(mode ? { mode } : {}) } });
  const deny = () => ({ verdict: "deny", reason: "no rubric attached" });
  // Observing: asked, recorded, never blocks or touches the task as the owner.
  const check = await serve((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(deny())));
  t.after(() => check.s.close());
  const url = check.url;
  let s = await setup(t, deny, { checks: judge(url, "observe") });
  assert.equal((await s.finish({ status: "done" })).status, 200);
  assert.deepEqual(s.writes, [{ as: "run-jwt-ada", body: { status: "done" } }]);
  const rows = s.k.records.db.prepare("SELECT data FROM events WHERE type = 'gate.would_block'").all().map((r) => JSON.parse(r.data));
  assert.deepEqual(rows, [{ gate: "judge.finish", task: "WOR-1", verdict: "deny", reason: "no rubric attached", via: "task_finish" }]);
  // Enforcing: the same deny refuses.
  s = await setup(t, deny, { checks: judge(url) });
  assert.equal((await s.finish({ status: "done" })).status, 403);
  assert.deepEqual(s.writes, []);
  // A hard gate set to observe doesn't load: every close is refused, never let through.
  const hard = [...HARD_GATES][0];
  s = await setup(t, deny, { checks: { [hard]: { ...judge(url)["judge.finish"], module: hard.split(".")[0], mode: "observe" } } });
  const r = await s.finish({ status: "done" });
  assert.equal(r.status, 503);
  assert.match(r.json.error.message, /is a hard gate: it always enforces/);
});

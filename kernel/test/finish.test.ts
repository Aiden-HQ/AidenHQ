// The finish gate (checks.ts): a module's task.finish check on every move to done, a module acting for an agent through
// /v1/cp/agent; holds placed as the owner, released or resolved by the check's module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel, moduleServer, readBody, serve } from "./helpers.ts";
import { HARD_GATES } from "../src/gates.ts";
import { createResolver } from "../src/net.ts";

const conn = (url, module, tools) => ({ url: `${url}/mcp`, auth_secret: `${module}_service_key`, module, returns: "trusted", tools: { read: [], write: [], destructive: [], ...tools } });
const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "11111111-1111-1111-1111-111111111111", DELEGATED = "22222222-2222-2222-2222-222222222222";
// A kernel job of Ada's on TASK; the kernel holds her Paperclip key (paperclip-agents/<id>) unless `keyless`.
const agents = { "run-jwt-ada": { id: ADA, name: "Ada", task: TASK } };
const grants = { [ADA]: { key: "ada", roles: [], tools: { todo: ["task_finish"] } } };

/**
 * A kernel with a task connection, one finish check answering `verdict(body)`, and a control plane holding TASK (Ada's) and
 * DELEGATED (Bo's); `extra`: more tasks by id, and a second job of Ada's on one of them (`job`).
 */
async function setup(t, verdict, { agentsScope, checks, checkResolver, graded = false, keyless = false, localChanges, status = "in_progress", labelIds = ["lbl-x"], extra = {}, job = "run-jwt-ada" } = {}) {
  const asked = [];
  const check = await serve(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    asked.push({ auth: req.headers.authorization, body });
    const v = await verdict(body);
    if (v === "hang") return;
    res.writeHead(v.http ?? 200, { "content-type": "application/json" }).end(JSON.stringify(v.body ?? v));
  });
  t.after(() => check.s.close());
  const issue = { id: TASK, identifier: "WOR-1", companyId: "co", status, assigneeAgentId: ADA, assigneeUserId: null, createdByAgentId: "ag-cos", parentId: null, labelIds, executionPolicy: { mode: "normal" } };
  const delegated = { id: DELEGATED, identifier: "WOR-2", companyId: "co", status: "in_review", assigneeAgentId: "ag-bo", assigneeUserId: null, createdByAgentId: ADA, parentId: null, labelIds: [] };
  const issues = { [TASK]: issue, [DELEGATED]: delegated, ...extra };
  const byRef = (ref: string) => issues[ref] ?? Object.values(issues).find((i) => i.identifier === ref);
  const writes = [];
  const ctl = { failPatch: 0 }; // PATCHes the control plane answers 502 to
  let k;
  const todo = await moduleServer(t, { key: "todo-key", tools: ["task_finish"], answer: async (msg, req) => {
    const r = await fetch(`${k.url}/v1/cp/agent/api/issues/${msg.params.arguments.task}`, { method: "PATCH", headers: { authorization: "Bearer todo-key", "x-aidenhq-caller": req.headers["x-aidenhq-caller"], "content-type": "application/json" }, body: JSON.stringify(msg.params.arguments.body) });
    return { content: [{ type: "text", text: JSON.stringify({ status: r.status, json: await r.json() }) }] };
  } });
  k = await kernel(t, {
    agents: job === "run-jwt-ada" ? agents : { ...agents, [job]: { id: ADA, name: "Ada", task: extra[Object.keys(extra)[0]!]!.id } },
    grants: { [ADA]: { ...grants[ADA], ...(graded ? { graded: true } : {}) } }, secrets: { todo_service_key: "todo-key", judge_check_key: "check-key", judge_token: "judge-tok", other_token: "other-tok", grading_token: "grading-tok", paperclip_post_key: "post-key", ...(keyless ? {} : { [`paperclip-agents/${ADA}`]: "ada-key" }) },
    connections: { todo: conn(todo.url, "todo", { write: ["task_finish"] }) },
    modules: { modules: { judge: { roles: ["kernel.cp-read"], token: "judge_token" }, other: { roles: ["kernel.cp-read"], token: "other_token" }, grading: { roles: ["kernel.grader"], token: "grading_token" } } },
    graderToken: (task, agent) => `grader-${task}-${agent}`,
    checks: checks ?? ({ "judge.finish": { module: "judge", at: "task.finish", url: `${check.url}/check/finish`, auth_secret: "judge_check_key", label: "held", ...(agentsScope ? { agents: agentsScope } : {}) } }),
    ...(checkResolver ? { checkResolver } : {}),
    ...(localChanges ? { localChanges } : {}),
    onControl: async (req, body, auth) => {
      const ref = /^\/api\/issues\/([^/?]+)$/.exec(req.url ?? "")?.[1];
      if (req.method === "GET" && ref && byRef(decodeURIComponent(ref))) return { body: byRef(decodeURIComponent(ref)) };
      if (req.method === "GET" && req.url === "/api/companies/co/labels") return { body: [{ id: "lbl-x", name: "x" }, { id: "lbl-held", name: "held" }, { id: "lbl-grading", name: "grading" }] };
      if (req.method === "PATCH" && ctl.failPatch) { ctl.failPatch--; return { status: 502, body: {} }; }
      if (req.method === "PATCH") { const b = JSON.parse(body); const i = byRef(decodeURIComponent(ref ?? "")) ?? issue; writes.push({ as: auth, body: b }); Object.assign(i, b); return { body: i }; }
      if (req.url === "/api/agents/me" && auth === "ada-key") return { body: { id: ADA, companyId: "co" } };
      // The agent's own close goes through the plugin's post action (cp.ts): recorded as Ada's write.
      if (req.url === "/api/plugins/aidenhq.events/actions/post") { const p = JSON.parse(body).params; const i = byRef(p.issueId ?? "") ?? issue; writes.push({ as: auth, body: { status: p.status, gated: p.gated } }); Object.assign(i, { status: p.status }); return { body: { data: { comment: null, child: null, found: false, status: p.status } } }; }
    },
  });
  const finish = async (body, task = TASK, as = job) => JSON.parse((await (await k.call("todo", as, { method: "tools/call", params: { name: "task_finish", arguments: { task, body } } })).json()).result.content[0].text);
  return { k, asked, writes, issue, issues, finish, ctl };
}

test("a holding check: the move to done isn't forwarded; the owner holds the task in review with the check's label and a scheduled check", async (t) => {
  const until = "2026-11-17T12:00:00.000Z";
  const { asked, writes, finish } = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "The grader checks this task against its rubric.", until }));
  const r = await finish({ status: "done", comment: "Merged." });
  assert.deepEqual(r, { status: 202, json: { held: { state: "pending", reason: "The grader checks this task against its rubric." } } });
  // The check heard who is finishing, with what, on which task; with its own key.
  assert.equal(asked[0].auth, "Bearer check-key");
  assert.deepEqual(asked[0].body, { task: { id: TASK, identifier: "WOR-1", status: "in_progress", assigneeAgentId: ADA, assigneeUserId: null, createdByAgentId: "ag-cos", parentId: null }, agent: ADA, tool: "task_finish", via: "task_finish" });
  // One write, as the owner (the board key); the agent's own move to done never reached the control plane.
  assert.deepEqual(writes, [{ as: "board-key", body: { status: "in_review", labelIds: ["lbl-x", "lbl-held"], executionPolicy: { mode: "normal", monitor: { nextCheckAt: until, notes: "The grader checks this task against its rubric." } } } }]);
});

test("a holding check that named no until: still in review with the check's label and a saved check at the default deadline", async (t) => {
  const before = Date.now();
  const { writes, finish } = await setup(t, () => ({ verdict: "hold", reason: "needs a look" }));
  const r = await finish({ status: "done" });
  assert.deepEqual(r, { status: 202, json: { held: { state: "hold", reason: "needs a look" } } });
  assert.equal(writes.length, 1);
  const { as, body } = writes[0];
  assert.equal(as, "board-key");
  assert.deepEqual(body.labelIds, ["lbl-x", "lbl-held"]);
  assert.equal(body.status, "in_review");
  assert.equal(body.executionPolicy.mode, "normal");
  assert.equal(body.executionPolicy.monitor.notes, "needs a look");
  const at = Date.parse(body.executionPolicy.monitor.nextCheckAt);
  assert.ok(at > before, `${body.executionPolicy.monitor.nextCheckAt} is in the future`);
  assert.ok(at <= Date.now() + 61 * 60_000, `${body.executionPolicy.monitor.nextCheckAt} is at the default hour`);
});

/** A resolver that fails to find the service `down` times ("isn't running", what a container mid-replacement looks like) and
 * then answers as the real one: each attempt is counted and each forget() recorded. */
function flakyResolver(down) {
  const real = createResolver(), calls = { resolve: 0, forget: 0 };
  return {
    calls,
    resolve: async (url) => { calls.resolve++; if (calls.resolve <= down) throw new Error(`the service ${new URL(url).hostname} isn't running`); return real.resolve(url); },
    forget: (url) => { calls.forget++; real.forget(url); },
  };
}

test("a check whose service is mid-replacement is asked again, and the finish passes: no hold row, no 503", async (t) => {
  const resolver = flakyResolver(1);
  const s = await setup(t, () => ({ verdict: "ok" }), { checkResolver: resolver });
  const r = await s.finish({ status: "done" });
  assert.equal(r.status, 200);
  assert.deepEqual(resolver.calls, { resolve: 2, forget: 1 }, "the address is inspected afresh between attempts");
  assert.deepEqual(s.writes, [{ as: "ada-key", body: { status: "done", gated: true } }]);
  assert.equal(s.k.records.db.prepare("SELECT 1 FROM check_holds").get(), undefined, "no hold was recorded");
});

test("a check service still unavailable after its attempts holds the task in review instead of refusing the close", async (t) => {
  const before = Date.now();
  const resolver = flakyResolver(Infinity);
  const s = await setup(t, () => ({ verdict: "ok" }), { checkResolver: resolver });
  const r = await s.finish({ status: "done" });
  assert.equal(r.status, 202, "a restarting service parks the finish, it doesn't 503");
  assert.equal(r.json.held.state, "pending");
  assert.match(r.json.held.reason, /couldn't be reached/);
  assert.equal(resolver.calls.resolve, 3, "a bounded number of attempts");
  assert.equal(resolver.calls.forget, 2, "one forget between each pair");
  // The held branch: the owner keeps it in review under the check's label with a saved re-check, and the hold row is written.
  assert.equal(s.writes.length, 1);
  const { as, body } = s.writes[0];
  assert.equal(as, "board-key");
  assert.equal(body.status, "in_review");
  assert.deepEqual(body.labelIds, ["lbl-x", "lbl-held"]);
  const at = Date.parse(body.executionPolicy.monitor.nextCheckAt);
  assert.ok(at > before && at <= Date.now() + 61 * 60_000, `${body.executionPolicy.monitor.nextCheckAt} is at the default hour`);
  assert.equal(s.issue.status, "in_review");
  assert.ok(s.k.records.db.prepare("SELECT 1 FROM check_holds WHERE task = ? AND check_id = 'judge.finish'").get(TASK), "the hold is recorded");
});

test("a cross-task finish whose check service is unavailable parks in review, and no unavailable check stands in for accepts", async (t) => {
  const resolver = flakyResolver(Infinity);
  const s = await setup(t, () => ({ verdict: "ok", accepts: true }), { checkResolver: resolver });
  const r = await s.finish({ status: "done" }, DELEGATED);
  assert.equal(r.status, 202, "the delegator's acceptance isn't lost while the service restarts");
  assert.equal(r.json.held.state, "pending");
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].as, "board-key");
  assert.notEqual(s.writes[0].body.status, "done", "nothing moved the task to done");
  assert.deepEqual(s.writes[0].body.labelIds, ["lbl-held"], "held under the check's label");
  assert.ok(s.writes[0].body.executionPolicy.monitor.nextCheckAt, "the re-check is saved");
  assert.ok(s.k.records.db.prepare("SELECT 1 FROM check_holds WHERE task = ? AND check_id = 'judge.finish'").get(DELEGATED), "the hold is recorded");
});

test("a check that answers deny or reopen is not retried: one ask, and the close still refuses or reopens", async (t) => {
  const resolver = flakyResolver(0);
  let answer = { verdict: "deny", status: 403, reason: "not yet" };
  const s = await setup(t, () => answer, { checkResolver: resolver });
  let r = await s.finish({ status: "done" });
  assert.equal(r.status, 403);
  assert.equal(resolver.calls.resolve, 1, "a real verdict is never retried");
  answer = { verdict: "reopen", reason: "the tests are red" };
  r = await s.finish({ status: "done" });
  assert.deepEqual(r, { status: 202, json: { reopened: { reason: "the tests are red" } } });
  assert.equal(s.issue.status, "todo");
  assert.equal(resolver.calls.resolve, 2, "one ask per finish, no retry storm");
  assert.equal(resolver.calls.forget, 0);
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

test("ok passes the close on: Ada's own write through the plugin, gated; ok with unlabel drops the check's label first; other changes skip the gate", async (t) => {
  let answer = { verdict: "ok" };
  const { asked, writes, issue, finish } = await setup(t, () => answer);
  let r = await finish({ status: "done", comment: "Done." });
  assert.equal(r.status, 200);
  assert.deepEqual(writes, [{ as: "ada-key", body: { status: "done", gated: true } }]);
  writes.length = 0;
  Object.assign(issue, { status: "in_progress" });
  Object.assign(issue, { status: "in_review", labelIds: ["lbl-x", "lbl-held"] });
  answer = { verdict: "ok", unlabel: true };
  await finish({ status: "done" });
  assert.deepEqual(writes, [{ as: "board-key", body: { labelIds: ["lbl-x"] } }, { as: "ada-key", body: { status: "done", gated: true } }]);
  const n = asked.length;
  await finish({ status: "blocked" });
  assert.equal(asked.length, n, "only a move to done asks the checks");
});

test("no control-plane identity: refused before the finish gate runs", async (t) => {
  const { asked, writes, finish } = await setup(t, () => ({ verdict: "ok" }), { keyless: true });
  const r = await finish({ status: "done" });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /no control-plane identity/);
  assert.deepEqual([asked.length, writes.length], [0, 0]);
});
test("a grader token is minted for an in_review task under the finish check's label with no check_holds row", async (t) => {
  // A task the gate held keeps its check_holds row; one the gate never recorded (left in review by an older kernel) is still
  // held by the check's own label on a task in review.
  const checks = { "grading.finish": { module: "grading", at: "task.finish", url: "http://127.0.0.1:1/check/finish", auth_secret: "judge_check_key", label: "grading" } };
  const s = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "r" }), { checks, status: "in_review", labelIds: ["lbl-x", "lbl-grading"] });
  assert.equal(s.k.records.db.prepare("SELECT 1 FROM check_holds").get(), undefined, "no row was written");
  const mint = (task = TASK, token = "grading-tok") => s.k.v1("POST", "/v1/work/grader-token", { task }, token);
  const minted = await mint();
  assert.equal(minted.status, 200);
  assert.deepEqual(minted.json, { token: `grader-${TASK}-${ADA}` }, "billed to the task's assignee");
  // The label holds only while the task waits in review, and only the check's own label: an unknown task is refused.
  Object.assign(s.issue, { status: "todo" });
  assert.equal((await mint()).status, 403);
  Object.assign(s.issue, { status: "in_review", labelIds: ["lbl-x"] });
  assert.equal((await mint()).status, 403, "another label is no hold");
  assert.equal((await mint(DELEGATED)).status, 403, "a task no finish check of the module holds");
  // The label makes the task gradable; it is not the gate's recorded hold, so it cannot be resolved by the module: only the row
  // that `finish()` writes can (a module may not close a hold it never placed).
  Object.assign(s.issue, { status: "in_review", labelIds: ["lbl-x", "lbl-grading"] });
  assert.equal((await s.k.v1("POST", `/v1/checks/${TASK}`, { verdict: "ok" }, "grading-tok")).status, 409, "no recorded row to resolve");
  // A recorded hold is authoritative: the row holds whatever the task's status or labels say (the gate took the label).
  s.k.records.db.prepare("INSERT INTO check_holds (task, check_id, at) VALUES (?, 'grading.finish', ?)").run(TASK, new Date().toISOString());
  Object.assign(s.issue, { status: "todo" });
  assert.equal((await mint()).status, 200);
});

test("/v1/checks/:task: only the check's module; release drops its label; ok and reopen only resolve a hold it placed", async (t) => {
  const { k, writes, issue, finish } = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" }));
  const resolve = (body, token = "judge-tok") => k.v1("POST", `/v1/checks/${TASK}`, body, token);
  assert.equal((await resolve({ verdict: "release" }, "other-tok")).status, 403);
  assert.equal((await resolve({ verdict: "ok" })).status, 409, "no hold yet");
  assert.equal((await resolve({ verdict: "constructor" })).status, 400, "only the named verdicts resolve");
  // A release on a task the check never held changes nothing and records nothing.
  Object.assign(issue, { labelIds: ["lbl-x", "lbl-held"] });
  const before = writes.length;
  assert.equal((await resolve({ verdict: "release" })).status, 200);
  assert.equal(writes.length, before, "a task the check never held is not touched");
  await finish({ status: "done" });
  // A release naming a time before the hold (the module read its state earlier) leaves that newer hold alone.
  const kept = writes.length;
  assert.deepEqual((await resolve({ verdict: "release", before: "2000-01-01T00:00:00.000Z" })).json, { ok: true, held: false });
  assert.equal(writes.length, kept);
  assert.equal((await resolve({ verdict: "release", before: new Date(Date.now() + 1000).toISOString() })).status, 200);
  assert.deepEqual(writes.at(-1), { as: "board-key", body: { labelIds: ["lbl-x"] } });
  await finish({ status: "done" });
  assert.equal((await resolve({ verdict: "ok", comment: "Graded: satisfied." })).status, 200);
  // One move: the status, the label off and the comment together.
  assert.deepEqual(writes.at(-1), { as: "board-key", body: { status: "done", labelIds: ["lbl-x"], comment: "Graded: satisfied." } });
  assert.equal((await resolve({ verdict: "reopen" })).status, 409, "the hold was resolved once");
  // Each hold and its end are facts task state reads: held (waiting on the module), then released (the delegator's) or resolved.
  const facts = k.records.db.prepare("SELECT type, json_extract(data, '$.verdict') AS v FROM facts WHERE task = ? AND type LIKE 'finish.%' ORDER BY seq").all(TASK).map((r) => `${r.type}${r.v ? `:${r.v}` : ""}`);
  assert.deepEqual(facts, ["finish.held", "finish.verdict:release", "finish.held", "finish.verdict:ok"]);
});

test("a resolve the control plane fails keeps the hold, so the module's retry moves the task", async (t) => {
  const { k, issue, finish, ctl } = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" }));
  const resolve = (body) => k.v1("POST", `/v1/checks/${TASK}`, body, "judge-tok");
  await finish({ status: "done" });
  ctl.failPatch = 1;
  assert.equal((await resolve({ verdict: "ok" })).status, 502);
  assert.equal(issue.status, "in_review");
  assert.equal((await resolve({ verdict: "ok" })).status, 200);
  assert.equal(issue.status, "done");
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
      assert.deepEqual(s.writes, [{ as: "ada-key", body: { status: "done", gated: true } }]);
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
  assert.deepEqual(s.writes, [{ as: "ada-key", body: { status: "done", gated: true } }], "Ada's own close, never the owner's");
  const rows = s.k.records.db.prepare("SELECT data FROM facts WHERE type = 'gate.would_block' AND subject = 'task:WOR-1'").all().map((r) => JSON.parse(r.data));
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

test("a delegated task closes from its delegator only when a check accepts (an escalated grade); any other cross-task close is refused", async (t) => {
  let answer = { verdict: "ok" };
  const { finish, writes } = await setup(t, () => answer);
  for (const v of [{ verdict: "ok" }, { verdict: "pending", state: "pending", reason: "r" }, { verdict: "deny", status: 403, reason: "x" }]) {
    answer = v;
    const r = await finish({ status: "done" }, DELEGATED);
    assert.equal(r.status, 403, JSON.stringify(v));
  }
  assert.deepEqual(writes, [], "a refused cross-task close moves nothing");
  answer = { verdict: "ok", unlabel: true, accepts: true };
  assert.equal((await finish({ status: "done" }, DELEGATED)).status, 200);
});

test("a task the closing agent holds from an earlier run closes (an orphaned run's task); another agent's is still refused; a graded one is held by the check", async (t) => {
  // Two jobs of Ada's on different tasks: an earlier run on ORPHAN ended without task_finish, and the new run (job run-jwt-new)
  // closes it with `issue` (AidenHQ#1003). It is hers, so it is not a cross-task close: the check hears it as her own.
  const ORPHAN = "33333333-3333-4333-8333-333333333333";
  let answer = { verdict: "ok" };
  const s = await setup(t, () => answer, {
    extra: { [ORPHAN]: { id: ORPHAN, identifier: "WOR-9", companyId: "co", status: "in_progress", assigneeAgentId: ADA, assigneeUserId: null, createdByAgentId: "ag-cos", parentId: null, labelIds: [] } },
    job: "run-jwt-new",
  });
  let r = await s.finish({ status: "done", comment: "The earlier run left this open; closing it." }, ORPHAN);
  assert.equal(r.status, 200);
  assert.deepEqual(s.writes, [{ as: "ada-key", body: { status: "done", gated: true } }], "closed as Ada, gated, on the orphan's own task");
  assert.equal(s.issues[ORPHAN].status, "done");
  assert.equal(s.asked.at(-1).body.task.id, ORPHAN, "the check heard the task it closes, never the job's own");
  // A task assigned to another agent is nobody's here but its delegator's acceptance: still refused, before anything moves.
  const before = s.writes.length;
  for (const v of [{ verdict: "ok" }, { verdict: "pending", state: "pending", reason: "r" }]) {
    answer = v;
    assert.equal((await s.finish({ status: "done" }, DELEGATED)).status, 403, JSON.stringify(v));
  }
  assert.equal(s.writes.length, before, "a refused close of another agent's task moves nothing");
  answer = { verdict: "ok", unlabel: true, accepts: true };
  assert.equal((await s.finish({ status: "done" }, DELEGATED)).status, 200, "the delegated-grade path is unchanged");
  // A graded task of Ada's own (from an earlier run too) is still held by the grader: the check's hold decides, no bypass.
  answer = { verdict: "pending", state: "pending", reason: "the grader checks this task", until: "2026-11-17T12:00:00.000Z" };
  assert.deepEqual((await s.finish({ status: "done" }, ORPHAN)).status, 202);
  assert.equal(s.issues[ORPHAN].status, "in_review");
});
test("the reported ordering: a task whose own local change is open cannot reach done, green-but-unmerged most of all; a merged or closed change lets it", async (t) => {
  // The reported sequence (AidenHQ#709): the task was marked done at once, the merge was never asked for, and the merge card
  // approved later was dropped as "the task is closed". The finish gate refuses first, whatever the checks say.
  let open = [{ url: "codehost:local/hello/change/1", checks: [{ ok: true, pending: false }] }];
  const s = await setup(t, () => ({ verdict: "ok" }), { localChanges: async ({ id, identifier }) => (id === TASK || identifier === "WOR-1" ? open : []) });
  let r = await s.finish({ status: "done", comment: "Done." });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /WOR-1's change request codehost:local\/hello\/change\/1 is still open \(every named check is green, but the merge hasn't landed\)/);
  assert.match(r.json.error.message, /A task closes after its change merges/);
  assert.deepEqual(s.writes, [], "nothing moved: no in_review, no done");
  assert.equal(s.issue.status, "in_progress");
  // A change whose checks are still running (or red) holds it just the same, saying what is true of it now.
  open = [{ url: "codehost:local/hello/change/1", checks: [{ ok: false, pending: true }] }];
  r = await s.finish({ status: "done" });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /its checks are still running/);
  open = [{ url: "codehost:local/hello/change/1", checks: [{ ok: false, pending: false }] }];
  assert.match((await s.finish({ status: "done" })).json.error.message, /its checks aren't all green/);
  // Another task's change holds nothing (the seam names only this task's); once the merge lands (or the change is closed) the
  // same finish passes, and only then does Ada's own gated write reach the control plane.
  open = [];
  assert.equal((await s.finish({ status: "done" })).status, 200);
  assert.deepEqual(s.writes, [{ as: "ada-key", body: { status: "done", gated: true } }]);
});

test("the finish gate never fails open: a change store the kernel can't read keeps the task as it is", async (t) => {
  const s = await setup(t, () => ({ verdict: "ok" }), { localChanges: async () => { throw new Error("the data dir isn't readable"); } });
  const r = await s.finish({ status: "done" });
  assert.equal(r.status, 503);
  assert.match(r.json.error.message, /couldn't read WOR-1's change requests on this server \(the data dir isn't readable\)/);
  assert.deepEqual(s.writes, []);
});

test("a module's ok on its hold is the same gate: it can't move a task to done while its local change is open, and it keeps the hold", async (t) => {
  // The hold is placed while nothing is open; the task's change opens while it is held. A module's ok moves it to done as the
  // owner and comes through the same hold, so a green-but-unmerged change stops it there too.
  let open = [];
  const s = await setup(t, () => ({ verdict: "hold", state: "held", reason: "the grader checks this task" }), { localChanges: async () => open });
  await s.finish({ status: "done" });
  assert.equal(s.issue.status, "in_review", "held by the check");
  open = [{ url: "codehost:local/hello/change/1", checks: [{ ok: true, pending: false }] }];
  const res = await s.k.v1("POST", `/v1/checks/${TASK}`, { verdict: "ok", comment: "graded" }, "judge-tok");
  assert.equal(res.status, 409);
  assert.match(String(res.json.error.message), /still open/);
  assert.equal(s.issue.status, "in_review", "the hold is kept, and nothing moved to done");
  // The change lands (it is no longer open): the same ok moves it on.
  open = [];
  const again = await s.k.v1("POST", `/v1/checks/${TASK}`, { verdict: "ok", comment: "graded" }, "judge-tok");
  assert.equal(again.status, 200);
  assert.equal(s.issue.status, "done");
});


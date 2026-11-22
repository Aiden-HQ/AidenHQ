// The finish gate (checks.ts): a module's task.finish check on every move to done, a module acting for an agent through
// /v1/cp/agent; holds placed as the owner, released or resolved by the check's module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel, moduleServer, readBody, serve } from "./helpers.ts";

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

test("a deny refuses the close with its status and reason, and a failed check holds the task in review instead", async (t) => {
  let answer = { verdict: "deny", status: 403, reason: "only its assignee finishes it" };
  const { writes, finish } = await setup(t, () => answer);
  let r = await finish({ status: "done" });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /only its assignee finishes it/);
  answer = { verdict: "deny", status: 409, reason: "the task is cancelled" };
  assert.equal((await finish({ status: "done" })).status, 409);
  assert.equal(writes.length, 0);
  // Fail open: an error status, a malformed verdict, a hang past 10 s hold the task in review for the re-check, never a refusal or a pass.
  for (const bad of [{ http: 500, body: { error: "boom" } }, { verdict: "maybe" }]) {
    answer = bad;
    r = await finish({ status: "done" });
    assert.equal(r.status, 202, JSON.stringify(bad));
    assert.match(r.json.held.reason, /couldn't be reached/);
  }
});

test("ok passes the close on: Ada's own write through the plugin, gated; other changes skip the gate", async (t) => {
  let answer = { verdict: "ok" };
  const { asked, writes, issue, finish } = await setup(t, () => answer);
  let r = await finish({ status: "done", comment: "Done." });
  assert.equal(r.status, 200);
  assert.deepEqual(writes, [{ as: "ada-key", body: { status: "done", gated: true } }]);
  const n = asked.length;
  await finish({ status: "blocked" });
  assert.equal(asked.length, n, "only a move to done asks the checks");
});

test("/v1/checks/:task: only the check's module; ok and reopen only resolve a hold it placed", async (t) => {
  const { k, writes, issue, finish } = await setup(t, () => ({ verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" }));
  const resolve = (body, token = "judge-tok") => k.v1("POST", `/v1/checks/${TASK}`, body, token);
  assert.equal((await resolve({ verdict: "ok" }, "other-tok")).status, 403);
  assert.equal((await resolve({ verdict: "ok" })).status, 409, "no hold yet");
  assert.equal((await resolve({ verdict: "release" })).status, 400, "only the named verdicts resolve");
  Object.assign(issue, { labelIds: ["lbl-x"] });
  await finish({ status: "done" });
  assert.equal((await resolve({ verdict: "ok", comment: "Graded: satisfied." })).status, 200);
  // One move: the status, the label off and the comment together.
  assert.deepEqual(writes.at(-1), { as: "board-key", body: { status: "done", labelIds: ["lbl-x"], comment: "Graded: satisfied." } });
  assert.equal((await resolve({ verdict: "reopen" })).status, 409, "the hold was resolved once");
  // Each hold and its end are facts task state reads: held (waiting on the module), then resolved.
  const facts = k.records.db.prepare("SELECT type, json_extract(data, '$.verdict') AS v FROM facts WHERE task = ? AND type LIKE 'finish.%' ORDER BY seq").all(TASK).map((r) => `${r.type}${r.v ? `:${r.v}` : ""}`);
  assert.deepEqual(facts, ["finish.held", "finish.verdict:ok"]);
});

test("an undecided approval card of the task refuses the close, whatever the checks say; once decided or run, the same finish passes", async (t) => {
  const card = { sentence: "Post the note.", changes: "", reads: "", cost: "", details: "" };
  const file = (k, state, task = TASK) => k.records.file({ kind: "conn.tool", module: "twin", args: { connection: "twin", tool: "post", arguments: { note: state } }, targets: {}, executor: { module: "twin" }, policy: "", tier: 1, card, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task, state });
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

test("a cross-task close is refused before any check is asked, whatever the check would say", async (t) => {
  let answer = { verdict: "ok" };
  const { finish, writes } = await setup(t, () => answer);
  for (const v of [{ verdict: "ok" }, { verdict: "pending", state: "pending", reason: "r" }, { verdict: "deny", status: 403, reason: "x" }]) {
    answer = v;
    const r = await finish({ status: "done" }, DELEGATED);
    assert.equal(r.status, 403, JSON.stringify(v));
  }
  assert.deepEqual(writes, [], "a refused cross-task close moves nothing");
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

test("two checks hold a task: a reopen by one ends both holds, so a later submission held only by the other closes on ok", async (t) => {
  // Two real check servers: both hold the first submission, so both write a check_holds row. One reopens; the other's row must
  // not survive to match the task's next submission, or that submission's `ok` would see it as "another check still holds".
  const answers = { judge: { verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" }, grading: { verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" } };
  const serveCheck = async (which) => {
    const s = await serve(async (req, res) => { await readBody(req); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answers[which])); });
    t.after(() => s.s.close());
    return s.url;
  };
  const judgeUrl = await serveCheck("judge"), gradingUrl = await serveCheck("grading");
  const checks = {
    "judge.finish": { module: "judge", at: "task.finish", url: `${judgeUrl}/check/finish`, auth_secret: "judge_check_key", label: "held" },
    "grading.finish": { module: "grading", at: "task.finish", url: `${gradingUrl}/check/finish`, auth_secret: "judge_check_key", label: "grading" },
  };
  const s = await setup(t, () => ({ verdict: "ok" }), { checks });
  const rows = () => s.k.records.db.prepare("SELECT check_id FROM check_holds WHERE task = ? ORDER BY check_id").all(TASK).map((r) => r.check_id);
  assert.equal((await s.finish({ status: "done" })).status, 202);
  assert.deepEqual(rows(), ["grading.finish", "judge.finish"], "both holds recorded");
  // Grading reopens through its own token: the review is over, so judge's stale row goes with it.
  answers.grading = { verdict: "reopen", reason: "rework it" };
  assert.equal((await s.k.v1("POST", `/v1/checks/${TASK}`, { verdict: "reopen", reason: "rework it" }, "grading-tok")).status, 200);
  assert.deepEqual(rows(), [], "the sibling hold ended with the review");
  assert.equal(s.issue.status, "todo");
  // The sibling's label goes with its row: a label left behind is what holds() reads as a hold, so a task that later comes
  // back in review would authorize judge's token with no recorded hold.
  assert.deepEqual(s.issue.labelIds, ["lbl-x"], "both checks' labels are off, not only the resolving one's");
  // Each ended hold has its own verdict fact, so task state pairs held and verdict per check and reads neither as unresolved.
  const sibling = s.k.records.db.prepare("SELECT data FROM facts WHERE task = ? AND type = 'finish.verdict' AND json_extract(data, '$.check') = 'judge.finish' ORDER BY seq DESC LIMIT 1").get(TASK);
  assert.equal(JSON.parse(String(sibling?.data)).verdict, "reopen", "the sibling hold's fact says its verdict too");
  // Resubmitted and finished again: judge holds it, grading passes it, and judge's own ok then closes the task.
  Object.assign(s.issue, { status: "in_progress" });
  answers.judge = { verdict: "pending", state: "pending", reason: "r", until: "2026-11-17T12:00:00.000Z" };
  answers.grading = { verdict: "ok" };
  assert.equal((await s.finish({ status: "done" })).status, 202);
  assert.deepEqual(rows(), ["judge.finish"], "the resubmission's hold is judge's alone");
  answers.judge = { verdict: "ok" };
  assert.equal((await s.k.v1("POST", `/v1/checks/${TASK}`, { verdict: "ok" }, "judge-tok")).status, 200);
  assert.equal(s.issue.status, "done", "ok closes: no stale sibling row stops it");
});

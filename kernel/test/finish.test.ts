// The finish gate (checks.ts): every move to done, a module acting for an agent through /v1/cp/agent. It refuses only an
// undecided card or an open local change; nothing holds a task, and a rubric module that is down never stops a close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel, moduleServer } from "./helpers.ts";

const conn = (url, module, tools) => ({ url: `${url}/mcp`, auth_secret: `${module}_service_key`, module, returns: "trusted", tools: { read: [], write: [], destructive: [], ...tools } });
const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "11111111-1111-1111-1111-111111111111", DELEGATED = "22222222-2222-2222-2222-222222222222";
const agents = { "run-jwt-ada": { id: ADA, name: "Ada", task: TASK } };
const grants = { [ADA]: { key: "ada", roles: [], tools: { todo: ["task_finish"] } } };

/** A kernel with a task connection and a control plane holding TASK (Ada's) and DELEGATED (Bo's). The rubric module's check points nowhere. */
async function setup(t, { checks, localChanges } = {}) {
  const issue = { id: TASK, identifier: "WOR-1", companyId: "co", status: "in_progress", assigneeAgentId: ADA, assigneeUserId: null, createdByAgentId: "ag-cos", parentId: null, labelIds: [] };
  const delegated = { id: DELEGATED, identifier: "WOR-2", companyId: "co", status: "in_review", assigneeAgentId: "ag-bo", assigneeUserId: null, createdByAgentId: ADA, parentId: null, labelIds: [] };
  const issues = { [TASK]: issue, [DELEGATED]: delegated };
  const byRef = (ref: string) => issues[ref] ?? Object.values(issues).find((i) => i.identifier === ref);
  const writes = [];
  let k;
  const todo = await moduleServer(t, { key: "todo-key", tools: ["task_finish"], answer: async (msg, req) => {
    const r = await fetch(`${k.url}/v1/cp/agent/api/issues/${msg.params.arguments.task}`, { method: "PATCH", headers: { authorization: "Bearer todo-key", "x-aidenhq-caller": req.headers["x-aidenhq-caller"], "content-type": "application/json" }, body: JSON.stringify(msg.params.arguments.body) });
    return { content: [{ type: "text", text: JSON.stringify({ status: r.status, json: await r.json() }) }] };
  } });
  k = await kernel(t, {
    agents, grants, secrets: { todo_service_key: "todo-key", grading_check_key: "check-key", paperclip_post_key: "post-key", [`paperclip-agents/${ADA}`]: "ada-key" },
    connections: { todo: conn(todo.url, "todo", { write: ["task_finish"] }) },
    checks: checks ?? { "grading.rubric": { module: "grading", at: "task.rubric", url: "http://127.0.0.1:9/check/rubric", auth_secret: "grading_check_key" } },
    ...(localChanges ? { localChanges } : {}),
    onControl: async (req, body, auth) => {
      const ref = /^\/api\/issues\/([^/?]+)$/.exec(req.url ?? "")?.[1];
      if (req.method === "GET" && ref && byRef(decodeURIComponent(ref))) return { body: byRef(decodeURIComponent(ref)) };
      if (req.method === "PATCH") { const b = JSON.parse(body); writes.push({ as: auth, body: b }); Object.assign(issue, b); return { body: issue }; }
      if (req.url === "/api/agents/me" && auth === "ada-key") return { body: { id: ADA, companyId: "co" } };
      if (req.url === "/api/plugins/aidenhq.events/actions/post") { const p = JSON.parse(body).params; const i = byRef(p.issueId ?? "") ?? issue; writes.push({ as: auth, body: { status: p.status, gated: p.gated } }); Object.assign(i, { status: p.status }); return { body: { data: { comment: null, child: null, found: false, status: p.status } } }; }
    },
  });
  const finish = async (body, task = TASK) => JSON.parse((await (await k.call("todo", "run-jwt-ada", { method: "tools/call", params: { name: "task_finish", arguments: { task, body } } })).json()).result.content[0].text);
  return { k, writes, issue, finish };
}

test("a finish closes the task at once, with the rubric module unreachable: Ada's own write, gated; nothing held", async (t) => {
  const { writes, issue, finish } = await setup(t);
  const r = await finish({ status: "done", comment: "Done." });
  assert.equal(r.status, 200);
  assert.deepEqual(writes, [{ as: "ada-key", body: { status: "done", gated: true } }]);
  assert.equal(issue.status, "done");
});

test("an undecided approval card of the task refuses the close, whatever the checks say; once decided or run, the same finish passes", async (t) => {
  const card = { sentence: "Post the note.", changes: "", reads: "", cost: "", details: "" };
  const file = (k, state, task = TASK) => k.records.file({ kind: "conn.tool", module: "twin", args: { connection: "twin", tool: "post", arguments: { note: state } }, targets: {}, executor: { module: "twin" }, policy: "", tier: 1, card, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task, state });
  for (const state of ["review", "owner"]) {
    // No module check installed either: the gate holds its own line.
    for (const checks of [undefined, {}]) {
      const s = await setup(t, { checks });
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

test("a cross-task close is refused", async (t) => {
  const { finish, writes } = await setup(t);
  assert.equal((await finish({ status: "done" }, DELEGATED)).status, 403);
  assert.deepEqual(writes, [], "a refused cross-task close moves nothing");
});

test("the reported ordering: a task whose own local change is open cannot reach done, green-but-unmerged most of all; a merged or closed change lets it", async (t) => {
  // The reported sequence (AidenHQ#709): the task was marked done at once, the merge was never asked for, and the merge card
  // approved later was dropped as "the task is closed". The finish gate refuses first, whatever the checks say.
  let open = [{ url: "codehost:local/hello/change/1", checks: [{ ok: true, pending: false }] }];
  const s = await setup(t, { localChanges: async ({ id, identifier }) => (id === TASK || identifier === "WOR-1" ? open : []) });
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
  const s = await setup(t, { localChanges: async () => { throw new Error("the data dir isn't readable"); } });
  const r = await s.finish({ status: "done" });
  assert.equal(r.status, 503);
  assert.match(r.json.error.message, /couldn't read WOR-1's change requests on this server \(the data dir isn't readable\)/);
  assert.deepEqual(s.writes, []);
});

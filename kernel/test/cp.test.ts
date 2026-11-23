// /v1/cp/agent (cp.ts): a module acting for a kernel job reads with the agent's own key and writes only through the
// paperclip-events plugin's signed `post` action (the real one, services/paperclip-events/post.js, behind a fake Paperclip),
// on the tasks the kernel lets that job write on. A task the job creates carries its routine cap (provenance.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobs } from "../src/jobs.ts";
import { ORIGIN } from "../src/provenance.ts";
import { taskRoutineCap } from "../src/tier.ts";
import { SELF_TAG } from "../src/wakes.ts";
import { post } from "../../services/paperclip-events/post.js";
import { kernel, moduleServer, pluginHost } from "./helpers.ts";

const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", BO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", COS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", EVE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LEAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", REP = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", ENG = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const STW = "ffffffff-ffff-4fff-8fff-ffffffffffff", SET = "ffffffff-ffff-4fff-8fff-fffffffffff1";
const OWN = "10000000-0000-4000-8000-000000000001", OTHER = "10000000-0000-4000-8000-000000000002", CHAT = "10000000-0000-4000-8000-000000000003";
const FLEET = "10000000-0000-4000-8000-000000000004", HANDED = "10000000-0000-4000-8000-000000000005", MINE = "10000000-0000-4000-8000-000000000006";
const KEYS = { "key-ada": ADA, "key-cos": COS, "key-lead": LEAD, "key-stw": STW, "key-set": SET };

async function setup(t, { projects } = {}) {
  const h = pluginHost({
    [OWN]: { id: OWN, identifier: "WOR-1", status: "in_progress", assigneeAgentId: ADA, companyId: "co", parentId: null },
    [OTHER]: { id: OTHER, identifier: "WOR-2", status: "in_progress", assigneeAgentId: BO, companyId: "co", parentId: null },
    [CHAT]: { id: CHAT, identifier: "WOR-3", status: "todo", assigneeAgentId: BO, companyId: "co", parentId: null },
    [FLEET]: { id: FLEET, identifier: "WOR-4", status: "todo", assigneeAgentId: null, companyId: "co", parentId: null },
    // An agent's task it handed back to the owner (task_handoff), and a task the owner made for themselves.
    [HANDED]: { id: HANDED, identifier: "WOR-5", status: "todo", assigneeAgentId: null, assigneeUserId: "u-owner", createdByAgentId: BO, companyId: "co", parentId: null },
    [MINE]: { id: MINE, identifier: "WOR-6", status: "todo", assigneeAgentId: BO, createdByUserId: "u-owner", companyId: "co", parentId: null },
  });
  const plugin = [];
  let k;
  // The module's tool makes the control-plane call its arguments name, for the caller it serves.
  const todo = await moduleServer(t, { key: "todo-key", tools: ["act"], answer: async (msg, req) => {
    const { method = "POST", path, body, twice } = msg.params.arguments;
    // `twice`: the module retries the same write within its call (a lost answer): one op, written once.
    if (twice) await fetch(`${k.url}/v1/cp/agent${path}`, { method, headers: { authorization: "Bearer todo-key", "x-aidenhq-caller": req.headers["x-aidenhq-caller"], "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await fetch(`${k.url}/v1/cp/agent${path}`, { method, headers: { authorization: "Bearer todo-key", "x-aidenhq-caller": req.headers["x-aidenhq-caller"], "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { content: [{ type: "text", text: JSON.stringify({ status: r.status, json: await r.json() }) }] };
  } });
  const tool = { todo: ["act"] };
  k = await kernel(t, {
    projects,
    settings: { fleet_issues: "WOR-4" },
    agents: { ada: { id: ADA, task: OWN }, cos: { id: COS, task: OWN }, steward: { id: STW, task: OWN }, settler: { id: SET, task: OWN }, lead: { id: LEAD, task: OWN }, eve: { id: EVE, task: OWN } },
    grants: { [ADA]: { key: "ada", tools: tool, delegate_to: ["bo"] }, [BO]: { key: "bo", chat_task: CHAT }, [COS]: { key: "cos", roles: ["fleet-admin"], tools: tool }, [STW]: { key: "fleet-audit", roles: ["fleet-audit"], tools: tool }, [SET]: { key: "fleet-steward", roles: ["fleet-audit", "fleet-settle"], tools: tool }, [EVE]: { key: "eve", tools: tool }, [LEAD]: { key: "lead", tools: tool }, [REP]: { key: "rep", reports_to: "lead" }, [ENG]: { key: "eng", profile: "engineer" } },
    secrets: { todo_service_key: "todo-key", [`paperclip-agents/${ADA}`]: "key-ada", [`paperclip-agents/${COS}`]: "key-cos", [`paperclip-agents/${STW}`]: "key-stw", [`paperclip-agents/${SET}`]: "key-set", [`paperclip-agents/${LEAD}`]: "key-lead", paperclip_post_key: "post-key" },
    connections: { todo: { url: `${todo.url}/mcp`, auth_secret: "todo_service_key", module: "todo", returns: "trusted", tools: { read: [], write: ["act"], destructive: [] } } },
    onControl: async (req, body, auth) => {
      const me = KEYS[auth];
      // Ada's Paperclip record claims the role and a chief-of-staff name; only the grants table's roles count.
      if (req.url === "/api/agents/me") return me ? { body: { id: me, companyId: "co", name: me === ADA ? "chief-of-staff" : undefined, metadata: me === ADA ? { roles: ["fleet-admin"] } : undefined } } : { status: 401, body: {} };
      if (req.url === "/api/companies/co") return { body: { id: "co", defaultResponsibleUserId: "u-owner" } };
      const ref = /^\/api\/issues\/([^/?]+)$/.exec(req.url)?.[1];
      if (ref && req.method === "GET") { const i = Object.values(h.issues).find((x) => x.id === decodeURIComponent(ref) || x.identifier === decodeURIComponent(ref)); return i ? { body: i } : { status: 404, body: {} }; }
      if (req.url === "/api/plugins/aidenhq.events/actions/post") {
        const b = JSON.parse(body);
        plugin.push(b.params);
        return { body: { data: await post(h.ctx, { ...b.params, companyId: b.companyId, renderEnvironment: null }, { actor: { type: "agent", agentId: me, runId: null }, companyId: b.companyId }, "post-key") } };
      }
      if (req.method !== "GET") return { status: 500, body: { error: "a write past the plugin" } };
    },
  });
  createJobs({ db: k.records.db, cfg: {}, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: "" });
  k.records.db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, routine, routine_cap) VALUES ('job-1', 'dispatch', ?, ?, 'codex', 1, '', '', 0, '[]', 0, 0, 'running', 'digest', 'off')").run(ADA, OWN);
  const act = async (who, method, path, body, twice = false) => JSON.parse((await (await k.call("todo", who, { method: "tools/call", params: { name: "act", arguments: { method, path, body, twice } } })).json()).result.content[0].text);
  return { k, h, act, plugin };
}

test("a job writes on its own task and the tasks it created, as its agent through the plugin; another agent's task is refused", async (t) => {
  const { k, h, act, plugin } = await setup(t);
  // Its own task, by identifier: a comment (tagged: it wakes nobody) and a status, as the agent.
  let r = await act("ada", "POST", "/api/issues/WOR-1/comments", { body: "Looking into it." });
  assert.equal(r.status, 201);
  assert.equal(h.comments[0].authorAgentId, ADA);
  assert.equal(r.json.id, h.comments[0].id);
  assert.ok(SELF_TAG.test(h.comments[0].body));
  r = await act("ada", "PATCH", "/api/issues/WOR-1", { status: "blocked", blockedByIssueIds: [OTHER], comment: "Waiting on WOR-2." });
  assert.deepEqual([r.status, r.json.status, h.issues[OWN].blockedBy], [200, "blocked", [OTHER]]);
  // Another agent's task: refused before the plugin, naming whom to ask.
  const before = plugin.length;
  r = await act("ada", "POST", "/api/issues/WOR-2/comments", { body: "Do it my way." });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /WOR-2 isn't yours to change: ask its assignee \(bo\) or the chief of staff/);
  assert.equal((await act("ada", "PATCH", "/api/issues/WOR-2", { status: "cancelled" })).status, 403);
  assert.equal(plugin.length, before);
  // A child it creates, delegated (bo is in its delegate_to): created by the agent under its task, once however often the
  // module retries the write within its call, with the job's routine cap.
  const child = { title: "Check the numbers", description: "Please.", parentId: OWN, assigneeAgentId: BO, status: "todo", idempotencyKey: "check:1" };
  r = await act("ada", "POST", "/api/companies/co/issues", child, true);
  assert.deepEqual([r.status, r.json.deduplicated], [201, true]);
  const kid = h.issues[r.json.id];
  assert.equal(Object.values(h.issues).filter((i) => i.title === child.title).length, 1);
  assert.deepEqual([kid.parentId, kid.assigneeAgentId, kid.createdByAgentId, kid.originKind], [OWN, BO, ADA, ORIGIN]);
  // Never to an agent outside its delegate_to, nor to a user but the owner; a top-level task for the owner, with labels.
  r = await act("ada", "POST", "/api/companies/co/issues", { title: "Ask the chief", parentId: OWN, assigneeAgentId: COS });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /delegates to/);
  assert.equal((await act("ada", "POST", "/api/companies/co/issues", { title: "For someone", assigneeUserId: "u-other" })).status, 403);
  // Every open task has a holder: a task for nobody is refused.
  r = await act("ada", "POST", "/api/companies/co/issues", { title: "For nobody" });
  assert.deepEqual([r.status, /every open task has a holder/.test(r.json.error.message)], [400, true]);
  // One rule, in the kernel (delegateIds): with no delegate_to the chief of staff delegates to anyone in its company, a lead to its
  // direct reports and the Engineers, and the lead is refused for an agent that isn't its own.
  const give = (who, to) => act(who, "POST", "/api/companies/co/issues", { title: "Take this", assigneeAgentId: to, status: "todo" });
  for (const to of [BO, REP, ENG]) assert.equal((await give("cos", to)).status, 201);
  for (const to of [REP, ENG]) assert.equal((await give("lead", to)).status, 201);
  r = await give("lead", BO);
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /delegates to/);
  r = await act("ada", "POST", "/api/companies/co/issues", { title: "Read this", assigneeUserId: "u-owner", labelIds: [OTHER], priority: "low" });
  assert.equal(r.status, 201);
  assert.deepEqual([h.issues[r.json.id].parentId, h.issues[r.json.id].assigneeUserId, h.issues[r.json.id].labelIds], [undefined, "u-owner", [OTHER]]);
  assert.deepEqual({ ...k.records.db.prepare("SELECT created_by_job, routine, routine_cap FROM provenance WHERE task = ?").get(kid.id) }, { created_by_job: "job-1", routine: "digest", routine_cap: "off" });
  // The cap follows the task's children; a plugin-made task with no row (its answer lost) is capped off too.
  const capOf = (id) => taskRoutineCap({ issue: async (x) => h.issues[x] ?? { id: x }, provenance: k.provenance.trace }, id, { digest: "full" });
  h.issues.GRANDKID = { id: "GRANDKID", parentId: kid.id };
  assert.deepEqual(await capOf("GRANDKID"), { cap: "off", routine: "digest" });
  assert.deepEqual(k.provenance.trace({ id: "LOST", originKind: ORIGIN }), { cap: "off" });
  // A follow-up on the child it delegated: written, and tagged so it wakes the child's assignee.
  r = await act("ada", "POST", `/api/issues/${kid.identifier}/comments`, { body: "Also the totals." });
  assert.equal(r.status, 201);
  assert.ok(!SELF_TAG.test(h.comments.at(-1).body) && /<!-- aidenhq:op=/.test(h.comments.at(-1).body));
  // Done is for its own task only (the finish gate's), never a task it delegated.
  r = await act("ada", "PATCH", `/api/issues/${kid.id}`, { status: "done" });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /only this job's own task is finished here/);
  // Handing its own task back names the owner: to nobody is refused, to the owner is written.
  r = await act("ada", "PATCH", "/api/issues/WOR-1", { assigneeAgentId: null, status: "todo" });
  assert.deepEqual([r.status, /handing a task back names the owner/.test(r.json.error.message)], [400, true]);
  r = await act("ada", "PATCH", "/api/issues/WOR-1", { assigneeAgentId: null, assigneeUserId: "u-owner", status: "todo" });
  assert.equal(r.status, 200);
});

test("the chief of staff comments on any task of its company, heard by that task's agent, and nothing more", async (t) => {
  const { h, act } = await setup(t);
  let r = await act("cos", "POST", "/api/issues/WOR-2/comments", { body: "The owner asks for the summary by noon." });
  assert.equal(r.status, 201);
  assert.equal(h.comments.at(-1).authorAgentId, COS);
  assert.ok(!SELF_TAG.test(h.comments.at(-1).body), "the task's agent hears it (dispatch: the chief of staff's words start work)");
  assert.equal((await act("cos", "PATCH", "/api/issues/WOR-2", { status: "cancelled" })).status, 403);
  assert.equal((await act("cos", "PATCH", "/api/issues/WOR-2", { comment: "Also: keep it short." })).status, 200);
  // Ada isn't the chief of staff: her Paperclip metadata and name say so, her grants don't.
  assert.equal((await act("ada", "PATCH", "/api/issues/WOR-2", { comment: "Hello." })).status, 403);
  assert.equal((await act("ada", "POST", "/api/issues/WOR-2/comments", { body: "Hello." })).status, 403);
});

test("no control-plane identity, no call: a caller whose agent the kernel holds no key for is refused before anything runs", async (t) => {
  const { act, plugin } = await setup(t);
  for (const [m, p, b] of [["GET", "/api/issues/WOR-1"], ["PATCH", "/api/issues/WOR-1", { status: "done" }], ["POST", "/api/companies/co/issues", { title: "x" }]]) {
    const r = await act("eve", m, p, b);
    assert.equal(r.status, 403);
    assert.match(r.json.error.message, /no control-plane identity/);
  }
  assert.equal(plugin.length, 0);
});

test("a task's project: named by the agent, else its parent's, else that of the job's own task; a fold is the chief of staff's", async (t) => {
  const P = (n) => `90000000-0000-4000-8000-00000000000${n}`;
  const named = [];
  const projects = {
    serial: (f) => f(),
    named: async (co, name) => (named.push([co, name]), name === "Hiring" ? P(2) : P(3)),
    fold: async (co, project, into) => ({ project: into, repos: [], moved: 0, co }),
  };
  const { h, act } = await setup(t, { projects });
  h.issues[OWN].projectId = P(1);
  // A sub-task with no project takes its parent's; a top-level task the job files takes its own task's.
  let r = await act("ada", "POST", "/api/companies/co/issues", { title: "Part one", parentId: OWN, assigneeAgentId: BO, status: "todo" });
  assert.equal(h.issues[r.json.id].projectId, P(1));
  r = await act("ada", "POST", "/api/companies/co/issues", { title: "For the owner", assigneeUserId: "u-owner" });
  assert.equal(h.issues[r.json.id].projectId, P(1));
  // A named project wins, resolved by the kernel in the task's company; a change names one too.
  r = await act("ada", "POST", "/api/companies/co/issues", { title: "Screen candidates", parentId: OWN, assigneeAgentId: BO, project: "Hiring" });
  assert.equal(h.issues[r.json.id].projectId, P(2));
  r = await act("ada", "PATCH", "/api/issues/WOR-1", { project: "Infra" });
  assert.deepEqual([r.status, h.issues[OWN].projectId], [200, P(3)]);
  assert.deepEqual(named, [["co", "Hiring"], ["co", "Infra"]]);
  // Folding is the chief of staff's.
  assert.equal((await act("ada", "POST", "/api/companies/co/projects/fold", { project: "Infra", into: "Hiring" })).status, 403);
  r = await act("cos", "POST", "/api/companies/co/projects/fold", { project: "Infra", into: "Hiring" });
  assert.deepEqual([r.status, r.json.project], [200, "Hiring"]);
});

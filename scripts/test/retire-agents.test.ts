// No open task stays held by an agent that is gone: setup terminates an agent no longer configured, and every open task a
// terminated agent holds (now or from an earlier retirement) moves to backlog under its successor, with one triage task each.
import assert from "node:assert/strict";
import { test } from "node:test";
import { busyRemovedMembers, retireUnconfigured } from "../retire-agents.ts";

const companyId = "co-1";

/** A fake board over a company's agents and issues (its agent list leaves out terminated ones, as Paperclip's does). */
function fakeBoard({ agents, issues = [], failPatch = new Set() }) {
  const calls = [];
  const rows = issues.map((i) => ({ ...i }));
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const url = new URL(path, "http://board");
    if (method === "GET" && url.pathname === `/api/companies/${companyId}/agents`) return { json: agents.filter((a) => a.status !== "terminated") };
    if (method === "GET" && url.pathname === `/api/companies/${companyId}/routines`) return { json: [] };
    if (method === "GET" && /^\/api\/agents\/[^/]+$/.test(url.pathname)) return { json: agents.find((a) => a.id === url.pathname.split("/").pop()) };
    if (method === "GET" && url.pathname === `/api/companies/${companyId}/issues`) {
      const status = (url.searchParams.get("status") ?? "").split(",");
      const assignee = url.searchParams.get("assigneeAgentId");
      return { json: rows.filter((i) => status.includes(i.status) && (!assignee || i.assigneeAgentId === assignee)) };
    }
    if (method === "PATCH" && /^\/api\/issues\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop();
      if (failPatch.has(id)) throw new Error(`PATCH ${path} → 500`);
      Object.assign(rows.find((i) => i.id === id), body);
      return { json: rows.find((i) => i.id === id) };
    }
    if (method === "POST" && url.pathname === `/api/companies/${companyId}/issues`) { rows.push({ id: `new-${rows.length}`, ...body }); return { json: {} }; }
    if (method === "POST" && /^\/api\/agents\/[^/]+\/terminate$/.test(url.pathname)) { agents.find((a) => a.id === url.pathname.split("/")[3]).status = "terminated"; return { json: {} }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, calls, rows };
}

const agent = (id, key, extra = {}) => ({ id, name: key, status: "idle", metadata: { setupKey: `aidenhq:${key}`, ...extra } });
const issue = (id, status, assigneeAgentId) => ({ id, identifier: id.toUpperCase(), title: `task ${id}`, status, assigneeAgentId, assigneeUserId: null });
const cfg = { agents: { "chief-of-staff": { roles: ["fleet-admin"] }, "fleet-steward": { roles: ["fleet-audit"] } }, routines: {} };
const run = (board) => retireUnconfigured({ api: board.api, companyId, cfg, step: () => {} });
const filed = (board) => board.calls.filter((c) => c.method === "POST" && c.path === `/api/companies/${companyId}/issues`);

test("a retired agent's open tasks go to the chief of staff's backlog in one move each, with one triage task; a second run does nothing", async () => {
  const cos = agent("a-cos", "chief-of-staff"), steward = agent("a-steward", "fleet-steward");
  const old = agent("a-old", "platform-engineer"); // no longer configured: retired by this run
  const gone = { ...agent("a-gone", "fleet-ops"), status: "terminated" }; // retired by an earlier run that left its tasks
  const board = fakeBoard({ agents: [cos, steward, old, gone], issues: [issue("i1", "in_review", "a-old"), issue("i2", "blocked", "a-old"), issue("i3", "todo", "a-gone"), issue("i4", "done", "a-old"), issue("i5", "todo", "a-steward")] });
  await run(board);

  assert.ok(board.calls.some((c) => c.path === "/api/agents/a-old/terminate"));
  const patches = board.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((c) => c.path), ["/api/issues/i1", "/api/issues/i2", "/api/issues/i3"], "done tasks and live agents' tasks stay");
  for (const p of patches) assert.deepEqual(p.body, { status: "backlog", assigneeAgentId: "a-cos", assigneeUserId: null });
  assert.ok(!board.calls.some((c) => c.path.endsWith("/comments")), "no comment: on a blocked task it would wake the holder");
  const [triage, ...more] = filed(board);
  assert.equal(more.length, 0, "one triage task per successor");
  assert.equal(triage.body.assigneeAgentId, "a-cos");
  assert.equal(triage.body.status, "todo");
  for (const id of ["I1", "I2", "I3"]) assert.match(triage.body.description, new RegExp(`- ${id}: task ${id.toLowerCase()}`));

  const before = board.calls.length;
  await run(board);
  assert.ok(!board.calls.slice(before).some((c) => c.method === "PATCH" || c.method === "POST"), "nothing moves or is filed again");
});

test("the successor is the agent with the gone agent's key, else one holding its role, before the chief of staff", async () => {
  const cos = agent("a-cos", "chief-of-staff"), steward = agent("a-steward", "fleet-steward");
  const oldSteward = { ...agent("a-s0", "fleet-steward"), status: "terminated" }; // its key came back as a-steward
  const auditor = { ...agent("a-audit", "fleet-ops", { roles: ["fleet-audit"] }), status: "terminated" };
  const board = fakeBoard({ agents: [cos, steward, oldSteward, auditor], issues: [issue("i1", "todo", "a-s0"), issue("i2", "in_review", "a-audit")] });
  await run(board);

  assert.deepEqual(board.rows.filter((i) => i.id.startsWith("i")).map((i) => [i.id, i.assigneeAgentId, i.status]), [["i1", "a-steward", "backlog"], ["i2", "a-steward", "backlog"]]);
  assert.equal(filed(board).length, 1, "both land on one successor: one triage task");
});

test("a move that fails stays for the next run; a holder missing from the list but not terminated is left alone", async () => {
  const cos = agent("a-cos", "chief-of-staff");
  const gone = { ...agent("a-gone", "fleet-ops"), status: "terminated" };
  const hidden = { ...agent("a-hidden", "kai"), status: "paused" };
  const failPatch = new Set(["i1"]);
  const board = fakeBoard({ agents: [cos, gone], issues: [issue("i1", "todo", "a-gone"), issue("i2", "todo", "a-gone"), issue("i3", "todo", "a-hidden")], failPatch });
  const api = board.api;
  board.api = async (method, path, body) => (path === "/api/agents/a-hidden" ? { json: hidden } : api(method, path, body));
  await run(board);

  assert.equal(board.rows.find((i) => i.id === "i1").assigneeAgentId, "a-gone");
  assert.equal(board.rows.find((i) => i.id === "i2").assigneeAgentId, "a-cos");
  assert.equal(board.rows.find((i) => i.id === "i3").assigneeAgentId, "a-hidden", "a live agent's task never moves");
  failPatch.clear();
  await run(board);
  assert.equal(board.rows.find((i) => i.id === "i1").assigneeAgentId, "a-cos", "the next run moves it");
});

test("a team member removed while it holds open tasks is listed (setup refuses to go on); a drained one is not", async () => {
  const agents = [
    { id: "m-1", name: "Kai", status: "idle", metadata: { setupKey: "aidenhq:kai", memberOf: "engineer" } },
    { id: "m-2", name: "Mina", status: "idle", metadata: { setupKey: "aidenhq:mina", memberOf: "engineer" } },
    { id: "m-3", name: "Noor", status: "idle", metadata: { setupKey: "aidenhq:noor", memberOf: "engineer" } },
  ];
  const issues = [{ id: "i-1", identifier: "WOR-1", status: "todo", assigneeAgentId: "m-1" }, { id: "i-2", identifier: "WOR-2", status: "done", assigneeAgentId: "m-2" }];
  const { api } = fakeBoard({ agents, issues });
  assert.deepEqual(await busyRemovedMembers({ api, companyId, cfg: { agents: { noor: {} } } }), [{ name: "Kai", tasks: ["WOR-1"] }]);
});

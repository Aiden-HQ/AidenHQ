// A retired agent's open tasks must not stay assigned to a key nothing resolves: setup hands them to the one remaining agent
// in the same department, or back to the owner, before it terminates the agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { busyRemovedMembers, retireUnconfigured } from "../retire-agents.ts";

const companyId = "co-1";
const ownerId = "user-owner";

/** A fake board API over a company's agents and issues; every call is recorded in order. */
function fakeBoard({ agents, issues = [], failPatch = new Set(), failMe = false, failList = {} }) {
  const calls = [];
  const rows = issues.map((i) => ({ ...i }));
  // How many listings fail, per agent id (Infinity: never succeeds).
  const failures = new Map(Object.entries(failList));
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const url = new URL(path, "http://board");
    if (method === "GET" && url.pathname === `/api/companies/${companyId}/agents`) return { json: agents };
    if (method === "GET" && url.pathname === `/api/companies/${companyId}/routines`) return { json: [] };
    if (method === "GET" && url.pathname === "/api/cli-auth/me") {
      if (failMe) throw new Error("GET /api/cli-auth/me → 503");
      return { json: { userId: ownerId } };
    }
    if (method === "GET" && url.pathname === `/api/companies/${companyId}/issues`) {
      const assigneeForFailure = url.searchParams.get("assigneeAgentId");
      const left = failures.get(assigneeForFailure) ?? 0;
      if (left > 0) {
        failures.set(assigneeForFailure, left - 1);
        throw new Error(`GET ${path} → 503`);
      }
      const status = (url.searchParams.get("status") ?? "").split(",");
      const assignee = url.searchParams.get("assigneeAgentId");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 500);
      const matched = rows.filter((i) => status.includes(i.status) && (!assignee || i.assigneeAgentId === assignee));
      return { json: matched.slice(offset, offset + limit) };
    }
    if (method === "PATCH" && /^\/api\/issues\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop();
      if (failPatch.has(id)) throw new Error(`PATCH ${path} → 500`);
      Object.assign(rows.find((i) => i.id === id), body);
      return { json: rows.find((i) => i.id === id) };
    }
    if (method === "POST" && /^\/api\/issues\/[^/]+\/comments$/.test(url.pathname)) return { json: { id: "comment" } };
    if (method === "POST" && /^\/api\/agents\/[^/]+\/terminate$/.test(url.pathname)) return { json: {} };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, calls, rows };
}

const retired = { id: "agent-old", name: "Engineer (OpenRouter)", status: "active", metadata: { setupKey: "aidenhq:engineer-openrouter", department: { id: "engineering", name: "Engineering", order: 1 } } };
const engineer = { id: "agent-new", name: "Engineer", status: "active", metadata: { setupKey: "aidenhq:engineer", department: { id: "engineering", name: "Engineering", order: 1 } } };
const reviewer = { id: "agent-reviewer", name: "Reviewer", status: "active", metadata: { setupKey: "aidenhq:reviewer", department: { id: "engineering", name: "Engineering", order: 1 } } };
const issue = (id, status = "todo", assigneeAgentId = retired.id) => ({ id, identifier: id.toUpperCase(), status, assigneeAgentId, assigneeUserId: null });

const cfgFor = (agents) => ({ agents, routines: {} });
const department = { id: "engineering", name: "Engineering", order: 1 };

const run = (board, cfg = cfgFor({ engineer: { name: "Engineer", department } })) =>
  retireUnconfigured({ api: board.api, companyId, cfg, step: () => {} });

test("a retired agent's open tasks go to the one remaining agent in its department, each with a comment, before the terminate", async () => {
  const board = fakeBoard({ agents: [retired, engineer], issues: [issue("issue-1"), issue("issue-2", "in_progress")] });
  await run(board);

  const patches = board.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/api/issues/"));
  assert.deepEqual(patches.map((c) => c.path), ["/api/issues/issue-1", "/api/issues/issue-2"]);
  for (const p of patches) assert.deepEqual(p.body, { assigneeAgentId: engineer.id, assigneeUserId: null });
  const comments = board.calls.filter((c) => c.method === "POST" && c.path.endsWith("/comments"));
  assert.deepEqual(comments.map((c) => c.path), ["/api/issues/issue-1/comments", "/api/issues/issue-2/comments"]);
  for (const c of comments) assert.match(c.body.body, /Engineer \(OpenRouter\) was retired/);

  const terminatedAt = board.calls.findIndex((c) => c.method === "POST" && c.path === `/api/agents/${retired.id}/terminate`);
  assert.ok(terminatedAt > 0, "the agent is terminated");
  assert.ok(terminatedAt > board.calls.findIndex((c) => c.path === "/api/issues/issue-1"), "terminate comes after the moves");
});

test("with no remaining agent in the department the tasks go back to the owner, unassigned and todo", async () => {
  const board = fakeBoard({ agents: [retired], issues: [issue("issue-1")] });
  await run(board, cfgFor({ reviewer: { name: "Reviewer", department: { id: "quality", name: "Quality", order: 2 } } }));

  const patch = board.calls.find((c) => c.method === "PATCH" && c.path === "/api/issues/issue-1");
  assert.deepEqual(patch.body, { assigneeAgentId: null, assigneeUserId: ownerId, status: "todo" });
  assert.match(board.calls.find((c) => c.path === "/api/issues/issue-1/comments").body.body, /Engineer \(OpenRouter\) was retired/);
  assert.ok(board.calls.some((c) => c.path === `/api/agents/${retired.id}/terminate`));
});

test("two remaining agents in the department are no successor: the tasks go back to the owner, not to a pick", async () => {
  const board = fakeBoard({ agents: [retired, engineer, reviewer], issues: [issue("issue-1")] });
  await run(board, cfgFor({ engineer: { name: "Engineer", department }, reviewer: { name: "Reviewer", department } }));

  const patch = board.calls.find((c) => c.method === "PATCH" && c.path === "/api/issues/issue-1");
  assert.deepEqual(patch.body, { assigneeAgentId: null, assigneeUserId: ownerId, status: "todo" });
  assert.ok(board.calls.some((c) => c.path === `/api/agents/${retired.id}/terminate`));
});

test("done and cancelled tasks are never listed as open, so they are never patched", async () => {
  const board = fakeBoard({ agents: [retired, engineer], issues: [issue("issue-1"), issue("issue-done", "done"), issue("issue-cancelled", "cancelled")] });
  await run(board);

  const listing = new URL(board.calls.find((c) => c.method === "GET" && c.path.includes("/issues?")).path, "http://board");
  assert.equal(listing.searchParams.get("status"), "backlog,todo,in_progress,in_review,blocked");
  assert.equal(listing.searchParams.get("assigneeAgentId"), retired.id);
  assert.deepEqual(board.calls.filter((c) => c.method === "PATCH").map((c) => c.path), ["/api/issues/issue-1"]);
  assert.ok(!board.calls.some((c) => c.path === "/api/issues/issue-done/comments" || c.path === "/api/issues/issue-cancelled/comments"));
});

test("a retired agent without a department, or a department without an id, is handed back to the owner", async () => {
  for (const [id, metadata] of [["agent-nodep", { setupKey: "aidenhq:engineer-openrouter" }], ["agent-noid", { setupKey: "aidenhq:engineer-openrouter", department: { name: "Engineering", order: 1 } }]]) {
    const agent = { ...retired, id, metadata };
    const board = fakeBoard({ agents: [agent, engineer], issues: [issue("issue-1", "todo", id)] });
    await run(board);

    const patch = board.calls.find((c) => c.method === "PATCH" && c.path === "/api/issues/issue-1");
    assert.deepEqual(patch.body, { assigneeAgentId: null, assigneeUserId: ownerId, status: "todo" }, id);
    assert.match(board.calls.find((c) => c.path === "/api/issues/issue-1/comments").body.body, /was retired/);
    assert.ok(board.calls.some((c) => c.path === `/api/agents/${id}/terminate`), id);
  }
});

test("a failing patch on one task still moves the others and terminates the agent, naming the task it left", async () => {
  const board = fakeBoard({ agents: [retired, engineer], issues: [issue("issue-1"), issue("issue-2"), issue("issue-3")], failPatch: new Set(["issue-2"]) });
  const steps = [];
  await retireUnconfigured({ api: board.api, companyId, cfg: cfgFor({ engineer: { name: "Engineer", department } }), step: (m) => steps.push(m) });

  const patched = board.calls.filter((c) => c.method === "PATCH").map((c) => c.path);
  assert.deepEqual(patched, ["/api/issues/issue-1", "/api/issues/issue-2", "/api/issues/issue-3"]);
  assert.equal(board.rows.find((i) => i.id === "issue-1").assigneeAgentId, engineer.id);
  assert.equal(board.rows.find((i) => i.id === "issue-3").assigneeAgentId, engineer.id);
  assert.equal(board.rows.find((i) => i.id === "issue-2").assigneeAgentId, retired.id);
  assert.ok(!board.calls.some((c) => c.path === "/api/issues/issue-2/comments"), "no comment on a task that did not move");
  assert.ok(board.calls.some((c) => c.path === `/api/agents/${retired.id}/terminate`));
  assert.ok(steps.some((m) => /Left 1 open task of Engineer \(OpenRouter\) .*ISSUE-2/.test(m)), "the stranded task is named in the run's output");
});

test("an unreadable owner id still takes the tasks off the dead key, unassigned", async () => {
  const board = fakeBoard({ agents: [retired], issues: [issue("issue-1")], failMe: true });
  await run(board, cfgFor({}));

  const patch = board.calls.find((c) => c.method === "PATCH" && c.path === "/api/issues/issue-1");
  assert.deepEqual(patch.body, { assigneeAgentId: null, assigneeUserId: null, status: "todo" });
  assert.ok(board.calls.some((c) => c.path === `/api/agents/${retired.id}/terminate`));
});

test("an agent whose open tasks can't be listed is left in place, while the agents whose tasks can be listed are still retired", async () => {
  const other = { ...retired, id: "agent-other", name: "Engineer (App)", metadata: { setupKey: "aidenhq:app-engineer", department: { id: "engineering", name: "Engineering", order: 1 } } };
  const board = fakeBoard({
    agents: [retired, other, engineer],
    issues: [issue("issue-1"), issue("issue-2", "todo", other.id)],
    failList: { [retired.id]: Infinity },
  });
  await run(board);

  const terminated = board.calls.filter((c) => c.method === "POST" && c.path.endsWith("/terminate")).map((c) => c.path);
  assert.deepEqual(terminated, [`/api/agents/${other.id}/terminate`], "the stranded agent is not terminated; the other still is");
  assert.deepEqual(board.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/api/issues/")).map((c) => c.path), ["/api/issues/issue-2"]);
  assert.equal(board.calls.filter((c) => c.method === "GET" && c.path.includes(`assigneeAgentId=${retired.id}`)).length, 3, "the listing is retried");
});

test("a listing that fails once is retried, and the agent is retired normally", async () => {
  const board = fakeBoard({ agents: [retired, engineer], issues: [issue("issue-1")], failList: { [retired.id]: 1 } });
  await run(board);

  assert.equal(board.calls.filter((c) => c.method === "GET" && c.path.includes("/issues?")).length, 2);
  assert.deepEqual(board.calls.find((c) => c.method === "PATCH" && c.path === "/api/issues/issue-1").body, { assigneeAgentId: engineer.id, assigneeUserId: null });
  assert.ok(board.calls.some((c) => c.path === `/api/agents/${retired.id}/terminate`));
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

// The fast chat lane's tool calls: its module token speaks for one of its agents (identity.ts laneCaller), with that agent's
// grants on its chat task and no job, so the job-only routes (memory among them) refuse it. A job's memory_note reaches its
// own agent's memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCaller } from "../sdk/src/caller.ts";
import { kernel, moduleServer } from "./helpers.ts";

const ADA = "00000000-0000-4000-8000-00000000ada1";

test("the lane speaks for an agent with a chat; it never reaches memory, a job's memory_note does", async (t) => {
  const memory = [];
  let k;
  const cp = [];
  const docs = await moduleServer(t, { key: "docs-key", tools: ["doc_read", "memory_note", "doc_create", "doc_admin"], answer: async (msg, req) => {
    const as = { authorization: "Bearer docs-key", "x-aidenhq-caller": String(req.headers["x-aidenhq-caller"]), "content-type": "application/json" };
    if (msg.params.name === "doc_create") {
      // What tasks-mcp's task_create does: the agent's company, then the task, at /v1/cp/agent as the caller.
      for (const [method, path, body] of [["GET", "/api/agents/me"], ["POST", "/api/companies/co/issues", { title: "Remember: the acme API pages at 50 items", assigneeAgentId: ADA }]]) { const r = await fetch(`${k.url}/v1/cp/agent${path}`, { method, headers: as, ...(body ? { body: JSON.stringify(body) } : {}) }); cp.push(r.status); }
      return { content: [{ type: "text", text: "created" }] };
    }
    const r = await fetch(`${k.url}/v1/memory/note`, { method: "POST", headers: { authorization: "Bearer docs-key", "x-aidenhq-caller": String(req.headers["x-aidenhq-caller"]), "content-type": "application/json" }, body: JSON.stringify({ fact: "The acme API pages at 50 items", source: "WOR-12" }) });
    memory.push({ tool: msg.params.name, status: r.status, json: await r.json() });
    return { content: [{ type: "text", text: "done" }] };
  } });
  k = await kernel(t, {
    agents: { ada: { id: ADA, name: "Ada" } },
    onControl: (req) => (req.url === "/api/agents/me" ? { body: { id: ADA, companyId: "co" } } : req.url.endsWith("/actions/post") ? { body: { data: { child: "new-1", found: false, comment: null, status: null } } } : req.url === "/api/issues/new-1" ? { body: { id: "new-1", identifier: "WOR-1", assigneeAgentId: ADA, createdByAgentId: ADA } } : undefined),
    grants: { [ADA]: { key: "ada", roles: [], chat_task: "chat-ada", chat_tools: ["docs.doc_read", "docs.memory_note", "docs.doc_create"], tools: { docs: ["doc_read", "memory_note", "doc_create", "doc_admin"] } }, "ag-bo": { key: "bo", roles: [], tools: { docs: ["doc_read"] } } },
    secrets: { docs_service_key: "docs-key", lane_token: "lane-key", other_token: "other-key", [`paperclip-agents/${ADA}`]: "ada-pc-key", paperclip_post_key: "post-key" },
    modules: { modules: { "chat-lane": { roles: ["kernel.lane"], token: "lane_token" }, other: { roles: [], token: "other_token" }, docs: { roles: ["kernel.memory"] } } },
    connections: { docs: { url: `${docs.url}/mcp`, auth_secret: "docs_service_key", module: "docs", returns: "trusted", tools: { read: ["doc_read", "memory_note", "doc_admin"], write: ["doc_create"], destructive: [] } } },
  });
  // jobs.ts's table (the harness doesn't wire jobs): provenance reads it when a task is created.
  k.records.db.exec("CREATE TABLE IF NOT EXISTS jobs (id TEXT, agent TEXT, task TEXT, state TEXT, routine TEXT, routine_cap TEXT)");
  const call = (token, agent, name) => k.call("docs", token, { method: "tools/call", params: { name, arguments: {} } }, { headers: { "x-aidenhq-lane-agent": agent } });

  // The lane, as Ada: her grants, on her chat task.
  assert.equal((await (await call("lane-key", ADA, "doc_read")).json()).result.content[0].text, "done");
  const as = await verifyCaller({ headers: { "x-aidenhq-caller": docs.seen.at(-1).caller } }, k.jwks, "docs");
  assert.deepEqual({ agent: as.agent, key: as.key, task: as.task }, { agent: ADA, key: "ada", task: "chat-ada" });
  // Not the lane, or an agent with no chat: refused before the module.
  const seen = docs.seen.length;
  assert.equal((await call("other-key", ADA, "doc_read")).status, 401);
  assert.equal((await call("lane-key", "ag-bo", "doc_read")).status, 403);
  assert.equal(docs.seen.length, seen);
  // Only her lane tools: a tool she holds that isn't one of them is refused.
  assert.deepEqual((await (await call("lane-key", ADA, "doc_admin")).json()).error, { code: -32602, message: "no-grant" });
  // A write (the task_create handoff): filed as Ada on her chat task, and the control plane is reached with her own key.
  assert.equal((await (await call("lane-key", ADA, "doc_create")).json()).result.content[0].text, "created");
  assert.deepEqual(cp, [200, 201]);
  assert.deepEqual(k.control.filter((c) => c.method === "POST").map((c) => [c.url, c.auth]), [["/api/plugins/aidenhq.events/actions/post", "ada-pc-key"]]);
  const rec = k.records.list(["claimed", "done"], 10, { task: "chat-ada" }).find((r) => r.args.tool === "doc_create");
  assert.deepEqual([rec?.requester.agent, rec?.requester.key], [ADA, "ada"]);
  // The lane's memory_note call reaches the module, but the kernel's memory refuses it: no job.
  await call("lane-key", ADA, "memory_note");
  assert.equal(memory.at(-1).status, 401);
  // A job's doc_read can't write memory; its memory_note writes its own agent's.
  await k.call("docs", "ada", { method: "tools/call", params: { name: "doc_read", arguments: {} } });
  assert.equal(memory.at(-1).status, 403);
  await k.call("docs", "ada", { method: "tools/call", params: { name: "memory_note", arguments: {} } });
  assert.deepEqual(memory.at(-1), { tool: "memory_note", status: 200, json: { line: `- (${new Date().toISOString().slice(0, 10)}, src: WOR-12) The acme API pages at 50 items` } });
});

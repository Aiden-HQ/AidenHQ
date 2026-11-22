// The fast chat lane's tool calls: its module token speaks for one of its agents (identity.ts laneCaller), with that agent's
// grants on its chat task and no job, so the job-only routes (memory among them) refuse it. A job's memory_note reaches its
// own agent's memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCaller } from "../sdk/src/caller.ts";
import { kernel, moduleServer } from "./helpers.ts";

test("the lane speaks for an agent with a chat; it never reaches memory, a job's memory_note does", async (t) => {
  const memory = [];
  let k;
  const docs = await moduleServer(t, { key: "docs-key", tools: ["doc_read", "memory_note"], answer: async (msg, req) => {
    const r = await fetch(`${k.url}/v1/memory/note`, { method: "POST", headers: { authorization: "Bearer docs-key", "x-aidenhq-caller": String(req.headers["x-aidenhq-caller"]), "content-type": "application/json" }, body: JSON.stringify({ fact: "The acme API pages at 50 items", source: "WOR-12" }) });
    memory.push({ tool: msg.params.name, status: r.status, json: await r.json() });
    return { content: [{ type: "text", text: "done" }] };
  } });
  k = await kernel(t, {
    agents: { ada: { id: "ag-ada", name: "Ada" } },
    grants: { "ag-ada": { key: "ada", roles: [], chat_task: "chat-ada", tools: { docs: ["doc_read", "memory_note"] } }, "ag-bo": { key: "bo", roles: [], tools: { docs: ["doc_read"] } } },
    secrets: { docs_service_key: "docs-key", lane_token: "lane-key", other_token: "other-key" },
    modules: { modules: { "chat-lane": { roles: ["kernel.lane"], token: "lane_token" }, other: { roles: [], token: "other_token" }, docs: { roles: ["kernel.memory"] } } },
    connections: { docs: { url: `${docs.url}/mcp`, auth_secret: "docs_service_key", module: "docs", returns: "trusted", tools: { read: ["doc_read", "memory_note"], write: [], destructive: [] } } },
  });
  const call = (token, agent, name) => k.call("docs", token, { method: "tools/call", params: { name, arguments: {} } }, { headers: { "x-aidenhq-lane-agent": agent } });

  // The lane, as Ada: her grants, on her chat task.
  assert.equal((await (await call("lane-key", "ag-ada", "doc_read")).json()).result.content[0].text, "done");
  const as = await verifyCaller({ headers: { "x-aidenhq-caller": docs.seen.at(-1).caller } }, k.jwks, "docs");
  assert.deepEqual({ agent: as.agent, key: as.key, task: as.task }, { agent: "ag-ada", key: "ada", task: "chat-ada" });
  // Not the lane, or an agent with no chat: refused before the module.
  const seen = docs.seen.length;
  assert.equal((await call("other-key", "ag-ada", "doc_read")).status, 401);
  assert.equal((await call("lane-key", "ag-bo", "doc_read")).status, 403);
  assert.equal(docs.seen.length, seen);
  // The lane's memory_note call reaches the module, but the kernel's memory refuses it: no job.
  await call("lane-key", "ag-ada", "memory_note");
  assert.equal(memory.at(-1).status, 401);
  // A job's doc_read can't write memory; its memory_note writes its own agent's.
  await k.call("docs", "ada", { method: "tools/call", params: { name: "doc_read", arguments: {} } });
  assert.equal(memory.at(-1).status, 403);
  await k.call("docs", "ada", { method: "tools/call", params: { name: "memory_note", arguments: {} } });
  assert.deepEqual(memory.at(-1), { tool: "memory_note", status: 200, json: { line: `- (${new Date().toISOString().slice(0, 10)}, src: WOR-12) The acme API pages at 50 items` } });
});

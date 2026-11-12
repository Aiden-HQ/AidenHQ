// A delegated task that closes says so on its parent, so the delegating agent wakes: Paperclip wakes a parent's agent
// only once every child is closed. paperclip-tasks-mcp against a fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "../../services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");

async function finish(parent, tool = "task_finish", args = { comment: "Done: schema published." }, existing = []) {
  const issues = {
    cur: { id: "cur", identifier: "WOR-2", title: "Publish the schema", status: "in_progress", parentId: "par", assigneeAgentId: "me", createdByAgentId: "aiden" },
    par: { id: "par", identifier: "WOR-1", ...parent },
  };
  const comments = existing.map((body) => ({ on: "par", body }));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Roadmap Keeper" });
      if (url.startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (m && m[2] && req.method === "GET") return send(comments.filter((c) => c.on === m[1]).map((c) => ({ body: c.body })));
      if (m && m[2]) return (comments.push({ on: m[1], body: JSON.parse(body).body }), send({ id: "c1" }));
      if (m && req.method === "PATCH") return send(Object.assign(issues[m[1]], { status: JSON.parse(body).status }));
      if (m) return send(issues[m[1]] ?? {});
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "roadmap-keeper", roles: [], tools: { paperclip_tasks: ["task_finish", "task_set_status", "task_handoff"] } } } }));
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_API_KEY: "k", PAPERCLIP_TASK_ID: "cur", PAPERCLIP_COMPANY_ID: "co", AIDENHQ_GRANTS_FILE: grants },
  });
  let out = "";
  const reply = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; const line = out.split("\n").find((l) => l.includes('"id":1')); if (line) resolve(JSON.parse(line)); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  const r = await reply;
  child.kill();
  server.close();
  assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
  return comments.filter((c) => c.on === "par").map((c) => c.body);
}

test("finishing a task another agent delegated wakes that agent on the parent, once, in one line", async () =>
  assert.deepEqual(await finish({ status: "todo", assigneeAgentId: "aiden" }), ["WOR-2 (Roadmap Keeper) is done: Publish the schema. Its result is on WOR-2."]));

test("no note on the caller's own task, the user's task or a closed parent", async () => {
  assert.deepEqual(await finish({ status: "todo", assigneeAgentId: "me" }), []);
  assert.deepEqual(await finish({ status: "todo", assigneeAgentId: null, assigneeUserId: "owner" }), []);
  assert.deepEqual(await finish({ status: "done", assigneeAgentId: "aiden" }), []);
});

test("task_set_status done wakes the parent's agent too; reopening does not", async () => {
  assert.deepEqual(await finish({ status: "todo", assigneeAgentId: "aiden" }, "task_set_status", { issue: "cur", status: "done" }), ["WOR-2 (Roadmap Keeper) is done: Publish the schema. Its result is on WOR-2."]);
  assert.deepEqual(await finish({ status: "todo", assigneeAgentId: "aiden" }, "task_set_status", { issue: "cur", status: "in_progress" }), []);
});

test("task_handoff wakes the parent's agent, with the same skips", async () => {
  const handoff = (parent) => finish(parent, "task_handoff", { issue: "cur", comment: "Need your call on the schema." });
  assert.deepEqual(await handoff({ status: "todo", assigneeAgentId: "aiden" }), ["WOR-2 (Roadmap Keeper) has handed back to the user: Publish the schema. Its result is on WOR-2."]);
  assert.deepEqual(await handoff({ status: "todo", assigneeAgentId: "me" }), []);
  assert.deepEqual(await handoff({ status: "todo", assigneeAgentId: null, assigneeUserId: "owner" }), []);
  assert.deepEqual(await handoff({ status: "done", assigneeAgentId: "aiden" }), []);
});

test("the same note is never posted twice on a parent (a finish and a status change for one task)", async () => {
  const note = "WOR-2 (Roadmap Keeper) is done: Publish the schema. Its result is on WOR-2.";
  assert.deepEqual(await finish({ status: "todo", assigneeAgentId: "aiden" }, "task_finish", { comment: "Done." }, [note]), [note]);
});

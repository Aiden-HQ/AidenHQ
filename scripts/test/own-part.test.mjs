// An agent-filed task under the owner's task is the agent's to finish: done closes it, and a handoff
// goes back to the owner. Only a part the owner gave the agent stays open for the owner's replies.
// paperclip-tasks-mcp against a fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "../../services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");

async function call(tool, args, createdByAgentId, status = "in_progress") {
  const patches = [];
  const issues = {
    cur: { id: "cur", identifier: "WOR-2", title: "Follow up the review", status, parentId: "par", assigneeAgentId: "me", createdByAgentId },
    par: { id: "par", identifier: "WOR-1", title: "Ship the schema", status: "todo", assigneeUserId: "owner", assigneeAgentId: null },
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Roadmap Keeper" });
      if (url.startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (m && m[2] && req.method === "GET") return send([]);
      if (m && m[2]) return send({ id: "c1" });
      if (m && req.method === "PATCH") {
        const patch = JSON.parse(body);
        patches.push({ issue: m[1], ...patch });
        return send(Object.assign(issues[m[1]], patch));
      }
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
  return { error: r.result?.isError ? r.result.content[0].text : undefined, patches };
}

test("task_finish closes a task this agent filed under the owner's task", async () => {
  const { error, patches } = await call("task_finish", { comment: "Done: answers transcribed." }, "me");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done", comment: "Done: answers transcribed." }]);
});

test("task_set_status done closes a task this agent filed under the owner's task", async () => {
  const { error, patches } = await call("task_set_status", { issue: "cur", status: "done" }, "me");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done" }]);
});

test("a handoff of an agent-filed task gives it back to the owner instead of parking it on the agent", async () => {
  const { error, patches } = await call("task_handoff", { issue: "cur", comment: "Waiting on your call." }, "me");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", assigneeUserId: "owner", assigneeAgentId: null, status: "todo", comment: "Waiting on your call." }]);
});

test("a task this agent filed and then handed off can still be finished with done", async () => {
  const { error, patches } = await call("task_set_status", { issue: "cur", status: "done" }, "me", "todo");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done" }]);
});

test("a task another agent filed, now assigned to this agent, is this agent's to finish", async () => {
  const { error, patches } = await call("task_set_status", { issue: "cur", status: "done" }, "someone-else", "todo");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done" }]);
});

test("a part the owner gave the agent still stays open for the owner's replies", async () => {
  const { error, patches } = await call("task_finish", { comment: "Done." }, null);
  assert.match(error, /your part of the user's task/);
  assert.deepEqual(patches, []);
});

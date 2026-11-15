// The librarian's tasks-bridge tools against a fake Paperclip: handbooks read through the instructions bundle, a rule proposal
// can only be assigned to the Architect, and both need the librarian role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "../../services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");
const AGENTS = [
  { id: "me", name: "Librarian", metadata: { setupKey: "aidenhq:librarian" } },
  { id: "arch", name: "Platform Engineer", metadata: { setupKey: "aidenhq:fleet-engineer" } },
  { id: "cos", name: "Chief of Staff", metadata: { setupKey: "aidenhq:chief-of-staff" } },
];

async function call(roles, tool, args) {
  const created = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send(AGENTS[0]);
      if (/\/agents$/.test(url)) return send(AGENTS);
      if (url.includes("/instructions-bundle/file")) return send({ content: `handbook of ${url.split("/")[3]}` });
      if (req.method === "POST" && url.endsWith("/issues")) return (created.push(JSON.parse(body)), send({ identifier: "WOR-9" }));
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-1", assigneeAgentId: "me" });
      if (url.includes("/issues")) return send([]);
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "librarian", roles, tools: { paperclip_tasks: ["handbook_list", "handbook_read", "task_propose_rule"] } }, arch: { key: "fleet-engineer", roles: ["platform-engineer"] } } }));
  const child = spawn(process.execPath, [bridge], { env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_API_KEY: "k", PAPERCLIP_COMPANY_ID: "co", PAPERCLIP_TASK_ID: "cur", AIDENHQ_GRANTS_FILE: grants } });
  let out = "";
  const reply = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; const line = out.split("\n").find((l) => l.includes('"id":1')); if (line) resolve(JSON.parse(line)); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  const r = await reply;
  child.kill();
  server.close();
  const text = r.result.content[0].text;
  return { error: r.result.isError ? text : undefined, text, created };
}

test("the librarian reads a handbook and files a rule proposal for the Platform Engineer, nobody else", async () => {
  const h = await call(["librarian"], "handbook_read", { agent_key: "chief-of-staff" });
  assert.match(h.text, /handbook of cos/);
  const p = await call(["librarian"], "task_propose_rule", { title: "Fix rule", description: "current / replacement", marker: "rule:x" });
  assert.equal(p.created[0].assigneeAgentId, "arch");
  assert.equal(p.created[0].parentId, "cur");
});
test("without the librarian role both are refused", async () => {
  assert.match((await call([], "handbook_read", { agent_key: "chief-of-staff" })).error, /librarian role/);
  const p = await call([], "task_propose_rule", { title: "t", description: "d" });
  assert.match(p.error, /librarian role/);
  assert.deepEqual(p.created, []);
});

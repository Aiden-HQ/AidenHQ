// The Agent Coach's tasks-bridge tools against a fake Paperclip (and apps-mcp): delegate_to limits whom an agent may assign
// work to (keys, or an app's owner), and coach_record writes a record the board's coach_due parses, only with fleet-audit.
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
  { id: "me", name: "Agent Coach", metadata: { setupKey: "aidenhq:coach" } },
  { id: "pe", name: "Platform Engineer", metadata: { setupKey: "aidenhq:fleet-engineer" } },
  { id: "rk", name: "Roadmap Keeper", metadata: { setupKey: "aidenhq:roadmap-keeper" } },
  { id: "eng", name: "Software Engineer", metadata: { setupKey: "aidenhq:engineer" } },
];

async function call(entry, tool, args) {
  const created = [];
  const comments = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/internal/apps") return send([{ name: "roadmap", owner: "roadmap-keeper" }]);
      if (url === "/api/agents/me") return send(AGENTS[0]);
      if (/\/agents$/.test(url)) return send(AGENTS);
      if (req.method === "POST" && url.endsWith("/comments")) return (comments.push(JSON.parse(body).body), send({ id: "c" }));
      if (req.method === "POST" && url.endsWith("/issues")) return (created.push(JSON.parse(body)), send({ id: "n", identifier: "WOR-9" }));
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-1", description: "" });
      if (url.includes("/issues")) return send([]);
      if (url.includes("/labels")) return send([]);
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "coach", tools: { paperclip_tasks: ["task_create", "coach_record"] }, ...entry }, pe: { key: "fleet-engineer" }, rk: { key: "roadmap-keeper" }, eng: { key: "engineer" } } }));
  const child = spawn(process.execPath, [bridge], { env: { ...process.env, PAPERCLIP_API_URL: base, APPS_MCP_URL: base, PAPERCLIP_API_KEY: "k", PAPERCLIP_COMPANY_ID: "co", PAPERCLIP_TASK_ID: "cur", PAPERCLIP_RUN_ID: "run-1", AIDENHQ_GRANTS_FILE: grants } });
  let out = "";
  const reply = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; const line = out.split("\n").find((l) => l.includes('"id":1')); if (line) resolve(JSON.parse(line)); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  const r = await reply;
  child.kill();
  server.close();
  const text = r.result.content[0].text;
  return { error: r.result.isError ? text : undefined, created, comments };
}

const ask = (assignee) => ({ title: "Fix", description: "evidence: WOR-3", marker: `coach:x:${assignee}`, assignee });
test("delegate_to: work goes only to the listed agents and app owners; anyone else is refused before anything is filed", async () => {
  const entry = { delegate_to: ["fleet-engineer", "app-owners"] };
  assert.equal((await call(entry, "task_create", ask("fleet-engineer"))).created[0].assigneeAgentId, "pe");
  assert.equal((await call(entry, "task_create", ask("roadmap-keeper"))).created[0].assigneeAgentId, "rk"); // owns an app
  const refused = await call(entry, "task_create", ask("engineer"));
  assert.match(refused.error, /only to fleet-engineer, app-owners/);
  assert.deepEqual(refused.created, []);
  assert.equal((await call({}, "task_create", ask("engineer"))).created[0].assigneeAgentId, "eng"); // no list: no limit
  AGENTS[3].metadata.setupKey = "aidenhq:fleet-engineer"; // forged metadata: the key comes from the grants table, so still refused
  assert.match((await call(entry, "task_create", { ...ask("eng"), assignee: "Software Engineer" })).error ?? "", /isn't one of them|only to/);
  AGENTS[3].metadata.setupKey = "aidenhq:engineer";
});

test("coach_record writes a record coach_due can parse, and needs the fleet-audit role", async () => {
  const args = { agent_key: "roadmap-keeper", outcome: "reviewed", findings: 2, filed: ["WOR-7"], window_from: "2026-11-13T00:00:00Z" };
  const ok = await call({ roles: ["fleet-audit"], review_log: "log-1" }, "coach_record", args);
  assert.equal(ok.error, undefined);
  const rec = JSON.parse(/<!-- coach-review (\{.*\}) -->/.exec(ok.comments[0])[1]);
  assert.deepEqual([rec.agent_id, rec.outcome, rec.findings, rec.filed, rec.run_id], ["rk", "reviewed", 2, ["WOR-7"], "run-1"]);
  assert.match((await call({ roles: [], review_log: "log-1" }, "coach_record", args)).error, /fleet-audit role/);
});

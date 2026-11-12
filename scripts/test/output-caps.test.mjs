// task_comments, task_search and task_get cap their output (token cost); `comment` returns one comment in full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "../../services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");
const big = "x".repeat(5000);

async function call(name, args) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
    if (req.url === "/api/agents/me") return send({ id: "me", name: "UI" });
    if (req.url.includes("/comments")) return send([{ id: "c1", authorType: "user", body: big, createdAt: "t" }]);
    if (req.url.includes("/issues?")) return send([{ id: "i", identifier: "WOR-1", title: "t", status: "todo", description: big.repeat(4) }]);
    send({ id: "i", identifier: "WOR-1", title: "t", status: "todo", description: big.repeat(4) });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "ui", roles: [], tools: { paperclip_tasks: [name] } } } }));
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_API_KEY: "k", PAPERCLIP_COMPANY_ID: "co", AIDENHQ_GRANTS_FILE: grants },
  });
  let out = "";
  const reply = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; const l = out.split("\n").find((x) => x.includes('"id":1')); if (l) resolve(JSON.parse(l)); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  const r = await reply;
  child.kill();
  server.close();
  assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
  return { out: JSON.parse(r.result.content[0].text), seen };
}

test("task_comments truncates bodies and defaults to 20; `comment` returns the full text", async () => {
  const a = await call("task_comments", { issue: "WOR-1" });
  assert.match(a.seen.find((u) => u.includes("/comments")), /limit=20/);
  assert.ok(a.out.comments[0].body.length < 1700 && a.out.comments[0].body.includes("[truncated"));
  const b = await call("task_comments", { issue: "WOR-1", comment: "c1" });
  assert.equal(b.out.comments[0].body.length, 5000);
});

test("task_get caps the description and task_search returns short snippets", async () => {
  const g = await call("task_get", { issue: "WOR-1" });
  assert.ok(g.out.description.length < 8200 && g.out.description.includes("[truncated"));
  const s = await call("task_search", { query: "x" });
  assert.ok(s.out.tasks[0].snippet.length < 450 && !("description" in s.out.tasks[0]));
});

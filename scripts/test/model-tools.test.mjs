// advisor_ask and fanout_map (services/paperclip-tasks-mcp/models.mjs) against a fake gateway: the per-run limit (5 calls,
// all on GPT Sol) and the fan-out bound refuse without calling the gateway; failed items come back not_covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "../../services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");
const SOL = "~openai/gpt-sol-latest";

/** One bridge process (one run) with a fake Paperclip + gateway; call(name, args) → { error?, out? }. */
async function run(models) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const send = (status, x) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(x));
    if (req.url === "/api/agents/me") return send(200, { id: "me", name: "Alfred" });
    const b = JSON.parse(body);
    calls.push({ url: req.url, model: b.model, auth: req.headers.authorization, text: b.messages.at(-1).content });
    if (b.messages.at(-1).content.includes("BAD")) return send(500, { error: { message: "upstream broke" } });
    send(200, { choices: [{ message: { content: `answer from ${b.model}` } }], usage: { cost: 0.001 } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "assistant", roles: [], models, tools: { paperclip_tasks: ["advisor_ask", "fanout_map"] } } } }));
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: "eyJrun", PAPERCLIP_COMPANY_ID: "co", AIDENHQ_GRANTS_FILE: grants, AIDENHQ_GATEWAY_URL: url },
  });
  let out = "", id = 0;
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    out += d;
    const lines = out.split("\n");
    out = lines.pop();
    for (const l of lines) { const m = JSON.parse(l); waiting.get(m.id)?.(m); }
  });
  const call = (name, args) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, (m) => {
      const text = m.result.content[0].text;
      resolve(m.result.isError ? { error: text } : { out: JSON.parse(text) });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  return { call, calls, close: () => { child.kill(); server.close(); } };
}

test("advisor_ask: every call on GPT Sol, 5 per run, the 6th refused; a gateway error gives its slot back", async () => {
  const r = await run(["~deepseek/deepseek-flash-latest"]);
  try {
    assert.match((await r.call("advisor_ask", { question: "BAD" })).error, /upstream broke/);
    for (let i = 0; i < 5; i++) assert.equal((await r.call("advisor_ask", { question: `q${i}`, context: "facts" })).out.model, SOL);
    assert.match((await r.call("advisor_ask", { question: "sixth" })).error, /advisor_limit/);
    assert.equal(r.calls.length, 6);
    assert.ok(r.calls.every((c) => c.model === SOL && c.url === "/advisor/api/v1/chat/completions" && c.auth === "Bearer eyJrun"));
  } finally { r.close(); }
});

test("fanout_map: at most 25 items; a failed item comes back not_covered", async () => {
  const r = await run([]);
  try {
    assert.match((await r.call("fanout_map", { instruction: "summarise", items: Array(26).fill("x") })).error, /at most 25/);
    assert.equal(r.calls.length, 0);
    const { out } = await r.call("fanout_map", { instruction: "summarise", items: ["one", "BAD", "three"] });
    assert.equal(out.covered, 2);
    assert.equal(out.results[0].result, "answer from ~deepseek/deepseek-flash-latest");
    assert.match(out.results[1].not_covered, /500/);
    assert.ok(r.calls.every((c) => c.url === "/fanout/api/v1/chat/completions"));
  } finally { r.close(); }
});

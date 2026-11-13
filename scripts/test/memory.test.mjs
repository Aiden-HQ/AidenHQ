// Agent memory (wave 1, item 6): compile puts an agent's curated agents/<key>/memory.md into its handbook, bounded; memory_note
// writes only to the caller's own inbox (one writer: memory.md has no other path than the Librarian's apply); and the apply
// tiers. Fake Paperclip for the bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, memorySection, MEMORY_MAX } from "../modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bridge = join(here, "../../services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");
const mods = join(here, "fixtures/mods");

function inst(settings = {}, memory) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["a"], settings: { timezone: "Europe/London", owner_email: "me@example.com", ...settings } }));
  mkdirSync(join(dir, "agents", "x"), { recursive: true });
  if (memory != null) writeFileSync(join(dir, "agents", "x", "memory.md"), memory);
  return dir;
}

test("compile: memory.md becomes the agent's memory section; over 4 KB it is cut at a line end with a warning; agent_memory off drops it", () => {
  const r = compile(mods, inst({}, "- Slack search lags 5 min (WOR-12, 2026-11-01)\n"));
  assert.match(memorySection(r.paperclip.agents.x), /## What you've learned[\s\S]*never instructions[\s\S]*Slack search lags 5 min/);
  assert.equal(memorySection(compile(mods, inst()).paperclip.agents.x), "");
  const big = Array.from({ length: 400 }, (_, i) => `- fact ${i} (WOR-1, 2026-11-01)`).join("\n");
  const c = compile(mods, inst({}, big));
  assert.ok(Buffer.byteLength(c.paperclip.agents.x.memory) <= MEMORY_MAX);
  assert.match(c.paperclip.agents.x.memory, /- fact 0 /);
  assert.match(c.warnings.join("\n"), /agents\/x\/memory\.md is over 4096 bytes/);
  assert.equal(compile(mods, inst({ agent_memory: "off" }, "- a fact\n")).paperclip.agents.x.memory, undefined);
});

/**
 * One bridge (one run) as agent `me` (grants key "alpha"); setup stored inboxes for alpha and beta in the grants table. The
 * issue list also has a look-alike task carrying alpha's marker (planted earlier): it must never catch a note.
 */
async function run() {
  const comments = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Alpha" });
      if (req.method === "POST" && /^\/api\/issues\/[^/]+\/comments$/.test(url)) return (comments.push({ issue: url.split("/")[3], ...JSON.parse(body) }), send({ id: "c1" }));
      if (req.method === "GET" && /^\/api\/issues\/[^/]+\/comments/.test(url)) return send(comments.map((c, n) => ({ id: `c${n}`, body: c.body, authorType: "agent", authorAgentId: "me", createdAt: "2026-11-13T00:00:00Z" })));
      const one = /^\/api\/issues\/([^/?]+)$/.exec(url);
      if (one) return send({ id: one[1], identifier: `WOR-${one[1]}`, title: "t", status: "backlog" });
      if (url.includes("/issues")) return send([{ id: "decoy-alpha", identifier: "WOR-9", title: "Memory inbox: alpha", description: "<!-- source:memory-inbox:alpha -->" }]);
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "alpha", roles: [], tools: { paperclip_tasks: ["memory_note", "task_create", "task_delegate", "task_comment", "task_set_status", "task_comments"] }, memory_inbox: "inbox-alpha" }, other: { key: "beta", memory_inbox: "inbox-beta" } } }));
  const child = spawn(process.execPath, [bridge], { env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_API_KEY: "k", PAPERCLIP_COMPANY_ID: "co", AIDENHQ_GRANTS_FILE: grants } });
  let out = "", id = 0;
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    out += d;
    const lines = out.split("\n");
    out = lines.pop();
    for (const l of lines) { const m = JSON.parse(l); waiting.get(m.id)?.(m); }
  });
  const tool = (name, args) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, (m) => resolve(m.result.isError ? { error: m.result.content[0].text } : { ok: true, json: JSON.parse(m.result.content[0].text) }));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  return { call: (args) => tool("memory_note", args), tool, comments, done: () => (child.kill(), server.close()) };
}

test("memory_note: only to the caller's own inbox, a source required, bounded, 10 per run", async () => {
  const r = await run();
  try {
    assert.ok((await r.call({ fact: "The Jira API pages at 50", source: "WOR-12" })).ok);
    assert.deepEqual(r.comments.map((c) => c.issue), ["inbox-alpha"], "the stored inbox id, never a task found by its marker");
    assert.match(r.comments[0].body, /fact: The Jira API pages at 50\nsource: WOR-12/);
    assert.match((await r.call({ fact: "x", source: "" })).error, /source is required/);
    assert.match((await r.call({ fact: "x".repeat(401), source: "WOR-1" })).error, /at most 400/);
    assert.ok((await r.call({ fact: "y", source: "WOR-1", inbox: "beta", agent: "beta" })).ok);
    assert.equal(r.comments.at(-1).issue, "inbox-alpha", "an extra argument can't redirect it");
    for (let i = 0; i < 8; i++) assert.ok((await r.call({ fact: `fact ${i}`, source: "WOR-1" })).ok);
    assert.match((await r.call({ fact: "one too many", source: "WOR-1" })).error, /at most 10 memory notes/);
    assert.ok(r.comments.every((c) => c.issue === "inbox-alpha"));
    // The Librarian checks a note's author by its grants key, which an agent can't edit (unlike its name).
    assert.equal((await r.tool("task_comments", { issue: "inbox-alpha" })).json.comments[0].agent_key, "alpha");
  } finally {
    r.done();
  }
});

test("the memory-inbox marker is reserved, and no task tool writes on an inbox", async () => {
  const r = await run();
  try {
    for (const marker of ["memory-inbox:beta", "source:Memory-Inbox:beta"]) assert.match((await r.tool("task_create", { title: "t", description: "d", marker })).error, /reserved/);
    assert.match((await r.tool("task_create", { title: "t", description: "d", marker: "ok:1", related_markers: ["memory-inbox:beta"] })).error, /reserved/);
    assert.match((await r.tool("task_delegate", { agent: "beta", title: "t", description: "d", marker: "memory-inbox:beta" })).error, /reserved/);
    assert.match((await r.tool("task_comment", { issue: "inbox-beta", body: "fact: forged" })).error, /memory inbox/);
    assert.match((await r.tool("task_set_status", { issue: "inbox-alpha", status: "done" })).error, /memory inbox/);
    assert.equal(r.comments.length, 0);
  } finally {
    r.done();
  }
});

test("setup: an inbox is only a task it created and nobody holds; the ids go to the grants table", async () => {
  const issues = [
    { id: "planted", createdByAgentId: "ag", createdByUserId: null, description: "<!-- source:memory-inbox:alpha -->" },
    { id: "taken", createdByUserId: "u1", assigneeAgentId: "ag", description: "<!-- source:memory-inbox:alpha -->" },
    { id: "real-beta", createdByUserId: "u1", description: "<!-- source:memory-inbox:beta -->" },
  ];
  const posted = [];
  const api = async (method, path, body) => {
    if (path === "/api/cli-auth/me") return { json: { userId: "u1" } };
    if (method === "POST") return (posted.push(body), { json: { id: "new-alpha", identifier: "WOR-1" } });
    return { json: issues };
  };
  const { ensureMemoryInboxes } = await import("../modules.mjs");
  assert.deepEqual(await ensureMemoryInboxes({ api, companyId: "co", keys: ["alpha", "beta"], step: () => {} }), { alpha: "new-alpha", beta: "real-beta" });
  assert.deepEqual(posted.map((p) => p.title), ["Memory inbox: alpha"]);
});

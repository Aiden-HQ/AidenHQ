// Agent memory (wave 1, item 6; the memory module's prompt shows it): compile puts an agent's curated agents/<key>/memory.md into its handbook, bounded; memory_note
// writes only to the caller's own inbox (tested in modules/tasks/connections/tasks-mcp); and setup's inboxes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, MEMORY_MAX } from "../modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mods = join(here, "fixtures/mods");

function inst(settings = {}, memory) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core", "a"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", ...settings } }));
  mkdirSync(join(dir, "agents", "x"), { recursive: true });
  if (memory != null) writeFileSync(join(dir, "agents", "x", "memory.md"), memory);
  return dir;
}

test("compile: memory.md becomes the agent's memory section; over 4 KB it is cut at a line end with a warning", () => {
  const r = compile(mods, inst({}, "- Slack search lags 5 min (WOR-12, 2026-11-01)\n"));
  assert.match(r.paperclip.agents.x.memory, /Slack search lags 5 min/);
  assert.equal(compile(mods, inst()).paperclip.agents.x.memory, undefined);
  const big = Array.from({ length: 400 }, (_, i) => `- fact ${i} (WOR-1, 2026-11-01)`).join("\n");
  const c = compile(mods, inst({}, big));
  assert.ok(Buffer.byteLength(c.paperclip.agents.x.memory) <= MEMORY_MAX);
  assert.match(c.paperclip.agents.x.memory, /- fact 0 /);
  assert.match(c.warnings.join("\n"), /agents\/x\/memory\.md is over 4096 bytes/);
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

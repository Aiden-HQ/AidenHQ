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

test("setup: an inbox is only a task it created, held by its agent (one found unheld is handed to it); the ids go to the grants table", async () => {
  const issues = [
    { id: "planted", createdByAgentId: "ag", createdByUserId: null, description: "<!-- source:memory-inbox:alpha -->" },
    { id: "taken", createdByUserId: "u1", assigneeAgentId: "ag", description: "<!-- source:memory-inbox:alpha -->" },
    { id: "real-beta", identifier: "WOR-2", status: "backlog", createdByUserId: "u1", description: "<!-- source:memory-inbox:beta -->" },
  ];
  const posted = [], patched = [];
  const api = async (method, path, body) => {
    if (path === "/api/cli-auth/me") return { json: { userId: "u1" } };
    if (method === "POST") return (posted.push(body), { json: { id: "new-alpha", identifier: "WOR-1" } });
    if (method === "PATCH") return (patched.push([path, body]), { json: {} });
    return { json: issues };
  };
  const { ensureMemoryInboxes } = await import("../modules.mjs");
  assert.deepEqual(await ensureMemoryInboxes({ api, companyId: "co", keys: ["alpha", "beta"], holders: { alpha: "ag-alpha", beta: "ag-beta" }, step: () => {} }), { alpha: "new-alpha", beta: "real-beta" });
  assert.deepEqual(posted.map((p) => [p.title, p.assigneeAgentId, p.status]), [["Memory inbox: alpha", "ag-alpha", "backlog"]]);
  assert.deepEqual(patched, [["/api/issues/real-beta", { assigneeAgentId: "ag-beta", assigneeUserId: null, status: "backlog" }]]);
});

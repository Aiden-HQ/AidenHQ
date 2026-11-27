import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ensureEventsPlugin } from "../paperclip-events.ts";

test("the events plugin reinstalls when a shipped file changes, not when the tree is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "events-plugin-"));
  const pluginDir = join(dir, "plugin");
  cpSync(join(dirname(fileURLToPath(import.meta.url)), "../../services/paperclip-events"), pluginDir, { recursive: true });
  const stampFile = join(dir, "stamp");
  const calls: string[] = [];
  const api = async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    return { json: method === "GET" ? [{ id: "p1", pluginKey: "aidenhq.events", status: "ready", version: JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).version }] : {} };
  };
  const run = () => ensureEventsPlugin({ api, step: () => {}, pluginDir, stampFile });
  await run();
  assert.ok(calls.includes("POST /api/plugins/install"), "first run installs");
  calls.length = 0;
  await run();
  assert.deepEqual(calls, ["GET /api/plugins"], "an unchanged tree is left alone");
  writeFileSync(join(pluginDir, "post.js"), "// changed\n", { flag: "a" });
  await run();
  assert.ok(calls.includes("DELETE /api/plugins/p1") && calls.includes("POST /api/plugins/install"), "a changed file reinstalls");
});

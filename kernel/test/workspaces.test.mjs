// A closed task's workspace goes once it has been closed a few days and no job runs on it; an open task's stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceSweep } from "../src/workspaces.ts";

test("a task closed over three days loses its workspace; an open or recently closed one keeps it", async () => {
  const day = 86_400_000, t0 = Date.parse("2026-11-18T10:00:00Z");
  const workDir = mkdtempSync(join(tmpdir(), "ws-"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, state TEXT, at INTEGER)");
  const issues = {
    t1: { identifier: "ACME-1", status: "done", updatedAt: new Date(t0 - 4 * day).toISOString() },
    t2: { identifier: "ACME-2", status: "in_progress", updatedAt: new Date(t0 - 9 * day).toISOString() },
    t3: { identifier: "ACME-3", status: "cancelled", updatedAt: new Date(t0 - day).toISOString() },
  };
  for (const [task, i] of Object.entries(issues)) {
    mkdirSync(join(workDir, "tasks", i.identifier), { recursive: true });
    db.prepare("INSERT INTO jobs VALUES (?, ?, 'done', ?)").run(`j-${task}`, task, t0 - 10 * day);
  }
  const owner = async (_m, path) => ({ status: 200, json: issues[path.split("/").pop()] });
  let clock = t0;
  const sweep = createWorkspaceSweep({ db, owner, workDir, now: () => clock });
  await sweep();
  assert.deepEqual(["ACME-1", "ACME-2", "ACME-3"].map((d) => existsSync(join(workDir, "tasks", d))), [false, true, true]);
  // Reopened and run again, then closed again: swept again.
  mkdirSync(join(workDir, "tasks", "ACME-1"));
  db.prepare("INSERT INTO jobs VALUES ('j-t1b', 't1', 'done', ?)").run(t0);
  clock = t0 + 5 * day;
  issues.t1.updatedAt = new Date(t0 + day).toISOString();
  await sweep();
  assert.deepEqual(["ACME-1", "ACME-3"].map((d) => existsSync(join(workDir, "tasks", d))), [false, false]);
});

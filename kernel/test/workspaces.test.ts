// The disk sweep end to end (workspaces.ts): real folders, the kernel's jobs, facts and checks tables.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { checkAttempt } from "../src/checkjobs.ts";
import { createDiskSweep } from "../src/workspaces.ts";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 22);

test("closed and idle tasks' folders go, live ones and the state dir stay; pressure tightens the limits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "disk-sweep-"));
  t.after(() => { chmodSync(root, 0o755); rmSync(root, { recursive: true, force: true }); });
  const work = join(root, "work"), state = join(root, "state");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, agent TEXT, task TEXT, identifier TEXT, engine TEXT, state TEXT, at INTEGER, ended INTEGER, session TEXT);
    CREATE TABLE facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT, type TEXT, at TEXT, data TEXT);
    CREATE TABLE checks (id TEXT, at INTEGER, state TEXT);`);
  const job = (id: string, agent: string, task: string, ident: string, st: string, endedDaysAgo: number | null) =>
    db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, 'codex-openrouter', ?, ?, ?, 's-' || ?)").run(id, agent, task, ident, st, NOW - 5 * DAY, endedDaysAgo === null ? null : NOW - endedDaysAgo * DAY, id);
  const status = (task: string, to: string, daysAgo: number) => db.prepare("INSERT INTO facts (subject, type, at, data) VALUES (?, 'task.status_changed', ?, ?)").run(`task:${task}`, new Date(NOW - daysAgo * DAY).toISOString(), JSON.stringify({ to }));
  const dir = (p: string, daysOld: number) => { const d = join(p); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "f"), "x"); utimesSync(d, (NOW - daysOld * DAY) / 1000, (NOW - daysOld * DAY) / 1000); return d; };

  job("j1", "a1", "t1", "WOR-1", "done", 4); // open, idle 4 days
  job("j2", "a1", "t2", "WOR-2", "done", 2); status("t2", "done", 2); // closed 2 days ago
  job("j3", "a1", "t3", "WOR-3", "done", 2); status("t3", "in_progress", 2); // open, idle 2 days
  job("j4", "a1", "t4", "WOR-4", "running", null); // live
  db.prepare("INSERT INTO checks VALUES ('chk', ?, 'running')").run(NOW - 9 * DAY);

  const wor1 = dir(join(work, "tasks/WOR-1"), 0); // fresh mtime, but its last job ended 4 days ago
  mkdirSync(join(wor1, "go/pkg/mod/x"), { recursive: true }); writeFileSync(join(wor1, "go/pkg/mod/x/m.go"), "x"); chmodSync(join(wor1, "go/pkg/mod/x"), 0o555);
  utimesSync(wor1, (NOW - 9 * DAY) / 1000, (NOW - 9 * DAY) / 1000);
  const wor2 = dir(join(work, "tasks/WOR-2"), 2), wor3 = dir(join(work, "tasks/WOR-3"), 2), wor4 = dir(join(work, "tasks/WOR-4"), 9);
  const orphanLayer = dir(join(work, ".cache-layers/WOR-9"), 5);
  const liveCheck = dir(join(work, "checks", checkAttempt("chk", NOW - 9 * DAY)), 9), leftCheck = dir(join(work, "checks/c-0000000000000000"), 5);
  const home1 = dir(join(state, "codex-openrouter/a1_t1"), 9), home3 = dir(join(state, "codex-openrouter/a1_t3"), 2);
  const logs = dir(join(state, "logs"), 30);

  let used = 0.5;
  const sweep = createDiskSweep({ db, workDir: work, stateDir: state, engines: () => ["codex-openrouter"], now: () => NOW, used: () => used });
  const first = await sweep();
  assert.deepEqual(first, { removed: 5, pressure: false });
  for (const gone of [wor1, wor2, orphanLayer, leftCheck, home1]) assert.equal(existsSync(gone), false, gone);
  for (const kept of [wor3, wor4, liveCheck, home3, logs]) assert.equal(existsSync(kept), true, kept);
  for (const r of ["tasks", ".cache-layers", "checks", "codex-openrouter"]) assert.equal(existsSync(join(r === "codex-openrouter" ? state : work, r, ".trash")), false);
  // The removed engine home's session is not resumed.
  assert.equal((db.prepare("SELECT session FROM jobs WHERE id = 'j1'").get() as { session: string | null }).session, null);
  assert.equal((db.prepare("SELECT session FROM jobs WHERE id = 'j3'").get() as { session: string | null }).session, "s-j3");

  used = 0.85; // over PRESSURE: a day idle is enough
  assert.deepEqual(await sweep(), { removed: 2, pressure: true });
  for (const gone of [wor3, home3]) assert.equal(existsSync(gone), false, gone);
  for (const kept of [wor4, liveCheck, logs]) assert.equal(existsSync(kept), true, kept);
});

// Strict kernel facts (task state plan, A1): a transition task state depends on and its fact land together, or neither does.
// A fault is a trigger that refuses one fact type (optionally for one task), as a full disk or a broken table would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { createJobs } from "../src/jobs.ts";
import { openRecords } from "../src/records.ts";

const fault = (db, type, task) => db.exec(`CREATE TRIGGER fault BEFORE INSERT ON facts WHEN NEW.type = '${type}'${task ? ` AND NEW.task = '${task}'` : ""} BEGIN SELECT RAISE(ABORT, 'facts unwritable'); END`);
const heal = (db) => db.exec("DROP TRIGGER fault");
const count = (db, type, task) => db.prepare("SELECT COUNT(*) AS n FROM facts WHERE type = ? AND task = ?").get(type, task).n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (ok()) return;
  assert.fail(`timed out waiting for ${what}`);
}

test("a job's end rolls back when its fact can't be written", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facts-strict-"));
  const db = new DatabaseSync(":memory:");
  const facts = openFacts(db);
  const logged = [];
  const jobs = createJobs({ db, cfg: { timeout_minutes: 2, logsDir: dir }, cp: { task: async () => undefined }, mayDispatch: () => true, boxWrap: 'exec "$@"', facts, agentKey: () => "acme-crew", log: (msg) => logged.push(msg) });
  t.after(() => { jobs.detach(); rmSync(dir, { recursive: true, force: true }); });
  // A run that exited 1 while no kernel followed it: the next kernel adopts it and ends it.
  const log = join(dir, "PEN-1.log");
  writeFileSync(log, "boom\n");
  writeFileSync(`${log}.exit`, "1\n");
  db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state) VALUES ('j-1', 'acme-dispatch', 'agent-1', 'task-1', 'echo', 999999, ?, ?, ?, '[]', 0, 0, 'running')").run(log, join(dir, "job"), Date.now());
  fault(db, "job.ended");
  jobs.adopt();
  const state = () => db.prepare("SELECT state FROM jobs WHERE id = 'j-1'").get().state;
  assert.equal(state(), "running", "the end isn't recorded without its fact");
  assert.ok(logged.some((m) => /job end not recorded/.test(m)), "the failure is logged");
  heal(db);
  await until("the next tick to end it", () => state() !== "running");
  assert.equal(state(), "failed");
  assert.equal(count(db, "job.ended", "task-1"), 1);
});

test("a card closed by the code (cancelled, stale, unknown) leaves its closing fact, or stays as it was", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facts-strict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const records = openRecords(join(dir, "kernel.db"));
  const card = { sentence: "s", changes: "c", reads: "r", cost: "0", details: "d" };
  const file = (n, state) => records.file({ kind: "kernel.apply", module: "kernel", args: { n }, targets: {}, executor: { module: "kernel" }, policy: "p", tier: 1, card, requester: { agent: "", key: "k", name: "n", roles: [], kind: "kernel" }, task: `t-${n}`, state });
  const closing = (id) => records.db.prepare("SELECT data FROM facts WHERE type = 'record.decided' AND subject = ?").all(`record:${id}`).map((f) => JSON.parse(f.data));
  const open = file(1, "review"), claimed = file(2, "claimed"), lost = file(3, "claimed");
  assert.equal(records.close(open.id, "cancelled", "module removed"), true);
  assert.equal(records.close(claimed.id, "stale", "stale"), true);
  assert.equal(records.close(lost.id, "unknown", "unknown"), true);
  assert.deepEqual([open, claimed, lost].map((r) => closing(r.id)), [
    [{ decision: "cancelled", decider: "code", via: "closed" }],
    [{ decision: "stale", decider: "code", via: "closed" }],
    [{ decision: "unknown", decider: "code", via: "closed" }],
  ]);
  const later = file(4, "review");
  fault(records.db, "record.decided");
  assert.throws(() => records.close(later.id, "cancelled", "module removed"), /facts unwritable/);
  assert.equal(records.get(later.id).state, "review");
});

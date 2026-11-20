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
import { createWakes } from "../src/wakes.ts";
import { createIdle } from "../src/idle.ts";
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

test("a wait isn't recorded when its fact can't be written", async () => {
  const db = new DatabaseSync(":memory:");
  const facts = openFacts(db);
  const owner = async () => ({ status: 404, json: {} });
  const wakes = createWakes({ db, facts, owner, post: async () => ({}), dispatches: { may: () => false, agents: () => [] } });
  const idle = createIdle({ db, facts, flow: { idleNow: () => ({ items: [] }) }, wakes, owner });
  fault(db, "work.waiting");
  await assert.rejects(idle.wait({ agent: "a-1", key: "eng", task: "t1" }, { reason: "PR #12 merges", on: "PR merges" }), /facts unwritable/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE key LIKE 'wait:t1:%'").get().n, 0);
  heal(db);
  assert.equal((await idle.wait({ agent: "a-1", key: "eng", task: "t1" }, { reason: "PR #12 merges", on: "PR merges" })).waiting, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE key LIKE 'wait:t1:%'").get().n, 1);
});

test("a record move fails with its fact", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facts-strict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const records = openRecords(join(dir, "kernel.db"));
  const card = { sentence: "s", changes: "c", reads: "r", cost: "0", details: "d" };
  const r = records.file({ kind: "kernel.apply", module: "kernel", args: {}, targets: {}, executor: { module: "kernel" }, policy: "p", tier: 2, panel: false, card, requester: { agent: "", key: "k", name: "n", roles: [], kind: "kernel" }, task: "t-1", state: "owner" });
  fault(records.db, "record.decided");
  assert.throws(() => records.decide(r.id, r.digest, "approve", "account:a-1", "board"), /facts unwritable/);
  assert.equal(records.db.prepare("SELECT state FROM records WHERE id = ?").get(r.id).state, "owner");
  heal(records.db);
  assert.equal(records.decide(r.id, r.digest, "approve", "account:a-1", "board").state, "approved");
});

test("one task's fact failure fails its scan, not the poll", async () => {
  let clock = Date.parse("2026-11-20T10:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const issues = {};
  const issue = (id, f) => (issues[id] = { id, status: "in_progress", assigneeAgentId: "a-1", updatedAt: iso(clock), statusVersion: 1, ...issues[id], ...f });
  const owner = async (method, path) => {
    const u = new URL(path, "http://cp");
    let m;
    if (/^\/api\/agents\//.test(u.pathname)) return { status: 200, json: { companyId: "c-1" } };
    if (u.pathname === "/api/companies/c-1/issues") return { status: 200, json: Object.values(issues).filter((i) => u.searchParams.get("status").split(",").includes(i.status)) };
    if (/\/comments$/.test(u.pathname)) return { status: 200, json: [] };
    if ((m = /^\/api\/issues\/([^/]+)$/.exec(u.pathname))) return { status: 200, json: issues[m[1]] };
    return { status: 404, json: {} };
  };
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER)");
  const facts = openFacts(db);
  const wakes = createWakes({ db, facts, owner, post: async () => ({}), now: () => clock, dispatches: { may: (mod, a) => mod === "dispatch" && a === "a-1", agents: () => ["a-1"] } });
  wakes.claim("dispatch");
  issue("tA", {});
  issue("tB", {});
  clock += 1000;
  await wakes.poll();
  clock += 1000;
  issue("tA", { status: "todo", statusVersion: 2, updatedAt: iso(clock) });
  issue("tB", { status: "todo", statusVersion: 2, updatedAt: iso(clock) });
  const cursor = (task) => db.prepare("SELECT status FROM task_facts_seen WHERE task = ?").get(task).status;
  fault(db, "task.status_changed", "tA");
  await wakes.poll();
  assert.equal(count(db, "task.status_changed", "tB"), 2, "B's move is recorded");
  assert.ok(db.prepare("SELECT 1 FROM wakes WHERE task = 'tB' AND key LIKE 'issue:tB:%'").get(), "and B is woken");
  assert.equal(cursor("tA"), "in_progress", "A's cursor stays where its facts are");
  heal(db);
  await wakes.poll();
  assert.equal(count(db, "task.status_changed", "tA"), 2, "the next poll records A's move");
  assert.equal(cursor("tA"), "todo");
});

test("an expired card and a superseded card each leave a closing fact", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facts-strict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-20T10:00:00Z");
  const records = openRecords(join(dir, "kernel.db"), () => new Date(clock));
  const card = { sentence: "s", changes: "c", reads: "r", cost: "0", details: "d" };
  const file = (task, args, target) => records.file({ kind: "kernel.apply", module: "kernel", args, targets: {}, executor: { module: "kernel" }, policy: "p", tier: 2, panel: false, card, requester: { agent: "", key: "k", name: "n", roles: [], kind: "kernel" }, task, state: "owner", ...(target ? { target } : {}) });
  const closing = (id) => records.db.prepare("SELECT actor, data FROM facts WHERE type = 'record.decided' AND subject = ?").all(`record:${id}`).map((f) => ({ actor: f.actor, ...JSON.parse(f.data) }));
  // Superseded: a changed request on the same task, kind and target.
  const first = file("t-1", { n: 1 }, "main");
  file("t-1", { n: 2 }, "main");
  assert.equal(records.get(first.id).state, "cancelled");
  assert.deepEqual(closing(first.id), [{ actor: "kernel", decision: "cancelled", decider: "code", via: "replaced" }]);
  // Expired: still open after its 7 days.
  const old = file("t-2", { n: 3 });
  clock += 8 * 864e5;
  records.list(["cancelled"]);
  assert.equal(records.get(old.id).state, "cancelled");
  assert.deepEqual(closing(old.id), [{ actor: "kernel", decision: "cancelled", decider: "code", via: "expired" }]);
  // Strict: a closing fact that can't be written leaves the card as it was.
  const later = file("t-3", { n: 4 });
  clock += 8 * 864e5;
  fault(records.db, "record.decided");
  assert.throws(() => records.list(["cancelled"]), /facts unwritable/);
  assert.equal(records.get(later.id).state, "owner");
});

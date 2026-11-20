// GET /v1/tasks/state (task-state-read.ts): a batch of task states in one snapshot, with the fleet's counts.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";
import { createTaskStateRead } from "../src/task-state-read.ts";
import { createBackplane } from "../src/backplane.ts";

const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const MIN = 60_000;
const iso = (m) => new Date(T0 + m * MIN).toISOString();

/** A kernel db file (WAL, as records.ts opens it) with its facts, and a reader at minute `now`. */
function setup(t, now = 30) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const facts = openFacts(db);
  let n = 0;
  const add = (type, task, m, data = {}, o = {}) => facts.record({ type, subject: `task:${task}`, version: String(++n), at: iso(m), actor: "kernel", task, data, ...o });
  const task = (id, ident, status = "todo") => { add("task.created", id, 0, { parent: null, identifier: ident }); add("task.status_changed", id, 0, { from: null, to: status }); };
  return { db, facts, add, task, reader: createTaskStateRead({ file, stages: () => KERNEL_STAGES, now: () => T0 + now * MIN }) };
}

test("open lists every open task once, closed ones not", (t) => {
  const { add, task, reader } = setup(t);
  task("t1", "WOR-1");
  task("t2", "WOR-2");
  add("task.status_changed", "t2", 5, { from: "todo", to: "done" });
  task("t3", "WOR-3");
  add("task.status_changed", "t3", 5, { from: "todo", to: "done" });
  add("task.status_changed", "t3", 6, { from: "done", to: "todo" });
  const r = reader.read({ open: true });
  assert.deepEqual(r.tasks.map((x) => x.identifier).sort(), ["WOR-1", "WOR-3"]);
  assert.equal(r.as_of, iso(30));
});

test("ids accepts identifiers and returns closures", (t) => {
  const { add, task, reader } = setup(t);
  task("t1", "WOR-1");
  add("task.status_changed", "t1", 5, { from: "todo", to: "done" });
  task("t2", "WOR-2");
  const r = reader.read({ ids: ["WOR-1", "t2", "nope"] });
  assert.deepEqual(r.tasks.map((x) => [x.task, x.kind]).sort(), [["t1", "done"], ["t2", "idle"]]);
});

test("a blocker's closure is read with the task it blocks", (t) => {
  const { add, task, reader } = setup(t);
  task("t1", "WOR-1");
  task("t2", "WOR-2");
  add("task.blocked_changed", "t1", 1, { blocked_by: ["t2"] });
  assert.equal(reader.read({ ids: ["t1"] }).tasks[0].reason, "blocked");
  add("task.status_changed", "t2", 2, { from: "todo", to: "done" });
  assert.notEqual(reader.read({ ids: ["t1"] }).tasks[0].reason, "blocked");
});

test("counts match the rows, attention oldest first", (t) => {
  const { add, task, reader } = setup(t);
  task("t1", "WOR-1");
  add("record.filed", "t1", 10, { kind: "push", tier: 2, state: "owner" }, { subject: "record:k1" });
  task("t2", "WOR-2");
  add("job.ended", "t2", 5, { state: "failed" }, { subject: "job:j1" });
  add("wake.opened", "t2", 1, { cause: "idle" }, { subject: "wake:w1" });
  add("job.queued", "t2", 2, {}, { subject: "job:j1" });
  task("t3", "WOR-3");
  add("task.assignee_changed", "t3", 0, { from: null, to: "kai" });
  task("t4", "WOR-4");
  add("job.started", "t4", 29, {}, { subject: "job:j4" });
  const r = reader.read({ open: true });
  assert.deepEqual(r.counts, { needs_you: 1, failed: 1, unexplained_idle: 1 });
  assert.deepEqual(r.tasks.map((x) => x.identifier), ["WOR-3", "WOR-2", "WOR-1", "WOR-4"]);
  assert.equal(r.tasks.find((x) => x.task === "t2").idle_wakes, 1);
});

test("one snapshot", (t) => {
  const { facts, task, reader } = setup(t);
  task("t1", "WOR-1");
  // A job starts on t1 while the read is between its queries: the read never sees it.
  const all = StatementSync.prototype.all;
  let calls = 0;
  StatementSync.prototype.all = function (...args) {
    if (++calls === 2) facts.record({ type: "job.started", subject: "job:j1", version: "started", at: iso(20), actor: "agent:kai", task: "t1", data: {} });
    return all.apply(this, args);
  };
  try {
    assert.equal(reader.read({ open: true }).tasks[0].kind, "idle");
  } finally { StatementSync.prototype.all = all; }
  assert.equal(reader.read({ open: true }).tasks[0].kind, "working");
});

test("GET /v1/tasks/state: the board's key or a module with kernel.flow-read", async (t) => {
  const { task, reader } = setup(t);
  task("t1", "WOR-1");
  const whoami = async (token) => (token === "none" ? Promise.reject(new Error("no")) : { kind: "module", module: "tasks", roles: token === "reader" ? ["kernel.flow-read"] : ["kernel.tasks"], tools: [] });
  const handle = createBackplane({ whoami, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), taskStates: reader, boardKey: () => "board-key" });
  const server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const get = (p, token) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get("/v1/tasks/state?open=1", "none")).status, 401);
  assert.equal((await get("/v1/tasks/state?open=1", "other")).status, 403);
  assert.equal((await (await get("/v1/tasks/state?ids=WOR-1", "reader")).json()).tasks[0].task, "t1");
  assert.equal((await (await get("/v1/tasks/state?open=1", "board-key")).json()).tasks.length, 1);
  assert.equal((await get("/v1/tasks/state", "board-key")).status, 400);
  assert.equal((await get(`/v1/tasks/state?ids=${Array.from({ length: 201 }, (_, i) => `t${i}`).join(",")}`, "board-key")).status, 400);
});

// GET /v1/tasks/state (task-state-read.ts): a batch of task states in one snapshot, with the fleet's counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";
import { createTaskStateRead } from "../src/task-state-read.ts";

const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const MIN = 60_000;
const iso = (m) => new Date(T0 + m * MIN).toISOString();

/** A kernel db file (WAL, as records.ts opens it) with its facts, and a reader at minute `now`. */
function setup(t, now = 30, agent?, polled?) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const facts = openFacts(db);
  let n = 0;
  const add = (type, task, m, data = {}, o = {}) => facts.record({ type, subject: `task:${task}`, version: String(++n), at: iso(m), actor: "kernel", task, data, ...o });
  const task = (id, ident, status = "todo") => { add("task.created", id, 0, { parent: null, identifier: ident }); add("task.status_changed", id, 0, { from: null, to: status }); };
  return { db, facts, add, task, reader: createTaskStateRead({ file, stages: () => KERNEL_STAGES, agent, polled, now: () => T0 + now * MIN }) };
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

test("open with closed_since adds the tasks closed since then, by their close fact", (t) => {
  const { add, task, reader } = setup(t);
  task("t1", "WOR-1");
  task("t2", "WOR-2");
  add("task.status_changed", "t2", 5, { from: "todo", to: "done" });
  task("t3", "WOR-3");
  add("task.status_changed", "t3", 20, { from: "todo", to: "cancelled" });
  const r = reader.read({ open: true, closed_since: iso(10) });
  assert.deepEqual(r.tasks.map((x) => [x.identifier, x.lane]).sort(), [["WOR-1", "blocked"], ["WOR-3", "done"]]);
});

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
test("a row carries the task's own origin from its created fact", (t) => {
  const w = setup(t);
  w.add("task.created", "t1", 0, { parent: null, identifier: "WOR-1", origin: "routine_execution" });
  w.add("task.created", "t2", 0, { parent: null, identifier: "WOR-2", origin: "module:primer" });
  w.add("task.created", "t3", 0, { parent: null, identifier: "WOR-3" });
  const rows = w.reader.read({ ids: ["t1", "t2", "t3"] }).tasks;
  const by = (id) => rows.find((r) => r.task === id);
  assert.deepEqual([by("t1").origin, by("t2").origin, by("t3").origin], ["routine_execution", "module:primer", null]);
});

test("a holder Paperclip reports terminated is named and marked gone; a failed agent read leaves the rows as they are", async (t) => {
  const calls = [];
  const agent = async (id) => { calls.push(id); return { [A1]: { name: "Platform Engineer", terminated: true }, [A2]: { name: "Kai", terminated: false } }[id]; };
  const w = setup(t, 30, agent);
  w.task("t1", "WOR-1");
  w.add("task.assignee_changed", "t1", 1, { from: null, to: A1 });
  w.task("t2", "WOR-2");
  w.add("task.assignee_changed", "t2", 1, { from: null, to: A2 });
  w.task("t3", "WOR-3");
  w.add("task.assignee_changed", "t3", 1, { from: null, to: "app-maintainer" });
  const rows = (await w.reader.named(w.reader.read({ ids: ["t1", "t2", "t3"] }))).tasks;
  const by = (id) => rows.find((r) => r.task === id);
  assert.deepEqual([by("t1").holder_name, by("t1").holder_gone, by("t2").holder_name], ["Platform Engineer", true, undefined]);
  await w.reader.named(w.reader.read({ ids: ["t1", "t2", "t3"] }));
  assert.deepEqual(calls, [A1, A2]); // a key is never fetched; the rest are cached for the next read
  const bad = setup(t, 30, async () => { throw new Error("down"); });
  bad.task("t1", "WOR-1");
  bad.add("task.assignee_changed", "t1", 1, { from: null, to: A1 });
  assert.equal((await bad.reader.named(bad.reader.read({ ids: ["t1"] }))).tasks[0].holder_name, undefined);
});

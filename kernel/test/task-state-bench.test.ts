// The batch read's budget (task-state-read.ts): GET /v1/tasks/state?open=1 over 100 open tasks with realistic histories and a
// large closed backlog answers within its 150 ms budget (median of 20 reads, the board polls it). Only a generous ceiling is asserted, so a slow runner never fails it and an order-of-magnitude regression does; the median is printed.
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
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

test("batch read of 100 open tasks × 200 facts beside 50,000 closed-task facts: median printed, ceiling 1000 ms", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-state-bench-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const facts = openFacts(db);
  let n = 0;
  const add = (type: string, subject: string, task: string, s: number, actor: string, data: Record<string, unknown> = {}) =>
    facts.record({ type, subject, version: String(++n), at: iso(s), actor, task, data });
  // A task's history: its creation and status, then repeated work (a job, a wake, a comment, a card, a module stage) up to `size` facts.
  const history = (id: string, size: number, closed: boolean) => {
    add("task.created", `task:${id}`, id, 0, "kernel", { parent: null, identifier: `WOR-${id.slice(1)}` });
    add("task.status_changed", `task:${id}`, id, 0, "kernel", { from: null, to: "todo" });
    for (let i = 0, k = 2; k < size - (closed ? 1 : 0); i++) {
      const s = 10 + i * 60, job = `job:${id}-${i}`, rec = `record:${id}-${i}`;
      const batch: [string, string, string, Record<string, unknown>][] = [
        ["wake.opened", `wake:${id}-${i}`, "account:u1", { cause: "comment" }], ["job.queued", job, "agent:kai", {}], ["job.started", job, "agent:kai", {}],
        ["task.commented", `task:${id}`, "account:u1", { kind: "comment" }], ["record.filed", rec, "agent:kai", { kind: "push", tier: 2, state: "owner" }],
        ["record.decided", rec, "account:u1", { decision: "approved", decider: "owner" }], ["pr.checks_started", `pr:acme/x#${id}-${i}`, "module:github", {}],
        ["pr.checks_completed", `pr:acme/x#${id}-${i}`, "module:github", {}], ["job.ended", job, "agent:kai", { state: "done" }],
      ];
      for (const [type, subject, actor, data] of batch) { if (k++ >= size - (closed ? 1 : 0)) break; add(type, subject, id, s + k, actor, data); }
    }
    if (closed) add("task.status_changed", `task:${id}`, id, 1e6, "kernel", { from: "todo", to: "done" });
  };
  db.exec("BEGIN");
  for (let i = 0; i < 100; i++) history(`o${i}`, 200, false);
  for (let i = 0; i < 500; i++) history(`c${i}`, 100, true);
  db.exec("COMMIT");
  assert.equal(n, 100 * 200 + 500 * 100, "seeded");

  const reader = createTaskStateRead({ file, stages: () => KERNEL_STAGES, now: () => T0 + 2e6 * 1000 });
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const r = reader.read({ open: true });
    JSON.stringify(r); // the route's serialisation
    ms.push(performance.now() - t0);
    assert.equal(r.tasks.length, 100);
  }
  ms.sort((a, b) => a - b);
  const median = ms[10]!;
  console.log(`batch read median ${median.toFixed(1)} ms (min ${ms[0]!.toFixed(1)}, max ${ms[19]!.toFixed(1)})`);
  assert.ok(median < 1000, `median ${median.toFixed(1)} ms`);
});

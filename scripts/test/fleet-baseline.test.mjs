import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { baseline } from "../fleet-baseline.mjs";

test("baseline() over fixture DBs counts per agent", async () => {
  const kernel = new DatabaseSync(":memory:");
  kernel.exec(`CREATE TABLE calls (run_key TEXT, day TEXT, agent_id TEXT, cost_usd REAL, status TEXT, issue_id TEXT);
    CREATE TABLE records (id TEXT, kind TEXT, state TEXT, decided_by TEXT, tier INTEGER, requester TEXT, created_at TEXT);`);
  const now = new Date("2026-11-18T12:00:00Z");
  for (const run of ["r1", "r2", "r2"]) kernel.prepare("INSERT INTO calls VALUES (?, '2026-11-17', 'id-a1', 0.5, 'ok', 'i1')").run(run);
  kernel.prepare("INSERT INTO calls VALUES ('old', '2026-10-01', 'id-a1', 9, 'ok', 'i0')").run();
  const rec = (id, state, by) => kernel.prepare("INSERT INTO records VALUES (?, 'runner.pr', ?, ?, 1, ?, '2026-11-17T00:00:00Z')").run(id, state, by, JSON.stringify({ agent: "id-a1", key: "a1" }));
  rec("x1", "rejected", "reviewer:r");
  rec("x2", "done", null);
  const grades = new DatabaseSync(":memory:");
  grades.exec("CREATE TABLE grades (issue_id TEXT, state TEXT, failures INTEGER, attempts INTEGER)");
  grades.prepare("INSERT INTO grades VALUES ('i1', 'escalated', 0, 1)").run();
  const issue = (id, status) => ({ id, status, assigneeAgentId: "id-a1", completedAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z" });
  const paperclip = {
    agents: async () => [{ id: "id-a1", name: "A1", metadata: { setupKey: "a1" } }],
    closed: async () => [issue("i1", "done"), issue("i2", "done"), issue("i3", "cancelled")],
  };
  const out = await baseline({ days: 14, now }, { kernelDb: kernel, gradesDb: grades, paperclip });
  assert.deepEqual(out.agents.a1, {
    runs: 2, costUsd: 1.5, tasksDone: 2, tasksCancelled: 1, costPerDone: 0.75,
    records: { filed: 2, rejected: 1, failed: 0, ownerDecided: 0 },
    grades: { satisfied: 0, escalated: 1, failed: 0 }, reopened: 1,
  });
});

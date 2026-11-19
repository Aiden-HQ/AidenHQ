// Flow's fact log (facts.ts): one fact per type, subject and version, and the 400-day prune.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";

const fact = (over = {}) => ({ type: "job.started", subject: "job:j-1", version: "running", at: "2026-11-19T10:02:32.000Z", actor: "agent:engineer", task: "t1", ...over });

test("record dedupes on type, subject and version", () => {
  const facts = openFacts(new DatabaseSync(":memory:"));
  assert.equal(facts.record(fact()), true);
  assert.equal(facts.record(fact({ at: "2026-11-19T10:05:00.000Z" })), false);
  assert.equal(facts.record(fact({ version: "done", type: "job.ended" })), true);
  const rows = facts.forTask("t1");
  assert.deepEqual(rows.map((r) => r.type), ["job.started", "job.ended"]);
  assert.equal(rows[0].id, "job.started:job:j-1:running");
  assert.deepEqual(facts.since(rows[0].seq).map((r) => r.type), ["job.ended"]);
});

test("prune keeps 400 days", () => {
  const now = new Date("2026-11-19T00:00:00.000Z");
  const facts = openFacts(new DatabaseSync(":memory:"), () => now);
  const ago = (d) => new Date(now.getTime() - d * 864e5).toISOString();
  facts.record(fact({ version: "old", at: ago(401) }));
  facts.record(fact({ version: "kept", at: ago(399) }));
  assert.equal(facts.prune(), 1);
  assert.deepEqual(facts.forTask("t1").map((r) => r.version), ["kept"]);
});

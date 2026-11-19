// Flow's fact log (facts.ts): one fact per type, subject and version, and the 400-day prune.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillLocal, openFacts } from "../src/facts.ts";
import { openRecords } from "../src/records.ts";

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

const filing = (over = {}) => ({ kind: "twin.post_note", module: "twin", args: { n: 1 }, targets: {}, executor: { module: "twin" }, policy: "p", tier: 1, panel: false,
  card: { sentence: "s", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "t1", state: "review", ...over });

test("backfillLocal twice records once, and never repeats a live fact", () => {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "flow-")), "kernel.db"));
  const facts = openFacts(records.db);
  const r = records.file(filing());
  records.review(r.id, r.digest, { decision: "reject", by: "reviewer:m", note: "no" });
  const other = records.file(filing({ task: "t2" }));
  records.db.prepare("DELETE FROM facts WHERE subject = ?").run(`record:${other.id}`);
  // The columns it reads of jobs and wakes (jobs.ts, wakes.ts).
  records.db.exec("CREATE TABLE jobs (id TEXT, agent TEXT, task TEXT, state TEXT, exit INTEGER, why TEXT, at INTEGER, ended INTEGER); CREATE TABLE wakes (key TEXT, task TEXT, cause TEXT, at INTEGER)");
  const t0 = Date.parse("2026-11-18T10:00:00.000Z");
  records.db.prepare("INSERT INTO jobs VALUES ('j-1', 'ag-ada', 't1', 'done', 0, '{}', ?, ?), ('j-2', 'ag-ada', 't1', 'admitted', NULL, '{}', ?, NULL)").run(t0, t0 + 60_000, t0);
  records.db.prepare("INSERT INTO wakes VALUES ('assigned:t1', 't1', 'assigned', ?)").run(t0 - 5_000);
  assert.equal(backfillLocal(records.db, facts, { agentKey: (id) => (id === "ag-ada" ? "ada" : undefined) }), 4, "the lost record, j-1 started and ended, the wake");
  assert.equal(backfillLocal(records.db, facts), 0);
  const ended = facts.forTask("t1").find((f) => f.type === "job.ended");
  assert.deepEqual([ended.subject, ended.actor, ended.at, ended.source, ended.data.state], ["job:j-1", "agent:ada", "2026-11-18T10:01:00.000Z", "backfill", "done"]);
});

test("opening the log normalises times to UTC and PR names to lowercase, merging what that makes one fact, and is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  const facts = openFacts(db);
  // The backfill's and the live writer's spelling of one PR's merge: the earlier stays.
  facts.record(fact({ type: "pr.merged", subject: "pr:Acme/App#7", version: "github/abc", at: "2026-11-19T10:00:05Z", data: { pr: "Acme/App#7", sha: "abc" } }));
  facts.record(fact({ type: "pr.merged", subject: "pr:acme/app#7", version: "github/abc", at: "2026-11-19T10:00:09Z", data: { pr: "acme/app#7" } }));
  facts.record(fact({ type: "pr.opened", subject: "pr:Acme/App#8", version: "github/def", at: "2026-11-19T14:00:00+04:00", data: { repo: "Acme/App", head: "Def" } }));
  facts.record(fact({ type: "issue.opened", subject: "issue:Acme/App#3", version: "github/1", data: {} }));
  const again = openFacts(db);
  const rows = db.prepare("SELECT id, subject, at, data FROM facts WHERE type != 'job.started' ORDER BY seq").all().map((r) => ({ ...r, data: JSON.parse(r.data) }));
  assert.deepEqual(rows.map((r) => r.id), ["pr.merged:pr:acme/app#7:github/abc", "pr.opened:pr:acme/app#8:github/def", "issue.opened:issue:acme/app#3:github/1"]);
  assert.deepEqual([rows[0].at, rows[0].data], ["2026-11-19T10:00:05Z", { pr: "acme/app#7", sha: "abc" }], "the earliest row stays");
  assert.deepEqual([rows[1].at, rows[1].data], ["2026-11-19T10:00:00.000Z", { repo: "acme/app", head: "Def" }], "UTC; only pr and repo are lowercased");
  assert.equal(db.prepare("SELECT count(*) AS n FROM facts").get().n, 3);
  openFacts(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM facts").get().n, 3);
  assert.ok(again);
});

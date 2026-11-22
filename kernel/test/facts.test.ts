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

const filing = (over = {}) => ({ kind: "twin.post_note", module: "twin", args: { n: 1 }, targets: {}, executor: { module: "twin" }, policy: "p", tier: 1,
  card: { sentence: "s", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "run" }, task: "t1", state: "review", ...over });

test("backfillLocal twice records once, and never repeats a live fact", () => {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "flow-")), "kernel.db"));
  const facts = openFacts(records.db);
  const r = records.file(filing());
  records.review(r.id, r.digest, { decision: "reject", by: "reviewer:m", note: "no" });
  const other = records.file(filing({ task: "t2" }));
  records.db.prepare("DELETE FROM facts WHERE subject = ?").run(`record:${other.id}`);
  // The columns it reads of jobs and wakes (jobs.ts, wakes.ts).
  records.db.exec("CREATE TABLE jobs (id TEXT, agent TEXT, task TEXT, state TEXT, exit INTEGER, why TEXT, at INTEGER, ended INTEGER); CREATE TABLE wakes (key TEXT, task TEXT, cause TEXT, at INTEGER, state TEXT, job TEXT)");
  const t0 = Date.parse("2026-11-18T10:00:00.000Z");
  records.db.prepare("INSERT INTO jobs VALUES ('j-1', 'ag-ada', 't1', 'done', 0, '{}', ?, ?), ('j-2', 'ag-ada', 't1', 'admitted', NULL, '{}', ?, NULL)").run(t0, t0 + 60_000, t0);
  records.db.prepare("INSERT INTO wakes VALUES ('assigned:t1', 't1', 'assigned', ?, 'done', 'j-1'), ('comment:c1', 't1', 'comment', ?, 'done', NULL), ('comment:c2', 't1', 'comment', ?, 'done', 'j-1')").run(t0 - 5_000, t0 - 2_000, t0 - 1_000);
  // Ends the kernel didn't write: a job deferred (its row gone, its queue never ended) and a comment a job consumed.
  for (const [type, subject, version, data] of [["job.queued", "job:j-0", "queued", {}], ["wake.bound", "wake:assigned:t1", "bound:j-1", { job: "j-1" }]]) facts.record({ type, subject, version, task: "t1", at: new Date(t0 - 4_000).toISOString(), actor: "kernel", data });
  assert.equal(backfillLocal(records.db, facts, { agentKey: (id) => (id === "ag-ada" ? "ada" : undefined) }), 9, "the lost record, j-1 started and ended, three wakes opened, j-0's end, c1's and c2's ends");
  assert.equal(facts.forTask("t1").find((f) => f.subject === "job:j-0" && f.type === "job.ended").data.state, "deferred");
  assert.deepEqual(facts.forTask("t1").filter((f) => f.type === "wake.bound").map((f) => [f.subject, f.data.job]), [["wake:assigned:t1", "j-1"], ["wake:comment:c1", null], ["wake:comment:c2", "j-1"]]);
  assert.equal(backfillLocal(records.db, facts), 0);
  const ended = facts.forTask("t1").find((f) => f.type === "job.ended" && f.subject === "job:j-1");
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

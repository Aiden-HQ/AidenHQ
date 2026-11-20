// No idle agent-held task (idle.ts): the sweep's one wake per idle stretch and its daily cap, and an agent's own wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { createFlow } from "../src/flow.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";
import { createWakes } from "../src/wakes.ts";
import { createIdle } from "../src/idle.ts";

const AGENT = "a-1", MIN = 60_000;

/** t1 (agent-held) and t2 (the owner's) each ran one job that stopped at 10:01 with a plain reply, then nothing. */
function world() {
  let clock = Date.parse("2026-11-19T10:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER)");
  const facts = openFacts(db, () => new Date(clock));
  const issues = { t1: { id: "t1", status: "todo", assigneeAgentId: AGENT }, t2: { id: "t2", status: "todo", assigneeAgentId: null, assigneeUserId: "owner" } };
  const reads = [];
  let down = false;
  const owner = async (method, path) => {
    const m = /^\/api\/issues\/([^/?]+)$/.exec(path);
    if (m) reads.push(m[1]);
    if (down) return { status: 502, json: {} };
    return m && issues[m[1]] ? { status: 200, json: issues[m[1]] } : { status: 404, json: {} };
  };
  const add = (type, subject, task, data = {}) => facts.record({ type, subject, version: `${type}@${clock}`, at: iso(clock), actor: "unknown", task, data });
  for (const t of ["t1", "t2"]) {
    add("task.created", `task:${t}`, t, { parent: null, identifier: t.toUpperCase() });
    if (t === "t1") add("task.assignee_changed", `task:${t}`, t, { from: null, to: AGENT });
    add("job.queued", `job:j-${t}`, t);
    add("job.started", `job:j-${t}`, t);
  }
  clock += MIN;
  for (const t of ["t1", "t2"]) add("job.ended", `job:j-${t}`, t, { state: "done" });
  const flow = createFlow({ db, stages: () => KERNEL_STAGES, now: () => new Date(clock), cacheMs: 0 });
  const wakes = createWakes({ db, facts, owner, post: async () => ({}), now: () => clock, dispatches: { may: (mod, a) => mod === "dispatch" && a === AGENT, agents: () => [AGENT] } });
  wakes.claim("dispatch"); // the dispatcher joins: its agent's tasks are swept
  const idle = createIdle({ facts, flow, wakes, owner, now: () => clock });
  const rows = () => db.prepare("SELECT key, cause, state FROM wakes ORDER BY at, key").all().map((r) => `${r.key.replace(/:[0-9TZ:.-]+$/, "")} ${r.cause} ${r.state}`);
  /** A job on t1 from its wake to its end. */
  const job = (id) => { add("job.queued", `job:${id}`, "t1"); add("job.started", `job:${id}`, "t1"); clock += MIN; add("job.ended", `job:${id}`, "t1", { state: "done" }); };
  return { idle, wakes, flow, add, job, rows, reads, down: (v) => (down = v), tick: (ms) => (clock += ms), now: () => clock };
}

test("an agent-held task orphaned 15 minutes gets an idle wake, again 15 minutes after one is dropped, at most 3 a day; the owner's task none and isn't read", async () => {
  const w = world();
  w.tick(10 * MIN);
  assert.deepEqual(await w.idle.sweep(), [], "not yet 15 minutes");
  w.tick(6 * MIN);
  assert.deepEqual(await w.idle.sweep(), ["t1"]);
  assert.deepEqual(await w.idle.sweep(), [], "pending: not orphaned");
  assert.ok(!w.reads.includes("t2"), "the owner's task isn't read");
  // The dispatcher gives the wake up: orphaned again from then, so it is woken again 15 minutes later.
  w.wakes.drop("dispatch", w.wakes.claim("dispatch")[0].key, "test");
  w.tick(10 * MIN);
  assert.deepEqual(await w.idle.sweep(), [], "not 15 minutes since the drop");
  w.tick(6 * MIN);
  assert.deepEqual(await w.idle.sweep(), ["t1"]);
  w.wakes.drop("dispatch", w.wakes.claim("dispatch")[0].key, "test");
  // A third, after a job; the fourth in the day is the Fleet Steward's (idle_wakes 3).
  for (let n = 3; n <= 4; n++) {
    w.job(`j${n}`);
    w.tick(16 * MIN);
    assert.deepEqual(await w.idle.sweep(), n <= 3 ? ["t1"] : [], `wake ${n}`);
  }
  assert.equal(w.flow.idleNow().items.find((i) => i.task === "t1").idle_wakes, 3);
});

test("a wake the dispatcher keeps handing back without a job reads as orphaned after 2.5 hours, so the sweep wakes the task", async () => {
  const w = world();
  w.wakes.open({ key: "comment:c1", task: "t1", agent: AGENT, cause: "comment" });
  w.wakes.claim("dispatch"); // claimed, then busy: never bound or dropped
  w.tick(2 * 60 * MIN);
  assert.equal(w.flow.idleNow().items.find((i) => i.task === "t1").reason, "unknown", "still pending");
  w.tick(46 * MIN);
  assert.equal(w.flow.idleNow().items.find((i) => i.task === "t1").reason, "orphaned");
  assert.deepEqual(await w.idle.sweep(), ["t1"]);
  // One admission holds (queued behind the agent's max_parallel, the computers, a spend cap) is a queue, not orphaned.
  w.wakes.open({ key: "comment:c2", task: "t1", agent: AGENT, cause: "comment" });
  w.add("job.held", "wake:comment:c2", "t1", { reason: "capacity" });
  w.tick(3 * 60 * MIN);
  assert.equal(w.flow.idleNow().items.find((i) => i.task === "t1").reason, "unknown");
});

test("task_wait naming its task: a read that fails now is a 503 to retry, never a refusal", async () => {
  const w = world();
  w.down(true);
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", on: "PR merges", task: "t1" }), (e) => e.status === 503);
  w.down(false);
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", on: "PR merges", task: "t2" }), (e) => e.status === 409);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", on: "PR merges", task: "t1" })).waiting, true);
});

test("task_wait: the task waits (not orphaned) with its words, resumes at until, and its next job ends the wait", async () => {
  const w = world();
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", until: new Date(w.now() + 8 * 864e5).toISOString() }), /at most 7 days/);
  assert.deepEqual(await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until }), { waiting: true, until });
  w.tick(60 * MIN);
  assert.deepEqual(await w.idle.sweep(), []);
  const item = w.flow.idleNow().items.find((i) => i.task === "t1");
  assert.deepEqual([item.reason, item.note], ["agent_wait", "PR #12 merges"]);
  // A wake the dispatcher gives up without a job (another agent's comment) leaves the wait as it is.
  w.wakes.open({ key: "comment:c1", task: "t1", agent: AGENT, cause: "comment" });
  w.wakes.drop("dispatch", w.wakes.claim("dispatch")[0].key, "another agent's comment");
  assert.deepEqual(w.rows().filter((r) => r.startsWith("wait:")), ["wait:t1 wait: PR #12 merges open"]);
  assert.deepEqual(w.wakes.claim("dispatch"), [], "not due yet");
  w.tick(61 * MIN);
  assert.deepEqual(w.wakes.claim("dispatch").map((r) => [r.task, r.cause]), [["t1", "wait: PR #12 merges"]]);
  // The job it starts ends the wait: idle afterwards is orphaned again.
  w.job("j2");
  w.tick(MIN);
  assert.equal(w.flow.idleNow().items.find((i) => i.task === "t1").reason, "orphaned");
});

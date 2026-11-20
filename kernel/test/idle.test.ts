// No idle agent-held task (idle.ts): the sweep's one wake per idle stretch and its daily cap, and an agent's own wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { createTaskStateRead } from "../src/task-state-read.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";
import { createWakes } from "../src/wakes.ts";
import { createIdle } from "../src/idle.ts";
import { createEscalate } from "../src/escalate.ts";

const AGENT = "a-1", MIN = 60_000;

/** t1 (agent-held) and t2 (the owner's) each ran one job that stopped at 10:01 with a plain reply, then nothing. */
function world(t) {
  let clock = Date.parse("2026-11-19T10:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER)");
  const facts = openFacts(db, () => new Date(clock));
  const issues = { t0: { id: "t0", identifier: "T0", status: "blocked" }, t1: { id: "t1", identifier: "T1", status: "todo", assigneeAgentId: AGENT, parentId: "t0" }, t2: { id: "t2", status: "todo", assigneeAgentId: null, assigneeUserId: "owner" } };
  const reads = [];
  let down = false;
  const owner = async (method, path) => {
    const m = /^\/api\/issues\/([^/?]+)$/.exec(path);
    if (m) reads.push(m[1]);
    if (down) return { status: 502, json: {} };
    return m && issues[m[1]] ? { status: 200, json: issues[m[1]] } : { status: 404, json: {} };
  };
  const add = (type, subject, task, data = {}, actor = "unknown") => facts.record({ type, subject, version: `${type}@${clock}`, at: iso(clock), actor, task, data });
  for (const t of ["t1", "t2"]) {
    add("task.created", `task:${t}`, t, { parent: null, identifier: t.toUpperCase() });
    add("task.status_changed", `task:${t}`, t, { from: null, to: "todo" });
    add("task.assignee_changed", `task:${t}`, t, { from: null, to: t === "t1" ? AGENT : "owner" });
    add("job.queued", `job:j-${t}`, t);
    add("job.started", `job:j-${t}`, t);
  }
  clock += MIN;
  for (const t of ["t1", "t2"]) add("job.ended", `job:j-${t}`, t, { state: "done" });
  const state = createTaskStateRead({ file, stages: () => KERNEL_STAGES, now: () => clock });
  const row = (task) => state.read({ ids: [task] }).tasks[0];
  const wakes = createWakes({ db, facts, owner, post: async () => ({}), now: () => clock, dispatches: { may: (mod, a) => mod === "dispatch" && a === AGENT, agents: () => [AGENT] } });
  wakes.claim("dispatch"); // the dispatcher joins: its agent's tasks are swept
  const asked = { owner: [], notices: [] };
  const escalate = createEscalate({ db, issue: async (id) => issues[id], state: (id) => row(id), asker: async () => ({ name: "Kai", key: "kai", roles: [] }), notice: (task, body) => asked.notices.push({ task, body }), owner: (n) => asked.owner.push(n), now: () => clock });
  const idle = createIdle({ db, facts, state, wakes, owner, escalate, now: () => clock });
  const rows = () => db.prepare("SELECT key, cause, state FROM wakes ORDER BY at, key").all().map((r) => `${r.key.replace(/:[0-9TZ:.-]+$/, "")} ${r.cause} ${r.state}`);
  /** A job on t1 from its wake to its end. */
  const job = (id) => { add("job.queued", `job:${id}`, "t1"); add("job.started", `job:${id}`, "t1"); clock += MIN; add("job.ended", `job:${id}`, "t1", { state: "done" }); };
  return { db, idle, wakes, row, add, job, rows, reads, asked, down: (v) => (down = v), tick: (ms) => (clock += ms), now: () => clock };
}

test("an agent-held task orphaned 15 minutes gets an idle wake, again 15 minutes after one is dropped, at most 3 a day; the owner's task none and isn't read", async (t) => {
  const w = world(t);
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
  assert.equal(w.row("t1").idle_wakes, 3);
});

test("a wake the dispatcher keeps handing back without a job reads as unknown after 2.5 hours, so the sweep wakes the task", async (t) => {
  const w = world(t);
  w.wakes.open({ key: "comment:c1", task: "t1", agent: AGENT, cause: "comment" });
  w.wakes.claim("dispatch"); // claimed, then busy: never bound or dropped
  w.tick(2 * 60 * MIN);
  assert.equal(w.row("t1").reason, "job_queued", "still pending");
  w.tick(46 * MIN);
  assert.equal(w.row("t1").reason, "unknown", "the wake aged out");
  assert.deepEqual(await w.idle.sweep(), ["t1"]);
  // One admission holds (queued behind the agent's max_parallel, the computers, a spend cap) is a queue, not orphaned.
  w.wakes.open({ key: "comment:c2", task: "t1", agent: AGENT, cause: "comment" });
  w.add("job.held", "wake:comment:c2", "t1", { reason: "capacity" });
  w.tick(3 * 60 * MIN);
  assert.equal(w.row("t1").reason, "job_held");
});

test("task_wait naming its task: a read that fails now is a 503 to retry, never a refusal", async (t) => {
  const w = world(t);
  w.down(true);
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", on: "PR merges", task: "t1" }), (e) => e.status === 503);
  w.down(false);
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", on: "PR merges", task: "t2" }), (e) => e.status === 409);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", on: "PR merges", task: "t1" })).waiting, true);
});

test("task_wait: the task waits (not orphaned) with its words, resumes at until, and its next job ends the wait", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", until: new Date(w.now() + 8 * 864e5).toISOString() }), /at most 7 days/);
  assert.deepEqual(await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until }), { waiting: true, until });
  w.tick(60 * MIN);
  assert.deepEqual(await w.idle.sweep(), []);
  assert.equal(w.row("t1").reason, "agent_wait");
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
  assert.equal(w.row("t1").reason, "orphaned");
});

test("task_wait for the owner asks them, headed by the task and naming its agent for the owner's mutes, and waits for the answer; one open ask per task; for the delegator, its task hears a wake notice", async (t) => {
  const w = world(t);
  const ask = { reason: "which API the brief means", for: "owner", question: "Keep the v1 endpoint, or drop it?" };
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask);
  assert.equal(r.until, new Date(w.now() + 7 * 864e5).toISOString(), "it waits for the answer, not a day");
  assert.equal(r.asked, true);
  assert.deepEqual([w.asked.owner[0].kind, w.asked.owner[0].task, w.asked.owner[0].head, w.asked.owner[0].asker], ["decision", "T1", { agent: "Kai", issue: "t1" }, { id: AGENT, key: "kai", roles: [] }]);
  assert.match(w.asked.owner[0].text, /T1 waits on your answer[^]*Keep the v1 endpoint, or drop it\?/);
  // Unanswered (only its own agent and the kernel wrote since): another question, to anyone, isn't sent.
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, `agent:eng`);
  const again = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or rename it?" });
  assert.deepEqual([again.asked, w.asked.owner.length], [false, 1]);
  w.tick(MIN);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "delegator", question: "Which files?" })).asked, false);
  w.tick(30 * MIN);
  assert.equal(w.row("t1").reason, "delegator_wait");
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "delegator" }), /question/);
  // The owner answered: the next ask goes, here to the delegator, as a wake notice on its task.
  w.add("task.commented", "task:t1", "t1", { kind: "owner" }, "account:o1");
  w.tick(MIN);
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the brief's file list is stale", for: "delegator", question: "The modules were renamed: which files now?" });
  assert.deepEqual(w.asked.notices.map((n) => n.task), ["t0"]);
  assert.match(w.asked.notices[0].body, /^\*\*T1 asks you:\*\*[^]*```\nThe modules were renamed: which files now\?\n```[^]*<!-- aidenhq-wake -->$/);
});

test("an asked owner wait records its question and sends nothing", async (t) => {
  const w = world(t);
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the owner's answer", for: "owner", asked: true, question: "keep v1?" });
  assert.equal(r.asked, undefined);
  assert.equal(w.asked.owner.length, 0, "escalate.ask is not called");
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting'").all().map((r) => JSON.parse(r.data));
  assert.equal(fact.length, 1);
  assert.partialDeepStrictEqual(fact[0], { reason: "owner_wait", question: "keep v1?" });
  w.tick(MIN);
  const item = w.row("t1");
  assert.equal(item.reason, "owner_wait");
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", asked: true, question: "q" }), /for: owner/);
});

test("a chat awaiting the owner's next message is never swept", async (t) => {
  const w = world(t);
  w.add("task.created", "task:t3", "t3", { parent: null, identifier: "T3", chat: true });
  w.add("task.status_changed", "task:t3", "t3", { from: null, to: "todo" });
  w.add("task.assignee_changed", "task:t3", "t3", { from: null, to: AGENT });
  w.tick(30 * MIN);
  assert.equal(w.row("t3").reason, "chat_turn");
  assert.deepEqual(await w.idle.sweep(), ["t1"]);
  assert.ok(!w.reads.includes("t3"));
});

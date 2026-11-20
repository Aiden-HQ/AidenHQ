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
import { createEscalate, ownerWroteAt } from "../src/escalate.ts";

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
  const add = (type, subject, task, data = {}, actor = "unknown") => facts.record({ type, subject, version: actor.startsWith("module:") ? `${actor.slice(7)}/${clock}` : `${type}@${clock}`, at: iso(clock), actor, task, data });
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
  const asked = { owner: [], notices: [], chief: [] };
  // Who the task's agent is (roles: ["fleet-admin"] is the chief of staff) and whether the owner is talking to it on the task.
  const who = { roles: [], conversing: false };
  const escalate = createEscalate({ db, issue: async (id) => issues[id], state: (id) => row(id), asker: async () => ({ name: "Kai", key: "kai", roles: who.roles }), notice: (task, body) => asked.notices.push({ task, body }), owner: (n) => asked.owner.push(n), chief: async (b) => { asked.chief.push(b); }, conversing: async () => who.conversing, now: () => clock });
  const idle = createIdle({ db, facts, state, wakes, owner, escalate, now: () => clock });
  const rows = () => db.prepare("SELECT key, cause, state FROM wakes ORDER BY at, key").all().map((r) => `${r.key.replace(/:[0-9TZ:.-]+$/, "")} ${r.cause} ${r.state}`);
  /** A job on t1 from its wake to its end. */
  const job = (id) => { add("job.queued", `job:${id}`, "t1"); add("job.started", `job:${id}`, "t1"); clock += MIN; add("job.ended", `job:${id}`, "t1", { state: "done" }); };
  return { db, facts, idle, wakes, row, add, job, rows, reads, asked, who, issues, down: (v) => (down = v), tick: (ms) => (clock += ms), now: () => clock };
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

test("an agent's owner question goes to the chief of staff as one task, never to the owner; the chief's comment answers it and the next ask is a new task", async (t) => {
  const w = world(t);
  const ask = { reason: "which API the brief means", for: "owner", question: "Keep the v1 endpoint, or drop it?" };
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask);
  assert.deepEqual([r.to, r.asked, r.until], ["chief_of_staff", true, new Date(w.now() + 7 * 864e5).toISOString()]);
  assert.equal(w.asked.owner.length, 0, "nothing reaches the owner");
  assert.deepEqual([w.asked.chief.length, w.asked.chief[0].title, w.asked.chief[0].source], [1, "Decide for the owner: T1 (Kai)", "ask:t1:0"]);
  assert.match(w.asked.chief[0].description, /```\nKeep the v1 endpoint, or drop it\?\n```[^]*Asked on T1 \(task id t1\) by Kai/);
  w.tick(MIN);
  assert.deepEqual([w.row("t1").reason, w.row("t1").attention.map((a) => a.who)], ["delegator_wait", ["agent"]], "an agent answers it, not the owner");
  // Unanswered: another question isn't sent, and the first wait stands.
  const again = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or rename it?" });
  assert.deepEqual([again.asked, w.asked.chief.length], [false, 1]);
  // The chief of staff's comment is the answer: the wait ends, and the next ask is a new episode.
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:aiden");
  w.tick(MIN);
  assert.notEqual(w.row("t1").reason, "delegator_wait");
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask);
  assert.deepEqual(w.asked.chief.map((c) => c.source), ["ask:t1:0", "ask:t1:1"]);
});

test("the owner hears a question directly only on a task they are talking to its agent on, or from the chief of staff", async (t) => {
  const w = world(t);
  w.who.conversing = true;
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", question: "Keep v1?" });
  assert.deepEqual([r.to, w.asked.chief.length], ["owner", 0]);
  assert.deepEqual([w.asked.owner[0].kind, w.asked.owner[0].task, w.asked.owner[0].head, w.asked.owner[0].asker], ["decision", "T1", { agent: "Kai", issue: "t1" }, { id: AGENT, key: "kai", roles: [] }]);
  assert.match(w.asked.owner[0].text, /T1 waits on your answer[^]*Keep v1\?/);
  w.tick(MIN);
  assert.equal(w.row("t1").reason, "owner_wait");
  // The chief of staff's own question reaches the owner wherever it asks.
  w.add("task.commented", "task:t1", "t1", { kind: "owner" }, "account:o1");
  w.tick(MIN);
  w.who.conversing = false;
  w.who.roles = ["fleet-admin"];
  assert.equal((await w.idle.wait({ agent: AGENT, key: "aiden", task: "t1" }, { reason: "x", for: "owner", question: "Raise the spend cap?" })).to, "owner");
  assert.deepEqual([w.asked.owner.length, w.asked.chief.length], [2, 0]);
});

test("a delegator question goes to the open delegator, else the chief of staff (the chief's own: the owner)", async (t) => {
  const w = world(t);
  const ask = { reason: "the brief's file list is stale", for: "delegator", question: "The modules were renamed: which files now?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  assert.deepEqual(w.asked.notices.map((n) => n.task), ["t0"]);
  assert.match(w.asked.notices[0].body, /^\*\*T1 asks you:\*\*[^]*```\nThe modules were renamed: which files now\?\n```[^]*<!-- aidenhq-wake -->$/);
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "delegator" }), /question/);
  // The delegator answered; then its task closed: nobody delegated the next one, so the chief of staff settles it.
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:lead");
  w.tick(MIN);
  w.issues.t0.status = "done";
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "chief_of_staff");
  assert.deepEqual([w.asked.chief.length, w.asked.owner.length], [1, 0]);
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:aiden");
  w.tick(MIN);
  w.who.roles = ["fleet-admin"];
  assert.equal((await w.idle.wait({ agent: AGENT, key: "aiden", task: "t1" }, ask)).to, "owner", "never back to itself");
  assert.equal(w.asked.owner.length, 1);
});

test("an asked owner wait: recorded and not sent while the owner talks to the agent there; otherwise the chief of staff gets it; a handoff waits on the owner", async (t) => {
  const w = world(t);
  w.who.conversing = true;
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the owner's answer", for: "owner", asked: true, question: "keep v1?" });
  assert.deepEqual([r.asked, r.to, w.asked.owner.length, w.asked.chief.length], [undefined, "owner", 0, 0]);
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting'").all().map((r) => JSON.parse(r.data));
  assert.equal(fact.length, 1);
  assert.partialDeepStrictEqual(fact[0], { reason: "owner_wait", question: "keep v1?" });
  w.tick(MIN);
  assert.equal(w.row("t1").reason, "owner_wait");
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", asked: true, question: "q" }), /for: owner/);
  // Working on its own (the owner isn't talking there): the same call goes to the chief of staff.
  w.add("task.commented", "task:t1", "t1", { kind: "owner" }, "account:o1");
  w.tick(MIN);
  w.who.conversing = false;
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", asked: true, question: "keep v2?" })).to, "chief_of_staff");
  assert.deepEqual([w.asked.owner.length, w.asked.chief.length], [0, 1]);
  // A handoff on the owner's own task is a report to them, not a question: it waits on them.
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:aiden");
  w.tick(MIN);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", asked: true, handoff: true, question: "Done: see the PR." })).to, "owner");
  assert.equal(w.asked.chief.length, 1);
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

test("an ask fails closed: an unreadable state sends nothing; a follow-up a minute after the answer is sent", async (t) => {
  const w = world(t);
  let unreadable = false;
  const sent = [];
  const esc = createEscalate({ db: w.db, issue: async (id) => ({ id, identifier: id.toUpperCase(), status: "todo", assigneeAgentId: AGENT }), state: (id) => (unreadable ? undefined : w.row(id)), asker: async () => ({ name: "Kai", key: "kai", roles: [] }), notice: () => {}, owner: () => {}, chief: async (b) => { sent.push(b); }, conversing: async () => false, now: w.now });
  const idle = createIdle({ db: w.db, facts: w.facts, state: { read: () => ({ tasks: [] }) }, wakes: w.wakes, owner: async () => ({ status: 200, json: { id: "t1" } }), escalate: esc, now: w.now });
  assert.equal((await idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", question: "keep v1?" })).asked, true);
  unreadable = true;
  w.tick(60 * MIN);
  assert.equal((await esc.ask("t1", "owner", "keep v1?")).sent, "open", "state unreadable: fail closed");
  unreadable = false;
  assert.equal((await esc.ask("t1", "owner", "again?")).sent, "open", "the wait is open");
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "owner" }, "account:o1");
  w.tick(MIN);
  assert.equal((await esc.ask("t1", "owner", "follow-up?")).sent, "asked", "a minute after the answer");
  assert.equal(sent.length, 2);
});

test("the owner wrote on a task: their own comment or the opening of a task they wrote, never a marked post, an agent's or a filed task's", () => {
  const at = (x) => `2026-11-19T${x}:00Z`;
  const own = { description: "Fix the login", createdAt: at("08:00"), createdByUserId: "o1", createdByAgentId: null };
  assert.equal(ownerWroteAt(own, []), Date.parse(at("08:00")));
  assert.equal(ownerWroteAt(own, [{ body: "[telegram] go on", authorUserId: "o1", createdAt: at("09:00") }, { body: "done", authorAgentId: "a", createdAt: at("10:00") }, { body: "[wake] x <!-- aidenhq-wake -->", authorUserId: "o1", createdAt: at("11:00") }]), Date.parse(at("09:00")));
  assert.equal(ownerWroteAt({ ...own, description: "x\n<!-- source:ask:t:0 -->" }, []), undefined, "a kernel-filed task");
  assert.equal(ownerWroteAt({ ...own, createdByAgentId: "a" }, []), undefined, "an agent's task");
});

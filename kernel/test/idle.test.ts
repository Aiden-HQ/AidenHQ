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
function world(t, { polls = true } = {}) {
  let clock = Date.parse("2026-11-19T10:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER)");
  const facts = openFacts(db, () => new Date(clock));
  const issues = { t0: { id: "t0", identifier: "T0", status: "blocked", assigneeAgentId: AGENT }, t1: { id: "t1", identifier: "T1", status: "todo", assigneeAgentId: AGENT, parentId: "t0", companyId: "co" }, t2: { id: "t2", status: "todo", assigneeAgentId: null, assigneeUserId: "owner" } };
  // Paperclip's agents (status + org chain: the sweep's invokability check), by id.
  const agents = { [AGENT]: { id: AGENT, companyId: "co", status: "idle", lifecycleHolds: [], reportsTo: null }, boss: { id: "boss", companyId: "co", status: "idle", lifecycleHolds: [], reportsTo: null } };
  const reads = [];
  const writes = [];
  const seen = [];
  const resolved = [];
  let down = false;
  // A status the control plane refuses (a failed PATCH).
  let refusePatch;
  let refuseResolveAfterApply = false;
  let dropWaitOnResolve = false;
  // A PATCH that lands but answers with an error, and a read that fails: unknown.
  let refuseAfterApply = false;
  let blindNext = 0;
  const parks = () => db.prepare("SELECT task, agent, from_status FROM wait_parks").all();
  const owner = async (method, path, body) => {
    const m = /^\/api\/issues\/([^/?]+)$/.exec(path);
    if (m && method === "GET") {
      reads.push(m[1]);
      if (blindNext > 0) { blindNext -= 1; return { status: 502, json: {} }; }
    }
    if (down) return { status: 502, json: {} };
    if (m && method === "PATCH") {
      if (!issues[m[1]]) return { status: 404, json: {} };
      if (refusePatch && body.status === refusePatch) {
        if (!refuseAfterApply) return { status: 409, json: { error: "refused (test)" } };
        // The write lands and the answer is lost.
        if (body.status) issues[m[1]] = { ...issues[m[1]], status: body.status };
        blindNext = 1;
        return { status: 504, json: { error: "gateway timeout (test)" } };
      }
      // The rows at the instant of the write: a park's row must already be there.
      seen.push({ task: m[1], status: body.status, rows: db.prepare("SELECT task FROM wait_parks").all().map((r) => r.task) });
      writes.push({ task: m[1], body });
      if (body.status) issues[m[1]] = { ...issues[m[1]], status: body.status };
      return { status: 200, json: issues[m[1]] };
    }
    const res = /^\/api\/issues\/([^/?]+)\/recovery-actions\/resolve$/.exec(path);
    if (res && method === "POST") {
      resolved.push({ task: res[1], body });
      // The wait can stop being armed while the resolution is in flight.
      if (dropWaitOnResolve) db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = ? AND key LIKE 'wait:%'").run(res[1]);
      issues[res[1]] = { ...issues[res[1]], status: body.sourceIssueStatus, activeRecoveryAction: null };
      // A resolve that takes effect, then answers with an error.
      if (refuseResolveAfterApply) return { status: 504, json: { error: "gateway timeout (test)" } };
      return { status: 200, json: { issue: issues[res[1]] } };
    }
    if (/^\/api\/companies\/[^/]+\/agents$/.test(path)) return { status: 200, json: Object.values(agents) };
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
  const state = createTaskStateRead({ file, stages: () => KERNEL_STAGES, now: () => clock, polled: () => polls });
  const row = (task) => state.read({ ids: [task] }).tasks[0];
  const wakes = createWakes({ db, facts, owner, post: async () => ({}), now: () => clock, dispatches: { may: (mod, a) => mod === "dispatch" && a === AGENT, agents: () => [AGENT] } });
  // The dispatcher joins (its agent's tasks are swept); a task whose agent no dispatcher runs never sees one.
  if (polls) wakes.claim("dispatch");
  const asked = { owner: [], notices: [], chief: [], steward: [] };
  // Who the task's agent is (roles: ["fleet-admin"] is the chief of staff, ["fleet-settle"] the Steward) and whether the owner is talking to it on the task.
  const who = { roles: [], conversing: false };
  const escalate = createEscalate({ db, issue: async (id) => issues[id], state: (id) => row(id), asker: async () => ({ name: "Kai", key: "kai", roles: who.roles }), notice: (task, body) => asked.notices.push({ task, body }), owner: (n) => asked.owner.push(n), chief: async (b) => { asked.chief.push(b); }, settle: async (b) => { asked.steward.push(b); }, settleAgent: () => "steward-id", conversing: async () => who.conversing, now: () => clock });
  const idle = createIdle({ db, facts, state, wakes, owner, keyOf: (id) => (id === AGENT ? "eng" : id), escalate, now: () => clock });
  const rows = () => db.prepare("SELECT key, cause, state FROM wakes ORDER BY at, key").all().map((r) => `${r.key.replace(/:[0-9TZ:.-]+$/, "")} ${r.cause} ${r.state}`);
  /** A job on t1 from its wake to its end. */
  const job = (id) => { add("job.queued", `job:${id}`, "t1"); add("job.started", `job:${id}`, "t1"); clock += MIN; add("job.ended", `job:${id}`, "t1", { state: "done" }); };
  return { db, facts, idle, escalate, wakes, row, add, job, rows, reads, writes, seen, resolved, parks, asked, who, agents, issues, down: (v) => (down = v), refusePatch: (v) => (refusePatch = v), refuseAfterApply: (v) => (refuseAfterApply = v), refuseResolveAfterApply: (v) => (refuseResolveAfterApply = v), dropWaitOnResolve: (v) => (dropWaitOnResolve = v), blindNext: (n) => (blindNext = n), tick: (ms) => (clock += ms), now: () => clock };
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

test("an agent's owner question goes to the Fleet Steward as one task, never to the owner; the Steward's comment answers it and the next ask is a new task", async (t) => {
  const w = world(t);
  const ask = { reason: "which API the brief means", for: "owner", question: "Keep the v1 endpoint, or drop it?" };
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask);
  assert.deepEqual([r.to, r.asked, r.until], ["steward", true, new Date(w.now() + 7 * 864e5).toISOString()]);
  assert.equal(w.asked.owner.length, 0, "nothing reaches the owner");
  assert.deepEqual([w.asked.steward.length, w.asked.steward[0].title, w.asked.steward[0].source], [1, "Settle: T1 (Kai)", "ask:t1:0"]);
  assert.match(w.asked.steward[0].description, /```\nKeep the v1 endpoint, or drop it\?\n```[^]*Asked on T1 \(task id t1\) by Kai/);
  w.tick(MIN);
  assert.deepEqual([w.row("t1").reason, w.row("t1").attention.map((a) => a.who)], ["delegator_wait", ["agent"]], "an agent answers it, not the owner");
  // Unanswered: a retry of the same question sends nothing new, and a different one is refused with the first wait standing.
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).asked, true);
  assert.equal(w.asked.steward.length, 1, "a retry of the open question sends nothing");
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or rename it?" }), { status: 409 });
  assert.equal(w.asked.steward.length, 1, "nothing was sent");
  assert.equal(JSON.parse(w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get().data).question, "Keep the v1 endpoint, or drop it?", "the first wait stands");
  // The Steward's comment is the answer: the wait ends, and the next ask is a new episode.
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:steward");
  w.tick(MIN);
  assert.notEqual(w.row("t1").reason, "delegator_wait");
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or rename it?" });
  assert.equal(w.asked.steward.length, 2);
  assert.match(w.asked.steward[1].description, /Or rename it\?/);
});

test("the Steward settles an agent's question: its task goes to role fleet-settle, the wait names it, and its comment ends the wait; the Steward's own question goes to the chief of staff", async (t) => {
  const w = world(t);
  const ask = { reason: "which endpoint", for: "delegator", question: "Keep v1 or drop it?" };
  w.issues.t0.status = "done"; // no open delegator: nobody nearer can answer
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask);
  assert.deepEqual([r.to, w.asked.steward.length, w.asked.chief.length, w.asked.owner.length], ["steward", 1, 0, 0]);
  assert.match(w.asked.steward[0].description, /skill `fleet-check`[^]*your comment on T1 is the answer/);
  assert.equal(JSON.parse(w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get().data).agent, "steward-id", "the wait names the Steward as who answers");
  w.tick(MIN);
  assert.equal(w.row("t1").reason, "delegator_wait");
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:steward");
  w.tick(MIN);
  assert.notEqual(w.row("t1").reason, "delegator_wait", "the Steward's answer ends the wait (the comment wakes its agent, wakes.ts)");
  // The Steward's own question never comes back to it: the chief of staff decides whether it is the owner's.
  w.who.roles = ["fleet-settle"];
  assert.equal((await w.idle.wait({ agent: AGENT, key: "fleet-steward", task: "t1" }, { reason: "x", for: "owner", question: "Raise the spend cap?" })).to, "chief_of_staff");
  assert.deepEqual([w.asked.steward.length, w.asked.chief.length, w.asked.owner.length], [1, 1, 0]);
  assert.equal(w.asked.chief[0].title, "Decide for the owner: T1 (Kai)");
});

test("an agent's asks to the Steward are capped per agent per day; over it the call is refused, and a new day lifts it", async (t) => {
  const w = world(t);
  for (let i = 0; i < 10; i++) assert.equal((await w.escalate.ask("t1", "owner", `Question ${i}?`)).sent, "asked");
  assert.equal((await w.escalate.ask("t1", "owner", "One more?")).sent, "limit");
  assert.equal(w.asked.steward.length, 10);
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", question: "Again?" }), { status: 429 });
  w.tick(25 * 3600_000);
  assert.equal((await w.escalate.ask("t1", "owner", "Tomorrow?")).sent, "asked");
});

test("the owner hears a question directly only on a task they are talking to its agent on, or from the chief of staff", async (t) => {
  const w = world(t);
  w.who.conversing = true;
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", question: "Keep v1?" });
  assert.deepEqual([r.to, w.asked.steward.length], ["owner", 0]);
  assert.deepEqual([w.asked.owner[0].kind, w.asked.owner[0].task, w.asked.owner[0].head, w.asked.owner[0].asker], ["decision", "T1", { agent: "Kai", issue: "t1" }, { id: AGENT, key: "kai", roles: [] }]);
  assert.match(w.asked.owner[0].text, /T1 waits on your answer[^]*Keep v1\?/);
  // While that question is open, another one is refused: nothing is sent and the wait stands.
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", question: "Keep v2?" }), { status: 409 });
  assert.equal(w.asked.owner.length, 1);
  w.tick(MIN);
  assert.equal(w.row("t1").reason, "owner_wait");
  // After the owner answers, the next question is a new episode: it must not reuse the first one's dedupe key, or the owner
  // channel drops it as the old one.
  w.add("task.commented", "task:t1", "t1", { kind: "owner" }, "account:o1");
  w.tick(MIN);
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", question: "Keep v2?" });
  assert.equal(w.asked.owner.length, 2);
  assert.notEqual(w.asked.owner[0].dedupe_key, w.asked.owner[1].dedupe_key);
  assert.match(w.asked.owner[1].text, /Keep v2\?/);
  w.tick(MIN);
  assert.equal(w.row("t1").reason, "owner_wait");
  // The chief of staff's own question reaches the owner wherever it asks.
  w.add("task.commented", "task:t1", "t1", { kind: "owner" }, "account:o1");
  w.tick(MIN);
  w.who.conversing = false;
  w.who.roles = ["fleet-admin"];
  assert.equal((await w.idle.wait({ agent: AGENT, key: "aiden", task: "t1" }, { reason: "x", for: "owner", question: "Raise the spend cap?" })).to, "owner");
  assert.deepEqual([w.asked.owner.length, w.asked.steward.length], [3, 0]);
});

test("a delegator question goes to the open delegator, else the Fleet Steward (the chief's own: the owner)", async (t) => {
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
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "steward");
  assert.deepEqual([w.asked.steward.length, w.asked.owner.length], [1, 0]);
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:aiden");
  w.tick(MIN);
  w.who.roles = ["fleet-admin"];
  assert.equal((await w.idle.wait({ agent: AGENT, key: "aiden", task: "t1" }, ask)).to, "owner", "never back to itself");
  assert.equal(w.asked.owner.length, 1);
});

test("an asked owner wait: recorded and not sent while the owner talks to the agent there; otherwise the Steward gets it; a handoff waits on the owner", async (t) => {
  const w = world(t);
  w.who.conversing = true;
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the owner's answer", for: "owner", asked: true, question: "keep v1?" });
  assert.deepEqual([r.asked, r.to, w.asked.owner.length, w.asked.steward.length], [undefined, "owner", 0, 0]);
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
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", asked: true, question: "keep v2?" })).to, "steward");
  assert.deepEqual([w.asked.owner.length, w.asked.steward.length], [0, 1]);
  // A handoff on the owner's own task is a report to them, not a question: it waits on them.
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:aiden");
  w.tick(MIN);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", asked: true, handoff: true, question: "Done: see the PR." })).to, "owner");
  assert.equal(w.asked.steward.length, 1);
});

test("a questionless delegator_wait attention doesn't hold the task: task_wait reaches the delegator", async (t) => {
  const w = world(t);
  // A questionless `delegator_wait` attention (a state signal, not a recorded ask) must never pass for an unanswered question.
  const questionless = () => ({ ...w.row("t1"), attention: [{ who: "agent", why: "delegator_wait", ref: "task:t1" }], question: undefined, wait_since: undefined });
  const asked = [];
  const esc = createEscalate({ db: w.db, issue: async (id) => w.issues[id], state: () => questionless(), asker: async () => ({ name: "Kai", key: "kai", roles: [] }), notice: (task, body) => asked.push({ task, body }), owner: () => {}, chief: async () => {}, settle: async () => {}, conversing: async () => false, now: w.now });
  const idle = createIdle({ db: w.db, facts: w.facts, state: { read: () => ({ tasks: [] }) }, wakes: w.wakes, owner: async () => ({ status: 200, json: { id: "t1" } }), escalate: esc, now: w.now });
  const r = await idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the brief names a stale path", for: "delegator", question: "Which path is current?" });
  assert.deepEqual([r.asked, r.to], [true, "delegator"]);
  assert.equal(asked.length, 1);
  assert.match(asked[0].body, /Which path is current\?/);
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(fact.data).question, "Which path is current?");
});

test("an answered delegator question does not keep the next question from reaching the delegator", async (t) => {
  const w = world(t);
  const ask = { reason: "which path", for: "delegator", question: "Which path is current?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:lead");
  w.tick(MIN);
  assert.notEqual(w.row("t1").reason, "delegator_wait");
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or this one?" })).to, "delegator");
  assert.equal(w.asked.notices.length, 2);
  assert.match(w.asked.notices[1].body, /Or this one\?/);
});

test("an ask from before the task was reopened is not open", async (t) => {
  const w = world(t);
  const ask = { reason: "which path", for: "delegator", question: "Which path is current?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  w.tick(MIN);
  w.issues.t1.status = "done";
  w.add("task.status_changed", "task:t1", "t1", { from: "in_progress", to: "done" }, "kernel");
  w.tick(MIN);
  w.issues.t1.status = "todo";
  w.add("task.status_changed", "task:t1", "t1", { from: "done", to: "todo" }, "kernel");
  w.tick(MIN);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or this one?" })).to, "delegator");
  assert.equal(w.asked.notices.length, 2);
});

test("a genuinely unanswered ask is kept: a retry sends nothing, a different question is refused", async (t) => {
  const w = world(t);
  const ask = { reason: "which path", for: "delegator", question: "Which path is current?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  w.tick(MIN);
  // The same question again (a retry whose answer was lost) is idempotent: no second notice, the wait as it was.
  const again = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask);
  assert.deepEqual([again.asked, again.to], [true, "delegator"]);
  assert.equal(w.asked.notices.length, 1, "a retry sends nothing");
  // Another question while that one is open doesn't replace it: the call fails, nothing is sent, the first wait stands.
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Which path is current now?" }), { status: 409 });
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(fact.data).question, "Which path is current?");
  assert.equal(w.asked.notices.length, 1);
});

test("a second question routed to a different recipient is refused, not replaced", async (t) => {
  const w = world(t);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "delegator", question: "Which path is current?" })).to, "delegator");
  w.tick(MIN);
  // An owner question routed to the chief of staff is another recipient: the first ask stands.
  w.who.conversing = true;
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "owner", question: "Owner instead?" }), { status: 409 });
  w.who.conversing = false;
  assert.equal(w.asked.steward.length, 0, "nothing was sent to the other recipient");
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(fact.data).question, "Which path is current?", "the first wait stands");
});

test("a closed delegator's ask doesn't hold the task: the next question goes to the Fleet Steward", async (t) => {
  const w = world(t);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "delegator", question: "Which path is current?" })).to, "delegator");
  w.tick(MIN);
  // Closing the delegator ends nothing on t1: its wait names a recipient that is gone. It must not block a question anybody can answer.
  w.issues.t0.status = "done";
  w.tick(MIN);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "delegator", question: "Or this one?" })).to, "steward");
  assert.equal(w.asked.steward.length, 1);
  assert.match(w.asked.steward[0].description, /Or this one\?/);
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(fact.data).question, "Or this one?");
});

test("a legacy ask marker whose recipient can't be told is refused, not replaced", async (t) => {
  const w = world(t);
  const ask = { reason: "which path", for: "delegator", question: "Which path is current?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  w.tick(MIN);
  // Before this change every ask's marker was the bare kind, where "delegator" also meant the chief of staff: who waits is
  // not in the row, so a question that would route to the delegator must not replace it on a guess.
  w.db.prepare("UPDATE escalations SET kind = 'delegator' WHERE key = 'ask:t1'").run();
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or this one?" }), { status: 409 });
  assert.equal(w.asked.notices.length, 1, "nothing was sent");
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(fact.data).question, "Which path is current?", "the first wait stands");
});

test("a bare chief_of_staff marker names its recipient: the refusal says so, and a retry is idempotent", async (t) => {
  const w = world(t);
  const ask = { reason: "which path", for: "owner", question: "Keep v1?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "steward");
  w.tick(MIN);
  // The revision before this one wrote the resolved destination as the bare kind, so `chief_of_staff` is exact (unlike
  // `delegator`, which the older scheme also used for the chief of staff).
  w.db.prepare("UPDATE escalations SET kind = 'chief_of_staff' WHERE key = 'ask:t1'").run();
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).asked, true, "the retry is the open question");
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or rename it?" }), (e) => e.status === 409 && /chief_of_staff/.test(e.message));
  assert.equal(w.asked.steward.length, 1);
});

test("two waits with the same until get their own wake, one per episode", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  const ask = { reason: "which path", until, for: "delegator", question: "Which path is current?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  const first = w.db.prepare("SELECT key FROM wakes WHERE task = 't1' AND state = 'open' AND key LIKE 'wait:%'").get().key;
  // The delegator answers; the next question waits to the same minute, from another millisecond.
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "agent" }, "agent:lead");
  w.tick(MIN);
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Which path is current now?" });
  const open = w.db.prepare("SELECT key FROM wakes WHERE task = 't1' AND state = 'open' AND key LIKE 'wait:%'").all();
  assert.equal(open.length, 1, "the newer wait replaced the older");
  assert.notEqual(open[0].key, first, "the same until in another millisecond is another wake");
  assert.equal(JSON.parse(w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get().data).question, "Which path is current now?");
});

test("an asked replay of another question is neither sent again nor a refusal: the live ask stands", async (t) => {
  const w = world(t);
  // A delegator question stands unanswered.
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "delegator", question: "Which path?" })).to, "delegator");
  w.tick(MIN);
  // notify's decision already put a different question in front of the owner. Refusing would fail a call whose question the owner
  // has; replacing would drop the live ask. Neither: nothing is sent, the live ask stands, and the reply says the owner has it.
  w.who.conversing = true;
  const r = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the owner's answer", for: "owner", asked: true, question: "Keep v1?" });
  assert.deepEqual([r.asked, r.to], [true, "delegator"], "the live ask's recipient, not a refusal");
  assert.match(String(r.note), /owner already has this question/);
  assert.deepEqual([w.asked.owner.length, w.asked.notices.length], [0, 1], "nothing was sent");
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(fact.data).question, "Which path?", "the live ask keeps its question");
  // The replay of the question that is open is the plain idempotent retry.
  const same = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the owner's answer", for: "owner", asked: true, question: "Which path?" });
  assert.deepEqual([same.asked, same.to], [true, "delegator"]);
  assert.equal(same.note, undefined);
  assert.deepEqual([w.asked.owner.length, w.asked.notices.length], [0, 1]);
});

test("a handoff records no ask marker, so it can't block a later question", async (t) => {
  const w = world(t);
  w.issues.t2.assigneeUserId = "owner";
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "handed back to the owner", for: "owner", question: "Your call on the brief?", handoff: true });
  assert.equal(w.db.prepare("SELECT 1 FROM escalations WHERE key = 'ask:t1'").get(), undefined, "no ask was made");
  // The question that comes after it reaches the chief of staff, not a 409 naming a recipient nobody wrote to.
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "owner", question: "Keep v1?" })).to, "steward");
  assert.equal(w.asked.steward.length, 1);
});

test("a retry is compared with the same normalization as the stored question", async (t) => {
  const w = world(t);
  const ask = { reason: "which path", for: "delegator", question: "Is this --> the path?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  w.tick(MIN);
  // The wait fact holds the question as it was sent; the comparison normalises it the same way the new question is normalised
  // (neutral(), which rewrites `-->`), or the very same question reads as a different one and is refused.
  const again = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask);
  assert.deepEqual([again.asked, again.to], [true, "delegator"]);
  assert.equal(w.asked.notices.length, 1, "a retry sends nothing");
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(fact.data).question, "Is this --> the path?", "the wait as it was");
});

test("a retry reports only the wait's own deadline, never one that was never recorded", async (t) => {
  const w = world(t);
  // A wait with no `until` at all (a delegator question arms the maximum wait, and the row is the record of it).
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "delegator", question: "Which path?" })).to, "delegator");
  w.tick(MIN);
  // The retry names a deadline; nothing new is armed, so the call must not claim that deadline as the wait's.
  const again = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", until: new Date(w.now() + 40 * MIN).toISOString(), for: "delegator", question: "Which path?" });
  const row = w.row("t1");
  assert.equal(again.until, row.wait_until, "the recorded wait's own deadline");
  assert.notEqual(again.until, new Date(w.now() + 40 * MIN).toISOString(), "never the one this call supplied");
});

test("a closed delegator doesn't settle a legacy ask: its bare marker may be the chief of staff's", async (t) => {
  const w = world(t);
  const ask = { reason: "which path", for: "delegator", question: "Which path is current?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  w.tick(MIN);
  // The old scheme stored the bare kind, and it also stored it for an ask that actually went to the chief of staff: a closed
  // delegator can't settle who holds that question, so it stays refused as ambiguous rather than dropped and asked again.
  w.db.prepare("UPDATE escalations SET kind = 'delegator' WHERE key = 'ask:t1'").run();
  w.issues.t0.status = "done";
  w.tick(MIN);
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or this one?" }), (e) => e.status === 409 && /recipient can't be told apart/.test(e.message));
  assert.equal(w.asked.steward.length, 0, "nothing was sent");
  assert.equal(w.asked.notices.length, 1, "nothing was sent to anyone");
  const fact = w.db.prepare("SELECT data FROM facts WHERE type = 'work.waiting' AND subject = 'wait:t1' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(fact.data).question, "Which path is current?", "the first wait stands");
});

test("a malformed deadline on a new question fails before anything is sent", async (t) => {
  const w = world(t);
  // The question must never reach the delegator for a call that then fails: nothing is sent and no ask marker is written.
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", until: "soon", for: "delegator", question: "Which path?" }), { status: 400 });
  assert.equal(w.asked.notices.length, 0, "nothing was sent");
  assert.equal(w.db.prepare("SELECT 1 FROM escalations WHERE key = 'ask:t1'").get(), undefined, "no ask marker");
  // A retry with a good deadline then goes through normally.
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "delegator", question: "Which path?" })).to, "delegator");
  assert.equal(w.asked.notices.length, 1);
});

test("a retry of the open question with a stale deadline reuses its wait instead of failing", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 20 * MIN).toISOString();
  const ask = { reason: "which path", until, for: "delegator", question: "Which path is current?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  // The deadline passes while the answer is lost, and the agent retries the same question: its own wait still stands and the
  // stale `until` is never armed, so the retry can't be refused for a deadline it doesn't use.
  w.tick(25 * MIN);
  const again = await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask);
  assert.deepEqual([again.asked, again.to], [true, "delegator"]);
  assert.equal(again.until, until, "the wait's own deadline is reused");
  assert.equal(w.asked.notices.length, 1, "a retry sends nothing");
});

test("a handoff clears the earlier ask marker, so its own question can't hold the task", async (t) => {
  const w = world(t);
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "delegator", question: "Which path is current?" })).to, "delegator");
  w.tick(MIN);
  // The agent hands back to the owner: a report on the owner's task, not a question, and no ask of its own.
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "handed back", for: "owner", handoff: true, question: "Done: see the PR." })).to, "owner");
  assert.equal(w.db.prepare("SELECT 1 FROM escalations WHERE key = 'ask:t1'").get(), undefined, "the earlier ask marker is gone with its wait");
  w.tick(MIN);
  // A real question now reaches the delegator: the handoff's question, paired with the earlier delegator marker, must not read as
  // an ambiguous open ask and fail every question after it.
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "which path", for: "delegator", question: "Which path now?" })).to, "delegator");
  assert.equal(w.asked.notices.length, 2);
  assert.match(w.asked.notices[1].body, /Which path now\?/);
});

test("a legacy marker written after its wait still holds its open ask", async (t) => {
  const w = world(t);
  const ask = { reason: "which path", for: "delegator", question: "Which path is current?" };
  assert.equal((await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, ask)).to, "delegator");
  w.tick(MIN);
  // Before this change record() ran after the wait's own timestamp was taken, so a delivery that crossed a millisecond left the
  // marker later than its wait. That is still this stretch's ask, and it still stands.
  const at = Date.parse(w.row("t1").wait_since) + 1;
  w.db.prepare("INSERT OR REPLACE INTO escalations (key, task, kind, at) VALUES ('ask:t1', 't1', 'delegator', ?)").run(at);
  await assert.rejects(w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { ...ask, question: "Or this one?" }), { status: 409 });
  assert.equal(w.asked.notices.length, 1, "nothing was sent");
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
  const esc = createEscalate({ db: w.db, issue: async (id) => ({ id, identifier: id.toUpperCase(), status: "todo", assigneeAgentId: AGENT }), state: (id) => (unreadable ? undefined : w.row(id)), asker: async () => ({ name: "Kai", key: "kai", roles: [] }), notice: () => {}, owner: () => {}, chief: async () => {}, settle: async (b) => { sent.push(b); }, conversing: async () => false, now: w.now });
  const idle = createIdle({ db: w.db, facts: w.facts, state: { read: () => ({ tasks: [] }) }, wakes: w.wakes, owner: async () => ({ status: 200, json: { id: "t1" } }), escalate: esc, now: w.now });
  assert.equal((await idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "x", for: "owner", question: "keep v1?" })).asked, true);
  unreadable = true;
  w.tick(60 * MIN);
  assert.equal((await esc.ask("t1", "owner", "keep v1?")).sent, "open", "state unreadable: fail closed");
  unreadable = false;
  assert.equal((await esc.ask("t1", "owner", "keep v1?")).sent, "same", "a retry of the open question is idempotent");
  assert.equal((await esc.ask("t1", "owner", "again?")).sent, "open", "a different question waits for the answer");
  w.tick(MIN);
  w.add("task.commented", "task:t1", "t1", { kind: "owner" }, "account:o1");
  w.tick(MIN);
  assert.equal((await esc.ask("t1", "owner", "follow-up?")).sent, "asked", "a minute after the answer");
  assert.equal(sent.length, 2, "the retry filed nothing new");
});

test("the owner wrote on a task: their own comment or the opening of a chat they opened, never a marked post, an agent's task or a routine's", () => {
  const at = (x) => `2026-11-19T${x}:00Z`;
  const own = { description: "Fix the login\n\n<!-- aidenhq-chat-agent:eng -->", createdAt: at("08:00"), createdByUserId: "o1", createdByAgentId: null };
  assert.equal(ownerWroteAt(own, []), Date.parse(at("08:00")));
  assert.equal(ownerWroteAt(own, [{ body: "[telegram] go on", authorUserId: "o1", createdAt: at("09:00") }, { body: "done", authorAgentId: "a", createdAt: at("10:00") }, { body: "[wake] x <!-- aidenhq-wake -->", authorUserId: "o1", createdAt: at("11:00") }]), Date.parse(at("09:00")));
  assert.equal(ownerWroteAt({ ...own, description: "Heartbeat: eng" }, []), undefined, "no chat marker: a routine's run, a heartbeat, a filed task");
  assert.equal(ownerWroteAt({ ...own, createdByAgentId: "a" }, []), undefined, "an agent's task");
});

test("a task whose agent no enabled dispatcher polls reads unpolled, and the sweep leaves it alone (it could not be taken)", async (t) => {
  const w = world(t, { polls: false });
  w.tick(20 * MIN);
  assert.equal(w.row("t1").reason, "unpolled", "the state names why nothing runs it, never orphaned");
  assert.deepEqual(await w.idle.sweep(), [], "the sweep leaves it alone: its wake would never be taken");
  assert.deepEqual(w.rows().filter((r) => r.startsWith("idle:")), [], "no idle row was opened");
});

test("a task idle in review is sent once to whoever delegated it, never woken for its holder", async (t) => {
  const w = world(t);
  w.issues.t1 = { ...w.issues.t1, status: "in_review" };
  w.tick(20 * MIN);
  assert.equal(w.row("t1").reason, "orphaned");
  assert.deepEqual(await w.idle.sweep(), [], "not before the fact log shows the review");
  w.add("task.status_changed", "task:t1", "t1", { from: "todo", to: "in_review" });
  w.tick(20 * MIN);
  assert.deepEqual(await w.idle.sweep(), ["t1"]);
  assert.deepEqual(w.asked.notices.map((n) => n.task), ["t0"], "the open delegator (its parent) hears it");
  assert.deepEqual(w.rows().filter((r) => r.startsWith("idle:")), [], "the holder is not woken: its part is done");
  assert.deepEqual(await w.idle.sweep(), [], "once per idle stretch");
});

test("a task idle in review whose parent holds no agent goes to the Fleet Steward", async (t) => {
  const w = world(t);
  w.issues.t0 = { ...w.issues.t0, assigneeAgentId: null };
  w.issues.t1 = { ...w.issues.t1, status: "in_review" };
  w.add("task.status_changed", "task:t1", "t1", { from: "todo", to: "in_review" });
  w.tick(20 * MIN);
  assert.deepEqual(await w.idle.sweep(), ["t1"]);
  assert.deepEqual(w.asked.notices, []);
  assert.equal(w.asked.steward.length, 1);
});

// ---- A settled wait is not the sweep's work (WOR-9033, Aiden-HQ/AidenHQ#1004) ----
/** The pinned sweep's candidate test: todo/in_progress/in_review, an agent assignee, no user assignee. */
const sweepWouldScan = (i) => ["todo", "in_progress", "in_review"].includes(i.status) && Boolean(i.assigneeAgentId) && !i.assigneeUserId;

test("an armed wait parks the issue in backlog: outside the pinned sweep's eligible set, however the holder's status changes", async (t) => {
  const w = world(t);
  assert.ok(sweepWouldScan(w.issues.t1), "before the wait the issue is one the sweep scans");
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "backlog");
  assert.ok(!sweepWouldScan(w.issues.t1), "an armed wait's issue is never in the sweep's eligible set");
  assert.deepEqual(w.writes.map((x) => [x.task, x.body.status]), [["t1", "backlog"]]);
  assert.match(w.writes[0].body.comment, /<!-- aidenhq:job=kernel kind=wait-park -->/);
  // The holder pauses while the wait is armed (the live repro).
  w.agents[AGENT] = { ...w.agents[AGENT], status: "paused", lifecycleHolds: ["manual"] };
  w.tick(MIN);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "already parked: nothing written");
  assert.equal(w.issues.t1.status, "backlog");
  // A restore puts it back in todo: parked again, once.
  w.issues.t1 = { ...w.issues.t1, status: "in_progress" };
  assert.deepEqual(await w.idle.settle(), { parked: ["t1"], resumed: [], resolved: [] });
  assert.equal(w.issues.t1.status, "backlog");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "idempotent");
  assert.equal(w.writes.filter((x) => x.body.status === "backlog").length, 2, "one park, then one re-park after the restore");
});

test("a wake ends the wait and reconciles the issue exactly once (backlog → in_progress, never todo: no second dispatch)", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 61 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "backlog");
  w.tick(62 * MIN);
  // The wait's wake is claimed: the pass restores the issue once.
  assert.deepEqual(w.wakes.claim("dispatch").map((r) => [r.task, r.cause]), [["t1", "wait: PR #12 merges"]]);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
  assert.deepEqual(w.writes.filter((x) => x.body.status === "in_progress").map((x) => x.task), ["t1"]);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "a re-run writes nothing");
  assert.equal(w.writes.filter((x) => x.body.status === "in_progress").length, 1, "exactly one reconcile");
  // todo would be Paperclip's own status-wake path (a second job): the restore never writes it.
  assert.ok(!w.writes.some((x) => x.body.status === "todo"));
});

test("a cancelled wait (its wake dropped by a dispatcher, or replaced by a superseding wait) reconciles once", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "backlog");
  w.wakes.open({ key: "comment:c1", task: "t1", agent: AGENT, cause: "comment" });
  w.wakes.drop("dispatch", w.wakes.claim("dispatch")[0].key, "another agent's comment");
  assert.equal(w.issues.t1.status, "backlog", "the wait is still armed");
  // A superseding wait replaces the first: the issue stays parked, the row remembers the restore.
  w.tick(MIN);
  const until2 = new Date(w.now() + 3 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the reviewer answers", until: until2 });
  assert.equal(w.issues.t1.status, "backlog");
  // The second wait is cancelled outright: its wake goes, and the pass restores the issue once.
  assert.deepEqual(w.wakes.claim("dispatch"), [], "not due");
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1' AND key LIKE 'wait:%'").run();
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
});

test("a wait on a task with no wait to restore for stays parked until its holder is invokable again", async (t) => {
  const w = world(t);
  // A paused holder: the wait's wake is dropped with no restore (the holder can't run it).
  w.agents[AGENT] = { ...w.agents[AGENT], status: "paused", lifecycleHolds: ["manual"] };
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the owner unpauses me", until });
  assert.equal(w.issues.t1.status, "backlog");
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1' AND key LIKE 'wait:%'").run();
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "restoring work to a paused holder is the loop this fixes");
  w.agents[AGENT] = { ...w.agents[AGENT], status: "idle", lifecycleHolds: [] };
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
});

test("a stale stranded_assigned_issue hold is resolved once through recovery-actions/resolve, and parked again if the wait is armed", async (t) => {
  const w = world(t);
  // The live symptom: Paperclip blocked the task, left its hold, and the agent re-armed its wait.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-1", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  w.db.prepare("INSERT OR REPLACE INTO wakes (key, task, agent, cause, at, state) VALUES (?, 't1', ?, 'wait: x', ?, 'open')").run(`wait:t1:${Date.parse(until)}`, AGENT, Date.parse(until));
  // Its own park row is what makes the hold the kernel's to release.
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'todo', ?)").run(AGENT, w.now());
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] });
  assert.deepEqual(w.resolved.map((r) => [r.task, r.body.actionId, r.body.outcome, r.body.sourceIssueStatus]), [["t1", "ra-1", "restored", "todo"]]);
  assert.equal(w.issues.t1.status, "backlog", "resolved, then parked again at once: never dropped back into the sweep");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "one pass, no retry loop");
  assert.equal(w.resolved.length, 1);
});

test("a hold released while the wait is still armed keeps a review task's origin: its wake returns it to review, not to fresh work", async (t) => {
  const w = world(t);
  // A review task whose wait is armed through the release: a row from the issue (`todo`) would lose `in_review`.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-7", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  w.db.prepare("INSERT OR REPLACE INTO wakes (key, task, agent, cause, at, state) VALUES (?, 't1', ?, 'wait: x', ?, 'open')").run(`wait:t1:${Date.parse(until)}`, AGENT, Date.parse(until));
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'in_review', ?)").run(AGENT, w.now());
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] });
  assert.equal(w.issues.t1.status, "backlog", "released, then parked again: the wait is still armed");
  assert.deepEqual(w.parks().map((r) => [r.task, r.from_status]), [["t1", "in_review"]], "the origin survives the re-park");
  // The wait ends: back to review, never in_progress (which restarts the work) and never todo.
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1' AND key LIKE 'wait:%'").run();
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_review");
  assert.deepEqual(w.parks(), []);
});

test("an errored holder is not restored into: the task stays parked until it is idle again", async (t) => {
  const w = world(t);
  // The pinned sweep counts `error` invokable; this restores into a failing holder only once it is idle again.
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the retry window", until });
  assert.equal(w.issues.t1.status, "backlog");
  w.agents[AGENT] = { ...w.agents[AGENT], status: "error", lifecycleHolds: [] };
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1' AND key LIKE 'wait:%'").run();
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "not restored into a failing holder");
  assert.equal(w.issues.t1.status, "backlog");
  assert.deepEqual(w.parks().map((r) => r.task), ["t1"], "the row is what restores it once it can");
  w.agents[AGENT] = { ...w.agents[AGENT], status: "idle" };
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
  assert.deepEqual(w.parks(), []);
});

test("a hold that cannot be released yet keeps its row, and the first pass that can releases it and moves on", async (t) => {
  const w = world(t);
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-2", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  w.agents[AGENT] = { ...w.agents[AGENT], status: "paused", lifecycleHolds: ["manual"] };
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'todo', ?)").run(AGENT, w.now());
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.equal(w.resolved.length, 0, "resolving would drop it straight back into the sweep");
  assert.equal(w.issues.t1.status, "blocked");
  // The reconciliation has not happened, so the row stays for the next pass.
  assert.deepEqual(w.parks().map((r) => r.task), ["t1"], "the row is kept: the retry is the next pass's");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.equal(w.resolved.length, 0, "no call while releasing it is still unsafe");
  assert.deepEqual(w.parks().map((r) => r.task), ["t1"]);
  // The holder is invokable again: the kept row releases the hold and finishes the move, once.
  w.agents[AGENT] = { ...w.agents[AGENT], status: "idle", lifecycleHolds: [] };
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] });
  assert.deepEqual(w.resolved.map((r) => [r.task, r.body.actionId]), [["t1", "ra-2"]]);
  assert.equal(w.issues.t1.status, "in_progress", "released and moved on in the same pass: never left in todo");
  assert.deepEqual(w.parks(), [], "the reconciliation happened, so the row goes");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "exactly once");
  // A hold of another cause is never the loop's: the row goes.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-3", cause: "provider_quota", status: "active", ownerType: "board" } };
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'todo', ?)").run(AGENT, w.now());
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.equal(w.resolved.length, 1);
  assert.deepEqual(w.parks(), [], "not ours to reconcile: nothing to keep a park row for");
});

test("a release that lands while the wait ends and the holder is paused keeps the task parked, and restores it once it is invokable", async (t) => {
  const w = world(t);
  // The wait is armed at read (the hold is released), ends mid-release, and the holder is paused at the restore.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-6", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  w.db.prepare("INSERT OR REPLACE INTO wakes (key, task, agent, cause, at, state) VALUES (?, 't1', ?, 'wait: x', ?, 'open')").run(`wait:t1:${Date.parse(until)}`, AGENT, Date.parse(until));
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'in_review', ?)").run(AGENT, w.now());
  w.dropWaitOnResolve(true);
  w.agents[AGENT] = { ...w.agents[AGENT], status: "paused", lifecycleHolds: ["manual"] };
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] });
  assert.deepEqual(w.resolved.map((r) => [r.task, r.body.actionId]), [["t1", "ra-6"]]);
  assert.equal(w.issues.t1.status, "backlog", "the release left it in todo: parked again, never restored to a paused holder");
  // The row keeps the origin, so a review task is not restarted as progress.
  assert.deepEqual(w.parks().map((r) => [r.task, r.from_status]), [["t1", "in_review"]]);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "still paused: nothing restored");
  // The holder is invokable again: the row restores it, once, to where it came from.
  w.agents[AGENT] = { ...w.agents[AGENT], status: "idle", lifecycleHolds: [] };
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_review", "back to review, not in_progress: the work is not restarted");
  assert.deepEqual(w.parks(), []);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "exactly once");
});

test("a release that lands but answers with an error is finished in the same pass; one that did not keeps its row", async (t) => {
  const w = world(t);
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-4", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'todo', ?)").run(AGENT, w.now());
  // The release applies, then the answer is lost (a 504).
  w.refuseResolveAfterApply(true);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] }, "the re-read proves it landed, so it is finished");
  assert.equal(w.issues.t1.status, "in_progress", "never left in the todo the release landed it in");
  assert.deepEqual(w.parks(), [], "nothing left to reconcile");
  // The same failure with the release not applied: the row stays.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-5", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'todo', ?)").run(AGENT, w.now());
  w.refuseResolveAfterApply(false);
  w.down(true);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.deepEqual(w.parks().map((r) => r.task), ["t1"], "the answer was an error and the re-read could not say otherwise");
  w.down(false);
  assert.equal(w.issues.t1.status, "blocked");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] }, "the kept row is what releases it now");
  assert.equal(w.issues.t1.status, "in_progress");
  assert.deepEqual(w.parks(), []);
});

test("a park the control plane refuses leaves no row, and the next pass parks it instead of restoring it", async (t) => {
  const w = world(t);
  w.refusePatch("backlog");
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "todo", "the failed park changed nothing");
  assert.deepEqual(w.parks(), [], "no row for a park that never happened");
  // The wait is armed: the next pass tries the park again.
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "still refused");
  assert.deepEqual(w.parks(), []);
  assert.equal(w.issues.t1.status, "todo", "never restored off a park that never happened (todo is not a restore target anyway)");
  w.refusePatch(undefined);
  assert.deepEqual(await w.idle.settle(), { parked: ["t1"], resumed: [], resolved: [] });
  assert.equal(w.issues.t1.status, "backlog");
  assert.deepEqual(w.parks().map((r) => [r.task, r.agent]), [["t1", AGENT]], "the row exists only now that the issue is parked");
  // With the row in place the restore lands once, on the wake.
  w.tick(3 * 60 * MIN);
  assert.deepEqual(w.wakes.claim("dispatch").map((r) => r.task), ["t1"]);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
});

test("a crash between the park's PATCH and its row is recovered: an armed backlog task with no row is adopted, restored once", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "backlog");
  // The park landed but the kernel died before recording it.
  w.db.prepare("DELETE FROM wait_parks").run();
  assert.deepEqual(w.parks(), []);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "adopted, not written: nothing to change on the issue");
  assert.deepEqual(w.parks().map((r) => [r.task, r.agent]), [["t1", AGENT]], "the next pass takes the park back");
  assert.equal(w.writes.filter((x) => x.body.status === "backlog").length, 1, "a review of the parked task writes no second park");
  // It settles as any parked wait does: once, never to todo.
  w.tick(3 * 60 * MIN);
  assert.deepEqual(w.wakes.claim("dispatch").map((r) => r.task), ["t1"]);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
  assert.deepEqual(w.parks(), []);
});

test("a task the sweep blocked before the park landed is released once, because its own wait is armed", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  // Paperclip's tick won the race before the park's PATCH: no row says the block was ours.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-9", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  w.db.prepare("DELETE FROM wait_parks").run();
  w.writes.length = 0;
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] });
  assert.deepEqual(w.resolved.map((r) => [r.task, r.body.actionId]), [["t1", "ra-9"]]);
  assert.equal(w.issues.t1.status, "backlog", "released and parked again in the same pass: never left in the sweep's set");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "one pass, no retry loop");
  assert.equal(w.resolved.length, 1);
  // A hold on a task with no row and no armed wait is still the board's: not touched.
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1'").run();
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-10", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  w.db.prepare("DELETE FROM wait_parks").run();
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.equal(w.resolved.length, 1);
  assert.equal(w.issues.t1.status, "blocked");
});

test("a park records its row before the issue write: no crash can leave a parked issue unrecorded", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  const park = w.seen.find((x) => x.status === "backlog");
  assert.ok(park, "the park was written");
  assert.deepEqual(park.rows, ["t1"], "the row existed when the PATCH was issued, not after it");
  // A refused write whose parked state is nevertheless there (a proxy that applied it and lost the answer) keeps its row.
  w.issues.t1 = { ...w.issues.t1, status: "in_progress" };
  w.db.prepare("DELETE FROM wait_parks").run();
  w.refusePatch("backlog");
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.deepEqual(w.parks().map((r) => r.task), [], "the park did not land, so its row is rolled back");
});

test("an in_review task the sweep's review branch would block is parked, and restored to in_review once", async (t) => {
  const w = world(t);
  // The one in_review shape 2026.1106.0 escalates: a pending execution-review participant held by an agent (service.ts:5097);
  // with no participant it skips instead. This is a task whose wait outlived its run into review.
  w.issues.t1 = { ...w.issues.t1, status: "in_review", executionState: { status: "pending", currentParticipant: { type: "agent", agentId: AGENT } } };
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the reviewer answers", until });
  assert.equal(w.issues.t1.status, "backlog", "outside every status the pinned sweep scans");
  assert.deepEqual(w.parks().map((r) => [r.task, r.from_status]), [["t1", "in_review"]], "the park remembers it came from review");
  // A comment or a manual restore puts it back in review while it still waits: parked again, not left in the sweep's set.
  w.issues.t1 = { ...w.issues.t1, status: "in_review" };
  assert.deepEqual(await w.idle.settle(), { parked: ["t1"], resumed: [], resolved: [] });
  assert.equal(w.issues.t1.status, "backlog");
  // The wait ends (woken by the answer): it goes back to review, never to in_progress (which would restart the work) or todo.
  w.tick(3 * 60 * MIN);
  assert.deepEqual(w.wakes.claim("dispatch").map((r) => r.task), ["t1"]);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_review");
  assert.deepEqual(w.writes.filter((x) => x.body.status === "in_progress"), [], "a review task is never resumed as work");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "exactly once");
});

test("an in_review task the sweep skips is never parked: the finish gate holds it in review", async (t) => {
  const w = world(t);
  // checks.ts holds a task in review under its check's label so the finish gate can decide it; with no pending execution-review
  // participant the pinned sweep's review branch skips (service.ts:5098-5101), so there is nothing to park it out of.
  w.issues.t1 = { ...w.issues.t1, status: "in_review" };
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the reviewer answers", until });
  assert.equal(w.issues.t1.status, "in_review", "the gate's hold is not cut");
  assert.deepEqual(w.parks(), [], "nothing parked: no row");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.equal(w.issues.t1.status, "in_review");
  // The gate's own monitor is the same case: never parked either.
  w.issues.t1 = { ...w.issues.t1, monitorNextCheckAt: new Date(w.now() + 60 * MIN).toISOString(), executionState: { status: "pending", currentParticipant: { type: "agent", agentId: AGENT } } };
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.equal(w.issues.t1.status, "in_review");
  assert.deepEqual(w.parks(), []);
});

test("an adopted park of a task that came from review goes back to in_review, from the fact log", async (t) => {
  const w = world(t);
  // A review-participant task whose park landed but whose row was lost.
  w.issues.t1 = { ...w.issues.t1, status: "in_review", executionState: { status: "pending", currentParticipant: { type: "agent", agentId: AGENT } } };
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the reviewer answers", until });
  w.db.prepare("DELETE FROM wait_parks").run();
  w.add("task.status_changed", "task:t1", "t1", { from: "in_progress", to: "in_review" });
  // The park's own write is a status fact too, and it is the newest one: the adoption has to look past it.
  w.tick(MIN);
  w.add("task.status_changed", "task:t1", "t1", { from: "in_review", to: "backlog" });
  const newest = w.db.prepare("SELECT data FROM facts WHERE subject = 'task:t1' AND type = 'task.status_changed' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(newest.data).to, "backlog", "the history really is: in_review, then our own park");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.deepEqual(w.parks().map((r) => [r.task, r.from_status]), [["t1", "in_review"]], "the fact log says where it came from, past our own park");
  w.tick(3 * 60 * MIN);
  assert.deepEqual(w.wakes.claim("dispatch").map((r) => r.task), ["t1"]);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_review", "not resumed as fresh work");
});

test("a park whose outcome is unknown keeps its row, so a task that did land is still reconciled once its wait ends", async (t) => {
  const w = world(t);
  // The reviewer's case: the PATCH lands on the control plane but answers with an error, and the confirming read fails too.
  w.refusePatch("backlog");
  w.refuseAfterApply(true);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "backlog", "the write landed against the control plane");
  assert.deepEqual(w.parks().map((r) => [r.task, r.from_status]), [["t1", "todo"]], "the row is kept: the outcome was unknown, not a miss");
  // The wait ends before any other pass could adopt the issue: the kept row is what still selects it, and it restores once.
  w.refusePatch(undefined);
  w.refuseAfterApply(false);
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1' AND key LIKE 'wait:%'").run();
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress", "never left parked with nothing to reconcile it");
  assert.deepEqual(w.parks(), []);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "exactly once");
});

test("a park confirmed not to have landed drops its row, and the armed wait parks it again", async (t) => {
  const w = world(t);
  // The write is refused and the read that confirms it succeeds: the row goes, and the retry parks the task.
  w.refusePatch("backlog");
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "todo", "nothing was parked");
  assert.deepEqual(w.parks(), [], "the read confirmed the miss, so the row goes");
  w.refusePatch(undefined);
  assert.deepEqual(await w.idle.settle(), { parked: ["t1"], resumed: [], resolved: [] });
  assert.equal(w.issues.t1.status, "backlog");
});

test("a comment or status restore is re-parked from the task's own event, not at the next settle tick", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "backlog");
  // A supported comment or a status restore lands the task back in a scanned status, and Paperclip reports it at once.
  w.issues.t1 = { ...w.issues.t1, status: "in_progress" };
  await w.idle.settleOne(w.issues.t1);
  assert.equal(w.issues.t1.status, "backlog", "parked again in the same breath: no window for the sweep's tick");
  // The park's own write emits an issue.updated too: reconciling it again must settle on the first pass and write nothing.
  const before = w.writes.length;
  await w.idle.settleOne(w.issues.t1);
  assert.equal(w.writes.length, before, "the park's own event is a no-op, never a loop");
  // A task with neither an armed wait nor a row is not this pass's: a re-run writes nothing.
  w.issues.t2 = { ...w.issues.t2, status: "in_progress" };
  await w.idle.settleOne(w.issues.t2);
  assert.equal(w.issues.t2.status, "in_progress");
  assert.deepEqual(w.writes.filter((x) => x.task === "t2"), []);
  // And a task whose wait already ended is restored by its own event too, without waiting for the timer.
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1' AND key LIKE 'wait:%'").run();
  await w.idle.settleOne(w.issues.t1);
  assert.equal(w.issues.t1.status, "in_progress");
  assert.deepEqual(w.parks(), []);
  assert.equal(w.writes.filter((x) => x.task === "t1" && x.body.status === "in_progress").length, 1, "exactly once");
});

test("an adopted park whose only status fact is our own backlog goes back to in_progress, not to review", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  w.db.prepare("DELETE FROM wait_parks").run();
  // A task that started in backlog and was parked from todo: the newest status facts are the park's own writes, and none of
  // them was a review, so it resumes as work.
  for (const [from, to] of [["todo", "backlog"], ["backlog", "backlog"]]) { w.add("task.status_changed", "task:t1", "t1", { from, to }); w.tick(MIN); }
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.deepEqual(w.parks().map((r) => [r.task, r.from_status]), [["t1", "in_progress"]]);
  w.tick(3 * 60 * MIN);
  w.wakes.claim("dispatch");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
});

// ---- The reconcile pass after a code review (WOR-9033): three ways a parked wait could settle wrong ----

test("a re-park records where the task came from now, not from the first park: a review task restored to in_review", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  // Parked as work first, then put back in review by a person while the wait is still armed.
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "the reviewer answers", until });
  assert.deepEqual(w.parks().map((r) => [r.task, r.from_status]), [["t1", "todo"]]);
  w.issues.t1 = { ...w.issues.t1, status: "in_review", executionState: { status: "pending", currentParticipant: { type: "agent", agentId: AGENT } } };
  assert.deepEqual(await w.idle.settle(), { parked: ["t1"], resumed: [], resolved: [] });
  // The row remembers the status it was parked out of the second time: the wait's end returns it to review, not to fresh work.
  assert.deepEqual(w.parks().map((r) => [r.task, r.from_status]), [["t1", "in_review"]]);
  w.tick(3 * 60 * MIN);
  assert.deepEqual(w.wakes.claim("dispatch").map((r) => r.task), ["t1"]);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_review");
  assert.deepEqual(w.writes.filter((x) => x.body.status === "in_progress"), [], "never resumed as work");
});

test("a restore asks the task's current holder, not the one it was parked under", async (t) => {
  const w = world(t);
  const paused = { id: "a-2", companyId: "co", status: "paused", lifecycleHolds: ["manual"], reportsTo: null };
  w.agents[paused.id] = paused;
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  // Reassigned while it waits, to an agent that is not invokable: restoring it would put the sweep straight back on it.
  w.issues.t1 = { ...w.issues.t1, assigneeAgentId: paused.id };
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1' AND key LIKE 'wait:%'").run();
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "the current holder is not invokable");
  assert.equal(w.issues.t1.status, "backlog");
  // Once that holder can run it, the same row restores it — once.
  w.agents[paused.id] = { ...paused, status: "idle", lifecycleHolds: [] };
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
  assert.deepEqual(w.parks(), []);
});

test("a hold released after the wait ended leaves the task in progress, never in the todo the sweep scans", async (t) => {
  const w = world(t);
  // The loop's own block: a hold left behind while its wait was armed, and the wait gone by the time the pass reads it.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-11", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'todo', ?)").run(AGENT, w.now());
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] });
  assert.deepEqual(w.resolved.map((r) => [r.task, r.body.actionId]), [["t1", "ra-11"]]);
  assert.equal(w.issues.t1.status, "in_progress", "the resolve lands in todo; the same pass moves it on, as every restore does");
  assert.notEqual(w.issues.t1.status, "todo", "never todo: Paperclip's move there files a status wake, a second dispatch");
  assert.deepEqual(w.parks(), [], "the row goes: nothing left to reconcile");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "one pass, no retry loop");
  assert.equal(w.resolved.length, 1);
});

test("a read that fails does not drop the park row: a parked task is never stranded in backlog", async (t) => {
  const w = world(t);
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  await w.idle.wait({ agent: AGENT, key: "eng", task: "t1" }, { reason: "PR #12 merges", until });
  assert.equal(w.issues.t1.status, "backlog");
  // The control plane goes down for one pass: `issue` answers undefined, which is "unknown", never "gone".
  w.down(true);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] });
  assert.deepEqual(w.parks().map((r) => r.task), ["t1"], "the row is kept: a failed read proves nothing");
  w.down(false);
  // The wait ends while it was unreadable: the row that survived is what still selects it, and it restores once.
  w.db.prepare("UPDATE wakes SET state = 'dropped' WHERE task = 't1' AND key LIKE 'wait:%'").run();
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress");
  assert.deepEqual(w.parks(), []);
});

test("a follow-up PATCH that fails after the resolve keeps the row, so the next pass finishes the move out of todo", async (t) => {
  const w = world(t);
  // The loop's own block, its wait gone: the hold is released, which lands the issue in `todo`, and the move on from there
  // is the rest of that pass's work. A control plane that fails only that PATCH is the gap the reviewer named.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-12", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  w.db.prepare("INSERT OR REPLACE INTO wait_parks (task, agent, from_status, at) VALUES ('t1', ?, 'todo', ?)").run(AGENT, w.now());
  w.refusePatch("in_progress");
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: ["t1"] }, "the hold was released");
  assert.equal(w.issues.t1.status, "todo", "the resolve landed it in todo; the move on failed");
  assert.deepEqual(w.parks().map((r) => r.task), ["t1"], "the row stays: the issue is still in a status the sweep scans");
  // The failure passes: the next pass finishes the transition, then the row goes.
  w.refusePatch(undefined);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress", "never left in todo: no second dispatch beside the wait's");
  assert.deepEqual(w.parks(), []);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "exactly once");
});

test("a hold released with no row and the wait ending mid-pass: the row is recorded before the move, so a failed PATCH retries", async (t) => {
  const w = world(t);
  // A task blocked before any row existed, its wait gone by the time the resolve landed it in `todo`.
  w.issues.t1 = { ...w.issues.t1, status: "blocked", activeRecoveryAction: { id: "ra-13", cause: "stranded_assigned_issue", status: "active", ownerType: "board" } };
  const until = new Date(w.now() + 2 * 60 * MIN).toISOString();
  w.db.prepare("INSERT OR REPLACE INTO wakes (key, task, agent, cause, at, state) VALUES (?, 't1', ?, 'wait: x', ?, 'open')").run(`wait:t1:${Date.parse(until)}`, AGENT, Date.parse(until));
  // The wait ends mid-resolve and the follow-up PATCH fails.
  w.dropWaitOnResolve(true);
  w.refusePatch("in_progress");
  await w.idle.settle();
  // Never `todo` with no row: the row was recorded before the hold was resolved.
  assert.equal(w.issues.t1.status, "todo", "the resolve landed it in todo; the move on failed");
  assert.deepEqual(w.parks().map((r) => r.task), ["t1"], "the retryable state is recorded before the move");
  // The next pass finishes it, then the row goes.
  w.refusePatch(undefined);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: ["t1"], resolved: [] });
  assert.equal(w.issues.t1.status, "in_progress", "never left in the todo the sweep scans");
  assert.deepEqual(w.parks(), []);
  assert.deepEqual(await w.idle.settle(), { parked: [], resumed: [], resolved: [] }, "exactly once");
});

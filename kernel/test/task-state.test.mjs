// A task's one state from its facts (task-state.ts): closure, unresolved failure, obligations, stage hints and attention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { taskState } from "../src/task-state.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";

const STAGES = [...KERNEL_STAGES, { name: "ci", label: "CI running", from: "pr.checks_started", to: "pr.checks_completed", module: "github" }];
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const MIN = 60_000;
const iso = (m) => new Date(T0 + m * MIN).toISOString();
let seq = 0;
/** One fact on t1 at minute `m` (seen then too); `o` overrides any field (task, subject, version, seen_at, seq). */
const f = (type, m, data = {}, actor = "kernel", o = {}) => {
  seq++;
  const subject = o.subject ?? "task:t1";
  return { seq, id: `${type}:${subject}:${seq}`, type, subject, version: String(seq), at: iso(m), seen_at: iso(m), actor, task: "t1", source: "live", data, ...o };
};
const created = (m = 0, data = {}) => f("task.created", m, { parent: null, identifier: "WOR-1", ...data });
const status = (to, m, from = "in_progress") => f("task.status_changed", m, { from, to });
const assignee = (to, m) => f("task.assignee_changed", m, { from: null, to });
const job = (type, m, data = {}, id = "j1") => f(type, m, data, "agent:kai", { subject: `job:${id}` });
const wait = (reason, m, data = {}) => f("work.waiting", m, { reason, note: "n", until: iso(m + 7 * 24 * 60), ...data }, "agent:kai", { subject: "wait:t1" });
const card = (k, m, state = "owner") => f("record.filed", m, { kind: "push", tier: 2, state }, "agent:kai", { subject: `record:${k}` });
const comment = (actor, m, o = {}) => f("task.commented", m, { kind: "comment" }, actor, o);
const stageOpen = (m) => f("pr.checks_started", m, {}, "module:github", { subject: "pr:acme/x#1", version: `github/${m}` });
const grade = (pass, attempt, m) => f("grade.verdict", m, { pass, attempt }, "module:grading", { subject: `grade:t1:${attempt}`, version: `grading/${attempt}` });

const NOW = 30;
/** got matches want: `attention` exactly (each item partially), a function as a predicate, anything else deep-equal. */
function check(got, want) {
  for (const [k, v] of Object.entries(want)) {
    if (k === "attention") {
      assert.equal(got.attention.length, v.length, `attention ${JSON.stringify(got.attention)}`);
      v.forEach((a, i) => assert.partialDeepStrictEqual(got.attention[i], a));
    } else if (typeof v === "function") assert.ok(v(got[k]), `${k}: ${JSON.stringify(got[k])}`);
    else assert.deepStrictEqual(got[k], v, k);
  }
}
const not = (x) => (v) => v !== x;

const cases = [
  ["closed beats an open card and a wait", [created(), wait("owner_wait", 1), card("k1", 2), status("done", 3)], NOW, { kind: "done", reason: "closed", since: iso(3), attention: [] }],
  ["cancelled is done", [created(), status("cancelled", 3)], NOW, { kind: "done", reason: "cancelled" }],
  ["reopened starts fresh", [created(), card("k1", 1), status("done", 2), status("todo", 3, "done"), job("job.started", 4)], NOW, { kind: "working", reason: "job_running", attention: [] }],
  ["a failure stays through comments", [created(), assignee("kai", 0), job("job.ended", 1, { state: "failed" }), comment("account:o1", 2)], NOW,
    { kind: "idle", reason: "failed", ref: "job:j1", since: iso(1), attention: [{ who: "agent", why: "failed", ref: "job:j1" }] }],
  ["a retry clears the failure", [created(), job("job.ended", 1, { state: "timeout" }), job("job.queued", 2, {}, "j2")], NOW, { kind: "waiting", reason: "job_queued", attention: [] }],
  ["a cancelled job is not a failure", [created(), job("job.ended", 1, { state: "cancelled" })], 5, { kind: "idle", reason: "orphaned" }],
  ["a stage hint never hides a failure", [created(), stageOpen(1), job("job.ended", 2, { state: "lost" })], NOW, { kind: "idle", reason: "failed", stage: undefined }],
  ["a failure is attention while something else waits", [created(), job("job.ended", 1, { state: "failed" }), wait("owner_wait", 2, { question: "keep v1?" })], NOW,
    { kind: "waiting", reason: "owner_wait", attention: [{ who: "owner", why: "owner_wait" }, { who: "agent", why: "failed" }] }],
  ["a hint names a running job's stage", [created(), job("job.started", 1), stageOpen(2)], NOW, { kind: "working", stage: "CI running" }],
  ["a hint older than a day is gone", [created(), job("job.started", 1), stageOpen(2)], 2 + 25 * 60, { kind: "working", stage: undefined }],
  ["a kernel wait is no stage hint", [created(), wait("owner_wait", 1)], NOW, { kind: "waiting", stage: undefined }],
  ["working and needs the owner", [created(), card("k1", 1), job("job.started", 2)], NOW, { kind: "working", attention: [{ who: "owner", why: "card", ref: "record:k1" }] }],
  ["a card with the reviewer", [created(), card("k1", 1, "review")], NOW, { kind: "waiting", reason: "card_review", attention: [{ who: "reviewer", why: "card" }] }],
  ["a card the reviewer escalates is the owner's from then", [created(), card("k1", 1, "review"), f("record.decided", 4, { decision: "owner", decider: "reviewer" }, "module:ai-reviewer", { subject: "record:k1" })], NOW,
    { reason: "card_owner", since: iso(4), attention: [{ who: "owner", why: "card" }] }],
  ["an approved card is no longer open", [created(), card("k1", 1), f("record.decided", 2, { decision: "approved", decider: "owner" }, "account:o1", { subject: "record:k1" })], 5, { kind: "idle", attention: [] }],
  ["an owner wait survives a job start", [created(), wait("owner_wait", 1, { question: "keep v1?" }), job("job.started", 2), job("job.ended", 3, { state: "done" })], NOW,
    { kind: "waiting", reason: "owner_wait", question: "keep v1?", attention: [{ who: "owner", why: "owner_wait", ref: "wait:t1" }] }],
  ["an older owner comment never ends a newer wait", [created(), wait("owner_wait", 2), comment("account:o1", 1)], NOW, { reason: "owner_wait" }],
  ["the owner's next comment ends the wait", [created(), wait("owner_wait", 1, { question: "q" }), comment("account:o1", 2)], NOW, { reason: not("owner_wait"), question: undefined }],
  ["an agent comment is not an answer", [created(), wait("owner_wait", 1), comment("agent:kai", 2)], NOW, { reason: "owner_wait" }],
  ["a delegator wait ends at another's comment, not the holder's", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:kai", 2)], NOW,
    { reason: "delegator_wait", attention: [{ who: "agent", why: "delegator_wait" }] }],
  ["a delegator's answer ends the delegator wait", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:aiden", 2)], NOW, { reason: not("delegator_wait") }],
  ["an agent wait ends at its time", [created(), wait("agent_wait", 1, { until: iso(20) })], 10, { kind: "waiting", reason: "agent_wait" }],
  ["an agent wait is over after its time", [created(), wait("agent_wait", 1, { until: iso(20) })], 21, { reason: not("agent_wait") }],
  ["handed to the owner", [created(), assignee("owner", 1)], NOW, { kind: "waiting", reason: "handback", holder: "owner", attention: [{ who: "owner", why: "handback" }] }],
  ["blocked while its blocker is open", [created(), f("task.blocked_changed", 1, { blocked_by: ["t2"] })], NOW, { kind: "waiting", reason: "blocked", ref: "task:t2" }],
  ["blocked until its blocker closes", [created(), f("task.blocked_changed", 1, { blocked_by: ["t2"] }), f("task.status_changed", 2, { from: "todo", to: "done" }, "kernel", { subject: "task:t2", task: "t2" })], NOW, { reason: not("blocked") }],
  ["children alone never mean waiting", [created(), f("task.created", 1, { parent: "t1" }, "kernel", { subject: "task:t2", task: "t2" })], NOW, { kind: "idle", reason: "orphaned" }],
  ["orphaned needs no attention before 15 min", [created(), assignee("kai", 0)], 10, { kind: "idle", reason: "orphaned", holder: "kai", attention: [] }],
  ["orphaned needs attention past 15 min", [created(), assignee("kai", 0)], 16, { reason: "orphaned", attention: [{ who: "agent", why: "orphaned" }] }],
  ["a wake no job took is unknown", [created(), assignee("kai", 0), f("wake.opened", 1, { cause: "comment" }, "account:o1", { subject: "wake:w1" })], 4 * 60, { kind: "idle", reason: "unknown", attention: [{ why: "unknown" }] }],
  ["a due wake is a queued job until it is bound", [created(), f("wake.opened", 1, { cause: "comment" }, "account:o1", { subject: "wake:w1" })], 5, { kind: "waiting", reason: "job_queued", ref: "wake:w1" }],
  ["a held wake is held", [created(), f("wake.opened", 1, { cause: "comment" }, "account:o1", { subject: "wake:w1" }), f("job.held", 2, { reason: "max_parallel" }, "agent:kai", { subject: "wake:w1" })], 5 * 60,
    { kind: "waiting", reason: "job_held", ref: "max_parallel" }],
  ["a future wake is scheduled", [created(), f("wake.opened", 90, { cause: "routine" }, "kernel", { subject: "wake:w1", seen_at: iso(1) })], NOW, { kind: "waiting", reason: "scheduled", since: iso(1) }],
  ["backlog waits", [created(), status("backlog", 1, null)], NOW, { kind: "waiting", reason: "backlog", attention: [] }],
  ["chat after a reply", [created(0, { chat: true }), job("job.ended", 1, { state: "done" })], 120, { kind: "waiting", reason: "chat_turn", attention: [] }],
  ["history expired", [status("todo", 1)], NOW, { kind: "idle", reason: "history_expired", attention: [{ who: "agent", why: "history_expired" }] }],
  ["done with its final grade", [created(), grade(false, 1, 1), grade(true, 2, 2), status("done", 3)], NOW, { kind: "done", grade: "pass" }],
  ["since is when the reason and ref began", [created(), card("k1", 1), card("k2", 5)], NOW,
    { reason: "card_owner", ref: "record:k1", since: iso(1), attention: [{ why: "card", ref: "record:k1" }, { why: "card", ref: "record:k2" }] }],
];
for (const [name, rows, now, want] of cases) test(name, () => check(taskState("t1", rows, T0 + now * MIN, STAGES), want));

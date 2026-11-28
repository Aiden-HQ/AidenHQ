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
const prWait = (reason, m, o = {}) => f("work.waiting", m, { reason }, "module:github", { subject: "pr:acme/x#1", version: `github/w${m}`, ...o });
const prResumed = (m) => f("work.resumed", m, { reason: "checks" }, "module:github", { subject: "pr:acme/x#1", version: `github/r${m}` });
const card = (k, m, state = "owner") => f("record.filed", m, { kind: "push", tier: 2, state }, "agent:kai", { subject: `record:${k}` });
const comment = (actor, m, o = {}) => f("task.commented", m, { kind: "comment" }, actor, o);
const stageOpen = (m) => f("pr.checks_started", m, {}, "module:github", { subject: "pr:acme/x#1", version: `github/${m}` });

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

type Polled = (agent: string) => boolean;
/** Whether an enabled dispatcher runs the agent: every case's does unless it names otherwise (a task nobody polls). */
const POLLED: Polled = () => true, UNPOLLED: Polled = () => false;
const cases = [
  ["closed beats an open card and a wait", [created(), wait("owner_wait", 1), card("k1", 2), status("done", 3)], NOW, { kind: "done", reason: "closed", since: iso(3), attention: [] }],
  ["cancelled is done", [created(), status("cancelled", 3)], NOW, { kind: "done", reason: "cancelled" }],
  ["a reopen is when idle began", [created(), assignee("kai", 0), status("done", 2), status("todo", 25, "done")], NOW, { kind: "idle", reason: "orphaned", since: iso(25), attention: [] }],
  ["reopened starts fresh", [created(), card("k1", 1), status("done", 2), status("todo", 3, "done"), job("job.started", 4)], NOW, { kind: "working", reason: "job_running", attention: [] }],
  ["a failure stays through comments", [created(), assignee("kai", 0), job("job.ended", 1, { state: "failed" }), comment("account:o1", 2)], NOW,
    { kind: "idle", reason: "failed", ref: "job:j1", since: iso(1), attention: [{ who: "agent", why: "failed", ref: "job:j1" }] }],
  ["a retry clears the failure", [created(), job("job.ended", 1, { state: "timeout" }), job("job.queued", 2, {}, "j2")], NOW, { kind: "waiting", reason: "job_queued", attention: [] }],
  ["an older cancelled fact (no stopping account field) is not a failure", [created(), job("job.ended", 1, { state: "cancelled" })], 5, { kind: "idle", reason: "orphaned" }],
  // A run the machinery stopped (no account: dispatch's progress judge, a closed task) is an unresolved failure, so it leaves
  // idle · orphaned and the idle sweep stops re-waking it; the owner's own Stop records its account and stays not a failure.
  ["a cancelled job with no stopping account is a failure", [created(), assignee("kai", 0), job("job.ended", 1, { state: "cancelled", stopped_by: null })], 5,
    { kind: "idle", reason: "failed", ref: "job:j1", since: iso(1), attention: [{ who: "agent", why: "failed", ref: "job:j1" }] }],
  ["the owner's Stop is not a failure", [created(), assignee("kai", 0), job("job.ended", 1, { state: "cancelled", stopped_by: "acct-1" })], 5, { kind: "idle", reason: "orphaned" }],
  ["a retry clears a machinery stop's failure", [created(), assignee("kai", 0), job("job.ended", 1, { state: "cancelled", stopped_by: null }), job("job.started", 2, {}, "j2")], NOW, { kind: "working", reason: "job_running" }],
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
  ["a card the code closes (expired, replaced) is no longer open", [created(), card("k1", 1), f("record.decided", 2, { decision: "stale", decider: "code", via: "expired" }, "kernel", { subject: "record:k1" }),
    card("k2", 3), f("record.decided", 4, { decision: "cancelled", decider: "code", via: "replaced" }, "kernel", { subject: "record:k2" })], 5, { kind: "idle", attention: [] }],
  ["an owner wait survives a job start", [created(), wait("owner_wait", 1, { question: "keep v1?" }), job("job.started", 2), job("job.ended", 3, { state: "done" })], NOW,
    { kind: "waiting", reason: "owner_wait", question: "keep v1?", attention: [{ who: "owner", why: "owner_wait", ref: "wait:t1" }] }],
  ["an older owner comment never ends a newer wait", [created(), wait("owner_wait", 2), comment("account:o1", 1)], NOW, { reason: "owner_wait" }],
  ["the owner's next comment ends the wait", [created(), wait("owner_wait", 1, { question: "q" }), comment("account:o1", 2)], NOW, { reason: not("owner_wait"), question: undefined }],
  ["an agent comment is not an answer", [created(), wait("owner_wait", 1), comment("agent:kai", 2)], NOW, { reason: "owner_wait" }],
  ["a delegator wait ends at another's comment, not the holder's", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:kai", 2)], NOW,
    { reason: "delegator_wait", attention: [{ who: "agent", why: "delegator_wait" }] }],
  ["another's comment wake ends a delegator wait (an answer with no comment fact)", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), f("wake.opened", 2, {}, "agent:aiden", { subject: "wake:comment:c1" })], NOW, { reason: not("delegator_wait") }],
  ["an agent's wake-only answer settles the question, so its re-arm is marked", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), f("wake.opened", 2, {}, "agent:aiden", { subject: "wake:comment:c1" }), f("wake.bound", 2, {}, "agent:aiden", { subject: "wake:comment:c1" }), wait("delegator_wait", 3, { question: "q" })], NOW,
    { reason: "delegator_wait", question: "q", ask_settled: true }],
  ["an unrelated job start leaves a delegator wait open", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), job("job.started", 3), job("job.ended", 4, { state: "done" })], NOW, { reason: "delegator_wait" }],
  ["a delegator's answer ends the delegator wait", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:aiden", 2)], NOW, { reason: not("delegator_wait") }],
  ["a delegator wait carries its question, which the ask gate reads", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "which path?" })], NOW,
    { reason: "delegator_wait", question: "which path?", attention: [{ who: "agent", why: "delegator_wait" }] }],
  ["an owner wait carries no question when it has none", [created(), wait("owner_wait", 1)], NOW, { reason: "owner_wait", question: undefined }],
  ["a PR on its checks is waiting, never orphaned", [created(), assignee("kai", 0), job("job.ended", 1, { state: "done" }), prWait("checks", 2)], NOW, { kind: "waiting", reason: "module_wait", ref: "checks", since: iso(2), attention: [] }],
  ["a module wait resumed is over", [created(), assignee("kai", 0), prWait("checks", 2), prResumed(5)], NOW, { reason: not("module_wait") }],
  ["a module wait ends when a job starts", [created(), assignee("kai", 0), prWait("checks", 2), job("job.started", 5)], 6, { kind: "working" }],
  ["a module wait over 6 hours is stalled", [created(), assignee("kai", 0), prWait("eval", 2)], 2 + 7 * 60, { kind: "waiting", reason: "module_wait", ref: "eval", attention: [{ who: "agent", why: "stalled_wait", ref: "eval" }] }],
  ["a task_wait's words are the row's note", [created(), wait("agent_wait", 1, { note: "PR #12 merges" })], 10, { reason: "agent_wait", note: "PR #12 merges" }],
  ["an agent wait ends at its time", [created(), wait("agent_wait", 1, { until: iso(20) })], 10, { kind: "waiting", reason: "agent_wait" }],
  ["an agent wait is over after its time", [created(), wait("agent_wait", 1, { until: iso(20) })], 21, { reason: not("agent_wait") }],
  ["handed to the owner by an agent", [created(), assignee("kai", 0), assignee("owner", 1)], NOW, { kind: "waiting", reason: "handback", holder: "owner", attention: [{ who: "owner", why: "handback" }] }],
  ["the owner's own task needs no attention", [created(), assignee("owner", 1)], NOW, { kind: "waiting", reason: "owner_task", holder: "owner", attention: [] }],
  ["backlog stays backlog whoever holds it", [created(), assignee("kai", 0), assignee("owner", 1), status("backlog", 2)], NOW, { kind: "waiting", reason: "backlog", attention: [] }],
  ["blocked while its blocker is open", [created(), f("task.blocked_changed", 1, { blocked_by: ["t2"] })], NOW, { kind: "waiting", reason: "blocked", ref: "task:t2" }],
  ["blocked until its blocker closes", [created(), f("task.blocked_changed", 1, { blocked_by: ["t2"] }), f("task.status_changed", 2, { from: "todo", to: "done" }, "kernel", { subject: "task:t2", task: "t2" })], NOW, { reason: not("blocked") }],
  ["children alone never mean waiting", [created(), f("task.created", 1, { parent: "t1" }, "kernel", { subject: "task:t2", task: "t2" })], NOW, { kind: "idle", reason: "orphaned" }],
  ["orphaned needs no attention before 15 min", [created(), assignee("kai", 0)], 10, { kind: "idle", reason: "orphaned", holder: "kai", attention: [] }],
  ["orphaned needs attention past 15 min", [created(), assignee("kai", 0)], 16, { reason: "orphaned", attention: [{ who: "agent", why: "orphaned" }] }],
  ["a held task whose agent no enabled dispatcher polls is unpolled, not orphaned", [created(), assignee("kai", 0)], 16, { kind: "idle", reason: "unpolled", holder: "kai", attention: [{ who: "agent", why: "unpolled", ref: "task:t1" }] }, UNPOLLED],
  ["a held task its agent's dispatcher polls stays orphaned", [created(), assignee("kai", 0)], 16, { reason: "orphaned" }, POLLED],
  ["a wake no job took is unknown", [created(), assignee("kai", 0), f("wake.opened", 1, { cause: "comment" }, "account:o1", { subject: "wake:w1" })], 4 * 60, { kind: "idle", reason: "unknown", attention: [{ why: "unknown" }] }],
  ["a due wake is a queued job until it is bound", [created(), f("wake.opened", 1, { cause: "comment" }, "account:o1", { subject: "wake:w1" })], 5, { kind: "waiting", reason: "job_queued", ref: "wake:w1" }],
  ["a held wake is held", [created(), f("wake.opened", 1, { cause: "comment" }, "account:o1", { subject: "wake:w1" }), f("job.held", 2, { reason: "max_parallel" }, "agent:kai", { subject: "wake:w1" })], 5 * 60,
    { kind: "waiting", reason: "job_held", ref: "max_parallel" }],
  ["a future wake is scheduled, with when the earliest is due", [created(), f("wake.opened", 90, { cause: "routine" }, "kernel", { subject: "wake:w1", seen_at: iso(1) }), f("wake.opened", 60, { cause: "routine" }, "kernel", { subject: "wake:w2", seen_at: iso(2) })], NOW, { kind: "waiting", reason: "scheduled", since: iso(1), scheduled_for: iso(60) }],
  ["a delegator wait names the agent its question went to", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q", agent: "a-lead" })], NOW, { reason: "delegator_wait", waits_on: "a-lead" }],
  // A question the task already had answered (the Steward settling it, which is the delegator's call handed on) and the agent
  // re-asking the same one: the wait is that same settled episode, not a new judgement. A new question, or one never answered,
  // carries no mark, so it is raised.
  ["a delegator wait is marked settled when its question was answered and re-armed", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:lead", 2), wait("delegator_wait", 3, { question: "q" })], NOW,
    { kind: "waiting", reason: "delegator_wait", question: "q", wait_since: iso(3), ask_settled: true }],
  ["a settled question re-armed longer than the wait is still the same episode", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:lead", 2), wait("delegator_wait", 3, { question: "q" })], 15 * 60,
    { reason: "delegator_wait", ask_settled: true }],
  ["a new question after an answered one is raised again", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:lead", 2), wait("delegator_wait", 3, { question: "other?" })], NOW,
    { reason: "delegator_wait", question: "other?", ask_settled: undefined }],
  ["a question asked once is not a settled re-ask", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" })], NOW,
    { reason: "delegator_wait", question: "q", ask_settled: undefined }],
  // Told from the question, never from who commented: an answer that ends one wait and a person's status note both leave a
  // re-ask of the same question a re-ask (they open no new ask either, escalate.ask's one-open-ask rule), so neither re-raises it.
  ["a question an agent answered, re-armed, is settled", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:lead", 2), wait("delegator_wait", 3, { question: "q" })], NOW,
    { reason: "delegator_wait", ask_settled: true }],
  ["the holder's own comment is no answer, so nothing is settled", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("agent:kai", 2), wait("delegator_wait", 3, { question: "q" })], NOW,
    { reason: "delegator_wait", ask_settled: undefined }],
  ["a person's status comment ends the wait but settles nothing", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q" }), comment("account:o1", 2), wait("delegator_wait", 3, { question: "q" })], NOW,
    { reason: "delegator_wait", ask_settled: undefined }],
  // A revised draft under the same question is a new ask (escalate.ask refuses the same question with a different detail), so its
  // re-arm is not the settled one: it is raised.
  ["the same question about a revised draft is a new ask", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q", detail: "v1" }), comment("agent:lead", 2), wait("delegator_wait", 3, { question: "q", detail: "v2" })], NOW,
    { reason: "delegator_wait", ask_settled: undefined }],
  ["the same question about the same draft is the settled one", [created(), assignee("kai", 0), wait("delegator_wait", 1, { question: "q", detail: "v1" }), comment("agent:lead", 2), wait("delegator_wait", 3, { question: "q", detail: "v1" })], NOW,
    { reason: "delegator_wait", ask_settled: true }],
  ["backlog waits", [created(), status("backlog", 1, null)], NOW, { kind: "waiting", reason: "backlog", attention: [] }],
  ["a chat's job ended with no agent comment reads failed · no_reply", [created(0, { chat: true }), assignee("kai", 0), job("job.started", 1), job("job.ended", 2, { state: "done", acted: false })], 120,
    { kind: "idle", reason: "failed", ref: "no_reply", since: iso(2), attention: [{ who: "agent", why: "failed", ref: "no_reply" }] }],
  ["a chat's reply within the run clears no_reply", [created(0, { chat: true }), assignee("kai", 0), job("job.started", 1), comment("agent:kai", 2), job("job.ended", 2, { state: "done", acted: false })], 120, { kind: "waiting", reason: "chat_turn" }],
  ["a chat's job that answered NO_REPLY is an answered turn", [created(0, { chat: true }), assignee("kai", 0), job("job.started", 1), job("job.ended", 2, { state: "done", acted: false, no_reply: true })], 120, { kind: "waiting", reason: "chat_turn" }],
  ["no_reply waits out the reply's grace", [created(0, { chat: true }), assignee("kai", 0), job("job.started", 1), job("job.ended", 2, { state: "done", acted: false })], 2.5, { reason: "chat_turn" }],
  ["a failed job outranks a module wait", [created(), assignee("kai", 0), prWait("checks", 1), job("job.ended", 2, { state: "failed" })], NOW, { kind: "idle", reason: "failed", ref: "job:j1" }],
  ["an owner wait's start shows under a running job", [created(), assignee("kai", 0), wait("owner_wait", 1, { question: "q" }), job("job.started", 3)], NOW, { kind: "working", reason: "job_running", wait_since: iso(1), question: "q" }],
  ["chat after a reply", [created(0, { chat: true }), job("job.ended", 1, { state: "done", acted: true })], 120, { kind: "waiting", reason: "chat_turn", attention: [] }],
  ["history expired", [status("todo", 1)], NOW, { kind: "idle", reason: "history_expired", attention: [{ who: "agent", why: "history_expired" }] }],
  ["since is when the reason and ref began", [created(), card("k1", 1), card("k2", 5)], NOW,
    { reason: "card_owner", ref: "record:k1", since: iso(1), attention: [{ why: "card", ref: "record:k1" }, { why: "card", ref: "record:k2" }] }],
];
// The lane (laneOf): read from every obligation, never from the representative reason alone.
const blockedBy = (m, ...ids) => f("task.blocked_changed", m, { blocked_by: ids });
cases.push(
  ["lane: a queued job outranks a blocker's reason, not its lane", [created(), assignee("kai", 0), blockedBy(1, "t2"), job("job.queued", 2)], NOW,
    { kind: "waiting", reason: "job_queued", lane: "blocked", blocker: "task:t2" }],
  ["lane: the owner's card beats a running job", [created(), assignee("kai", 0), job("job.started", 1), card("k1", 2)], NOW, { kind: "working", lane: "needs_you" }],
  ["lane: an owner wait beats a failure", [created(), job("job.ended", 1, { state: "failed" }), wait("owner_wait", 2, { question: "q" })], NOW, { lane: "needs_you" }],
  ["lane: a failure is blocked", [created(), assignee("kai", 0), job("job.ended", 1, { state: "failed" })], NOW, { kind: "idle", reason: "failed", lane: "blocked" }],
  ["lane: an AI review is waiting", [created(), assignee("kai", 0), card("k1", 1, "review")], NOW, { reason: "card_review", lane: "waiting" }],
  ["lane: backlog is idle", [created(), assignee("kai", 0), status("backlog", 1, "todo")], NOW, { reason: "backlog", lane: "idle" }],
  ["lane: closed is done", [created(), status("done", 1)], NOW, { lane: "done" }],
);
for (const [name, rows, now, want, polled] of cases) test(name as string, () => check(taskState("t1", rows as never, T0 + (now as number) * MIN, STAGES, (polled as Polled | undefined) ?? POLLED), want));

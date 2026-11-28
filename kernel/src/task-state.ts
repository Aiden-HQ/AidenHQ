// A task's one state (docs: the task-state spec, §3), computed on read from its facts (facts.ts) by a pure function, so every
// surface shows the same thing and no agent ever types it. Separate from flow.ts: flow explains history over windows, this
// says where one task is now. Rules, in order:
//   1. closed or cancelled → done; closure ends every obligation, and a reopen starts fresh (nothing before it counts again)
//   2. an unresolved failure (the last job failed, timed out or was lost) stays until a retry (a job queued or started), a
//      reassignment or closure; comments never clear it
//   3. open obligations, each counted: a running job; a queued (or due, unbound) or held job; an open card; an owner,
//      delegator or agent wait; a module's wait (a PR on its checks: `module_wait`, its reason as `ref`); a blocker not closed; a
//      scheduled wake; the task handed to the owner by an agent (handback), or the owner's own task (owner_task: held by the
//      owner, never handed from an agent), neither while in backlog; backlog; a chat's turn
//   4. a stage hint (a module's stage open ≤ 24 h) only says what a running job or a wait is doing; it never changes kind,
//      reason or attention
//   5. kind: done > working (a running job) > waiting (any obligation) > idle (failed, else unknown when the last thing was a
//      wake nothing took and someone holds it, else unpolled when no enabled dispatcher runs the holder, else orphaned); with no
//      task.created left (pruned), idle · history_expired
//   6. attention, across every obligation whatever the kind: open cards, owner and delegator waits, a handback, a failure,
//      and unpolled, orphaned or unknown idle past 15 minutes
//   7. lane, the board's column, from every obligation at once (`laneOf`), never from the representative reason alone
// An owner wait ends only at the owner's comment newer than it (never a job starting, never an agent's comment); a
// delegator wait at a newer comment by anyone but the holder and the kernel; an agent wait at its time, the next job start or
// a newer wait. Children never make a task wait: only a named blocker does.
import type { FactRow } from "./facts.ts";
import { pair } from "./flow.ts";
import type { Stage } from "./flow-stages.ts";
import type { Attention, Kind, Lane, Reason, TaskState } from "../sdk/src/task-state-types.ts";

export /** How long after a job ends its reply may still arrive (the kernel posts it a few seconds later). */
const REPLY_GRACE_MS = 60_000;
export const ATTENTION_AFTER_MS = 15 * 60_000;
/** A module's wait (CI checks, a merge queue) open this long needs an agent (attention `stalled_wait`). */
export const MODULE_WAIT_STALLED_MS = 6 * 3600_000;
export const STAGE_HINT_MS = 24 * 3600_000;
/** A due wake nothing bound this long after it was due (or known) no longer counts as queued (flow.ts PENDING_MAX). */
const PENDING_MAX = 2.5 * 3600_000;
const CLOSED = new Set(["done", "cancelled"]);
const FAILED = new Set(["failed", "timeout", "lost"]);
/** Waiting reasons, highest first: the representative reason is the highest open one (the oldest of it on a tie). */
const ORDER: Reason[] = ["job_queued", "job_held", "card_review", "card_owner", "owner_wait", "delegator_wait", "handback", "owner_task", "blocked", "agent_wait", "module_wait", "scheduled", "chat_turn", "backlog"];

/** Agent attention that puts a task in Blocked: each raised only after its own grace (above). */
const STUCK = new Set<Attention["why"]>(["failed", "stalled_wait", "unpolled", "orphaned", "unknown", "history_expired"]);
const QUIET = new Set<Reason>(["scheduled", "backlog", "owner_task", "chat_turn"]);

/**
 * The lane, first match wins: done; anything waiting on the owner (a running task can carry one); a running job; a blocker,
 * a failure or an agent's stuck attention; a quiet reason or idle; else waiting (queued, held, a review, another's answer, a
 * module's step).
 */
export function laneOf(s: Omit<TaskState, "lane">): Lane {
  if (s.kind === "done") return "done";
  if (s.attention.some((a) => a.who === "owner")) return "needs_you";
  if (s.kind === "working") return "working";
  if (s.blocker || s.attention.some((a) => a.who === "agent" && STUCK.has(a.why))) return "blocked";
  if (s.kind === "idle" || QUIET.has(s.reason)) return "idle";
  return "waiting";
}
const laned = (s: Omit<TaskState, "lane">): TaskState => ({ ...s, lane: laneOf(s) });

const ms = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const byTime = (a: FactRow, b: FactRow) => a.at.localeCompare(b.at) || a.seq - b.seq;
/** A module's fact: its version carries the module (POST /v1/facts). Hints only; never ends or starts anything here. */
const moduleFact = (f: FactRow) => /^[a-z][a-z0-9-]*\//.test(f.version);

type Open = { reason: Reason; ref?: string; since: number };

/**
 * One task's state at `now` (ms). `facts`: the task's facts (task = it, or subject `task:<it>`) plus the `task.created` and
 * `task.status_changed` facts of the tasks it is blocked by; any other task's facts are ignored.
 */
export function taskState(task: string, facts: FactRow[], now: number, stages: Stage[], polled?: (holder: string) => boolean): TaskState {
  const self = `task:${task}`;
  const sorted = [...facts].filter((f) => ms(f.at) <= now || f.type === "wake.opened").sort(byTime);
  const own = sorted.filter((f) => f.task === task || f.subject === self);
  const mine = own.filter((f) => f.subject === self);
  const created = mine.find((f) => f.type === "task.created");
  const statuses = mine.filter((f) => f.type === "task.status_changed");
  const status = statuses.at(-1);
  const assigns = mine.filter((f) => f.type === "task.assignee_changed");
  const holder = assigns.length ? (str(assigns.at(-1)!.data.to) ?? null) : null;

  // 1. closed
  if (status && CLOSED.has(String(status.data.to))) {
    return laned({ kind: "done", reason: status.data.to === "cancelled" ? "cancelled" : "closed", since: status.at, holder, attention: [] });
  }
  if (!created) {
    const first = own[0];
    return laned({ kind: "idle", reason: "history_expired", since: first?.at ?? iso(now), holder, attention: [{ who: "agent", why: "history_expired", ref: self, since: first?.at ?? iso(now) }] });
  }

  // The current open stretch: everything after the latest reopen (a status leaving done or cancelled).
  let reopen: FactRow | undefined;
  for (let i = 1; i < statuses.length; i++) if (CLOSED.has(String(statuses[i - 1]!.data.to)) && !CLOSED.has(String(statuses[i]!.data.to))) reopen = statuses[i];
  const after = (f: FactRow) => !reopen || (f.type === "wake.opened" ? ms(f.seen_at) >= ms(reopen.at) : byTime(f, reopen) > 0);
  const live = own.filter((f) => f.type !== "wake.opened" && ms(f.at) <= now);

  const isChat = (mine.filter((f) => f.type === "task.labeled").at(-1)?.data.chat ?? created.data.chat) === true;
  const jobs = new Map<string, { queued?: FactRow; started?: FactRow; ended?: FactRow }>();
  const records = new Map<string, { since: number; owner: boolean; done: boolean }>();
  let failure: FactRow | undefined;
  let silent: FactRow | undefined; // a chat's job that ended done: ended without a reply unless an agent comment came with it
  const agentComments: FactRow[] = [];
  // A question this task already asked and had answered (by anyone but its holder): an answer handed the call on, and a wait that
  // asks it again is a re-arm of that same, settled episode, not a new judgement.
  const settledQuestions = new Set<string>();
  let wait: { f: FactRow; end?: number } | undefined;
  const mwaits = new Map<string, FactRow>(); // a module's waits by subject (a PR), until its work.resumed or a job starts
  let handback: { f: FactRow; fromAgent: boolean } | undefined;
  let who: string | null = null; // the holder as each fact happened
  let quiet = Math.max(ms(created.at), reopen ? ms(reopen.at) : 0); // when the latest obligation ended or anything not a hint happened
  const queuedAt: number[] = [];
  for (const f of live) {
    if (f.type === "task.assignee_changed" && f.subject === self) {
      const before = who;
      who = str(f.data.to) ?? null;
      handback = who === "owner" ? { f, fromAgent: before !== null && before !== "owner" } : undefined;
    }
    if (!after(f)) continue;
    if (f.type === "task.commented" && f.actor.startsWith("agent:")) agentComments.push(f);
    if (!moduleFact(f) && f.type !== "task.commented") quiet = Math.max(quiet, ms(f.at));
    const job = f.subject.startsWith("job:") ? jobs.get(f.subject) ?? (jobs.set(f.subject, {}), jobs.get(f.subject)!) : undefined;
    switch (f.type) {
      case "job.queued": job!.queued = f; failure = silent = undefined; queuedAt.push(ms(f.at)); break;
      case "job.started":
        job!.started = f; failure = silent = undefined;
        if (wait && !wait.end && wait.f.data.reason === "agent_wait") wait.end = ms(f.at);
        mwaits.clear();
        break;
      case "job.ended":
        job!.ended = f; silent = undefined;
        // A run the machinery stopped (no account: dispatch's progress judge, a closed task) is as unresolved as a failed one; the
        // owner's own Stop records its account and is not. `=== null` only: an older cancelled fact has no field, so never flips.
        if (FAILED.has(String(f.data.state)) || (f.data.state === "cancelled" && f.data.stopped_by === null)) failure = f;
        else if (isChat && f.data.state === "done" && f.data.acted !== true && f.data.no_reply !== true) silent = f;
        break;
      case "task.assignee_changed": if (f.subject === self) failure = silent = undefined; break;
      case "work.waiting": if (f.subject === `wait:${task}`) wait = { f }; else if (moduleFact(f)) mwaits.set(f.subject, f); break;
      case "work.resumed": if (moduleFact(f)) mwaits.delete(f.subject); break;
      case "task.commented": {
        if (!wait || wait.end || ms(f.at) <= ms(wait.f.at)) break;
        const r = wait.f.data.reason;
        const answers = r === "owner_wait" ? f.actor.startsWith("account:") : r === "delegator_wait" ? f.actor !== "kernel" && f.actor !== `agent:${who}` : false;
        if (answers) {
          wait.end = ms(f.at);
          quiet = Math.max(quiet, wait.end);
          const q = str(wait.f.data.question)?.trim();
          if (r === "delegator_wait" && q) settledQuestions.add(q);
        }
        break;
      }
      case "record.filed": records.set(f.subject, { since: ms(f.at), owner: f.data.state === "owner", done: false }); break;
      case "record.decided": case "record.held": case "record.landed": case "record.failed": {
        const r = records.get(f.subject);
        if (!r) break;
        const toOwner = f.type === "record.held" || (f.type === "record.decided" && /^(owner|escalate)$/.test(String(f.data.decision)));
        if (toOwner) { if (!r.owner) r.since = ms(f.at); r.owner = true; } else r.done = true;
        break;
      }
    }
  }

  // A delegator's answer can reach the task as a comment wake with no comment fact the state reads (WOR-9335, #1326): a comment
  // wake opened after the wait by anyone but its holder and the kernel ends it, as the comment would have.
  if (wait && !wait.end && wait.f.data.reason === "delegator_wait") {
    const answer = own.find((f) => f.type === "wake.opened" && f.subject.startsWith("wake:comment:") && ms(f.at) > ms(wait!.f.at) && ms(f.at) <= now && f.actor !== "kernel" && f.actor !== `agent:${who}`);
    if (answer) { wait.end = ms(answer.at); quiet = Math.max(quiet, wait.end); }
  }
  const open: Open[] = [];
  for (const [subject, j] of jobs) {
    if (j.ended) continue;
    if (j.started) open.push({ reason: "job_running", ref: subject, since: ms(j.started.at) });
    else if (j.queued) open.push({ reason: "job_queued", ref: subject, since: ms(j.queued.at) });
  }
  // Wakes: pending from due until bound, dropped or a job queued at or after it (held: until bound or dropped); a due one
  // nothing takes ages out; one still ahead is scheduled.
  let agedOut: { due: number; at: number } | undefined;
  let nextDue: number | undefined;
  const bySubject = new Map<string, FactRow[]>();
  for (const f of own) if (f.subject.startsWith("wake:")) (bySubject.get(f.subject) ?? bySubject.set(f.subject, []).get(f.subject)!).push(f);
  for (const opened of own.filter((f) => f.type === "wake.opened" && after(f))) {
    const later = bySubject.get(opened.subject)!.filter((g) => g.seq > opened.seq);
    if (later.some((g) => g.type === "wake.opened")) continue; // reopened: the newest counts
    if (later.some((g) => (g.type === "wake.bound" || g.type === "wake.dropped") && ms(g.at) <= now)) continue;
    const held = later.filter((g) => g.type === "job.held" && ms(g.at) <= now).at(-1);
    const due = ms(opened.at);
    if (held) { open.push({ reason: "job_held", ref: str(held.data.reason) ?? opened.subject, since: ms(held.at) }); continue; }
    if (due > now) { open.push({ reason: "scheduled", ref: opened.subject, since: ms(opened.seen_at) }); nextDue = Math.min(nextDue ?? due, due); continue; }
    if (queuedAt.some((q) => q >= due)) continue;
    const ages = Math.max(due, ms(opened.seen_at)) + PENDING_MAX;
    if (now < ages) open.push({ reason: "job_queued", ref: opened.subject, since: due });
    else if (!agedOut || ages > agedOut.at) agedOut = { due, at: ages };
  }
  for (const [subject, r] of records) if (!r.done) open.push({ reason: r.owner ? "card_owner" : "card_review", ref: subject, since: r.since });
  if (wait && !wait.end) {
    const r = String(wait.f.data.reason);
    const until = str(wait.f.data.until) ? ms(wait.f.data.until as string) : Infinity;
    if (r === "owner_wait" || r === "delegator_wait") open.push({ reason: r, ref: wait.f.subject, since: ms(wait.f.at) });
    else if (until > now) open.push({ reason: "agent_wait", ref: wait.f.subject, since: ms(wait.f.at) });
    else quiet = Math.max(quiet, until);
  }
  // The unresolved failure: a failed job, or a chat's job that ended with no agent comment between its start and a minute
  // after its end (the reply is posted a few seconds after the job ends).
  const noReply = silent && !failure && now - ms(silent.at) >= REPLY_GRACE_MS && !agentComments.some((c) => c.data.job === silent!.subject.slice(4) || (ms(c.at) >= ms(jobs.get(silent!.subject)?.started?.at ?? silent!.at) && ms(c.at) <= ms(silent!.at) + REPLY_GRACE_MS));
  const fail = failure ? { ref: failure.subject, at: failure.at } : noReply ? { ref: "no_reply", at: silent!.at } : undefined;
  for (const [subject, w] of fail ? [] : mwaits) {
    const until = str(w.data.until) ? ms(w.data.until as string) : Infinity;
    if (until > now) open.push({ reason: "module_wait", ref: str(w.data.reason) ?? subject, since: ms(w.at) });
  }
  if (handback && status?.data.to !== "backlog") open.push({ reason: handback.fromAgent ? "handback" : "owner_task", ref: self, since: ms(handback.f.at) });
  const blockedBy = mine.filter((f) => f.type === "task.blocked_changed").at(-1);
  for (const b of Array.isArray(blockedBy?.data.blocked_by) ? (blockedBy!.data.blocked_by as unknown[]).map(String) : []) {
    const st = sorted.filter((f) => f.subject === `task:${b}` && f.type === "task.status_changed").at(-1);
    if (st && CLOSED.has(String(st.data.to))) quiet = Math.max(quiet, ms(st.at));
    else open.push({ reason: "blocked", ref: `task:${b}`, since: ms(blockedBy!.at) });
  }
  if (status?.data.to === "backlog") open.push({ reason: "backlog", since: ms(status.at) });
  if (isChat && !open.length && !fail) open.push({ reason: "chat_turn", since: quiet });

  // Attention, across every obligation.
  const attention: Attention[] = [];
  for (const o of open) {
    if (o.reason === "card_owner" || o.reason === "card_review") attention.push({ who: o.reason === "card_owner" ? "owner" : "reviewer", why: "card", ref: o.ref!, since: iso(o.since) });
  }
  for (const o of open) {
    if (o.reason === "owner_wait") attention.push({ who: "owner", why: "owner_wait", ref: o.ref!, since: iso(o.since) });
    if (o.reason === "delegator_wait") attention.push({ who: "agent", why: "delegator_wait", ref: o.ref!, since: iso(o.since) });
    if (o.reason === "handback") attention.push({ who: "owner", why: "handback", ref: o.ref!, since: iso(o.since) });
  }
  if (fail) attention.push({ who: "agent", why: "failed", ref: fail.ref, since: fail.at });
  for (const o of open) if (o.reason === "module_wait" && now - o.since > MODULE_WAIT_STALLED_MS) attention.push({ who: "agent", why: "stalled_wait", ref: o.ref!, since: iso(o.since) });

  // The open wait's question, whichever recipient answers it: the ask gate (escalate.ts) reads this, so a questionless wait
  // can't pass for an unanswered ask.
  const waitQuestion = wait && !wait.end && (wait.f.data.reason === "owner_wait" || wait.f.data.reason === "delegator_wait") ? str(wait.f.data.question) : undefined;
  const judging = wait && !wait.end && (wait.f.data.reason === "owner_wait" || wait.f.data.reason === "delegator_wait") ? wait.f.at : undefined;
  const openNote = wait && open.some((o) => o.ref === wait!.f.subject) ? str(wait.f.data.note) : undefined;
  const openUntil = waitQuestion ? str(wait!.f.data.until) : undefined;
  // What the question is about (notify's `detail`, e.g. the draft to send): shown beside it on the owner's board.
  const waitDetail = waitQuestion ? str(wait!.f.data.detail) : undefined;
  const blocker = open.find((o) => o.reason === "blocked")?.ref;
  const waitsOn = wait && !wait.end && wait.f.data.reason === "delegator_wait" ? str(wait.f.data.agent) : undefined;
  // A delegator wait asking a question this task already had answered on this stretch: the answer settled it, and the agent is
  // re-asking the same one (the Steward's settlement handing it on, the live repro), so it is not a new judgement to raise. A
  // genuinely new question is not in the set, so it is still raised once it is an hour old.
  const askSettled = wait && !wait.end && wait.f.data.reason === "delegator_wait" && Boolean(str(wait.f.data.question)?.trim()) && settledQuestions.has(str(wait.f.data.question)!.trim());
  const extra = { ...(blocker ? { blocker } : {}), ...(nextDue !== undefined ? { scheduled_for: iso(nextDue) } : {}), ...(waitsOn ? { waits_on: waitsOn } : {}), ...(waitQuestion ? { question: waitQuestion } : {}), ...(waitDetail ? { detail: waitDetail } : {}), ...(openNote ? { note: openNote } : {}), ...(judging ? { wait_since: judging } : {}), ...(openUntil ? { wait_until: openUntil } : {}), ...(askSettled ? { ask_settled: true as const } : {}) };
  const hint = () => {
    const occ = pair(own.filter((f) => after(f) && ms(f.at) <= now), stages)
      .filter((o) => o.module_fact && !o.end && ms(o.start) <= now && now - ms(o.start) <= STAGE_HINT_MS).at(-1);
    return occ ? { stage: occ.label } : {};
  };
  const pick = (os: Open[]) => [...os].sort((a, b) => ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason) || a.since - b.since)[0]!;

  const running = open.filter((o) => o.reason === "job_running").sort((a, b) => a.since - b.since)[0];
  if (running) return laned({ kind: "working", reason: "job_running", ref: running.ref, since: iso(running.since), holder, attention, ...extra, ...hint() });
  if (open.length) {
    const top = pick(open);
    return laned({ kind: "waiting", reason: top.reason, ...(top.ref ? { ref: top.ref } : {}), since: iso(top.since), holder, attention, ...extra, ...hint() });
  }
  if (fail) return laned({ kind: "idle", reason: "failed", ref: fail.ref, since: fail.at, holder, attention });
  // Nothing open: unpolled when no enabled dispatcher runs the holder (nothing will ever take a wake for it, so `orphaned`
  // would misname it, and so would `unknown`: the wake went nowhere because nobody reads them); unknown when the last thing was a
  // wake nothing took (someone holds the task); else orphaned.
  const unknown = Boolean(holder && agedOut && agedOut.due >= quiet);
  const unpolled = Boolean(holder && holder !== "owner" && polled && !polled(holder));
  const reason: Reason = unpolled ? "unpolled" : unknown ? "unknown" : "orphaned";
  const since = unknown ? agedOut!.at : quiet;
  if (now - since >= ATTENTION_AFTER_MS) attention.push({ who: "agent", why: reason, ref: self, since: iso(since) });
  return laned({ kind: "idle", reason, since: iso(since), holder, attention });
}


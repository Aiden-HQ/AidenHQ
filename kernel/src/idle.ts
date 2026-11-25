// No idle agent-held task: every open task an agent holds is running, finished, blocked on something named, or waiting on
// something recorded. Two halves, both on the wake inbox (wakes.ts) and the kernel's task state (task-state.ts):
// - wait(): an agent's own wait on its job's task (POST /v1/wait, the tasks connection's task_wait): a `work.waiting` fact
//   (subject wait:<task>, reason agent_wait, its words as `note`), so flow names the wait instead of `orphaned`, and a wake
//   at `until` (at most 7 days; 24 hours when it names only an event), so the task resumes by itself. The task's next job
//   ends the wait (the state, and admission drops its timed wake); a new wait replaces the last. A wait `for` the owner or the
//   delegator is a judgement the task can't make itself: it lasts until the answer wakes the task (7 days unless `until`),
//   and its `question` goes once to whoever settles it (escalate.ts): the owner directly (reason owner_wait) only from the
//   chief of staff or on a task the owner is talking to its agent on; otherwise the open delegator or the chief of staff
//   (reason delegator_wait: an agent answers). The steward raises either left too long.
// - sweep(): every few minutes, each open (todo, in_progress) task an agent holds (in_review: see below) that the task state reports `orphaned` (a
//   chat is `chat_turn`, never orphaned), `unknown` (its holder's wake aged out) or `unpolled` (no enabled dispatcher runs its
//   holder: the sweep skips it too, since its wake would never be taken, but the state names why) for 15 minutes
//   gets one wake for its holder, cause `idle` (dispatch words it), once each time it becomes idle (the key is when: a wake
//   the dispatcher drops leaves it orphaned again from the drop, so it is tried again 15 minutes later), at most 3 a day per
//   task. Past that cap nothing more wakes it: the Fleet Steward reads the count (`idle_wakes`) and raises the task as a critical
//   incident. A task in `in_review` is its delegator's to decide, not its holder's (the holder's part is done): the sweep
//   sends that idle stretch once to whoever delegated it (escalate.ts delegator: the open delegator, else the chief of staff)
//   instead of waking the holder. An owner-held task is never swept (the steward's stale follow-up check has it), and isn't read: the state's
//   holder says no agent holds it.
// - parked waits: the pinned sweep blocks any `todo`/`in_progress`/`in_review` issue whose assignee is not invokable, so a
//   settled wait is parked in `backlog` (outside its candidate set, inert to comments and recovery) and reconciled back once
//   when the wait ends: `in_progress`, or `in_review` for a review task, and only in the `in_review` shape the sweep acts on.
//   A restore into a scanned status is re-parked at once from the task's own event (wakes.ts event → settleOne), the settle
//   tick only as a backstop. A hold the loop left is released once, when that is safe.
import type { Api } from "./channels.ts";
import type { DatabaseSync } from "node:sqlite";
import { inTx, iso, type Log } from "./factlog.ts";
import type { Facts } from "./facts.ts";
import type { TaskStateRead } from "./task-state-read.ts";
import { fail } from "./proxy.ts";
import type { Wakes } from "./wakes.ts";
import type { AskTo, Escalate } from "./escalate.ts";

export const IDLE_AFTER_MS = 15 * 60_000;
export const IDLE_CAP = 3;
const DAY = 864e5;
const MAX_WAIT = 7 * DAY;
/** The shortest wait: a wait is never a way to wake again at once (an idle task is woken after 15 minutes anyway). */
const MIN_WAIT = 15 * 60_000;
const SWEPT = new Set(["todo", "in_progress"]);
/** The idle reasons a wake could move a task out of; `unpolled` is one the sweep then skips (its wake would never be taken). */
const IDLE_REASONS = new Set(["orphaned", "unknown", "unpolled"]);
/** The statuses a park always moves: the sweep's plain agent-assigned candidates, blocked on the holder's invokability. */
const PARKABLE = new Set(["todo", "in_progress"]);
/**
 * What a restore treats as invokable: Paperclip's own set (agent-eligibility.ts) without `error`. The pinned build counts
 * `error` invokable; this is narrower on purpose, and parking costs nothing while the wait's wake is open.
 */
const INVOKABLE = new Set(["active", "idle", "running"]);
/** The status an ended wait goes back to. Never `todo`: that move files a status wake, a second job beside the wait's. */
const RESUMED = "in_progress";
const CLOSED = new Set(["done", "cancelled"]);

/** A task the kernel parked in backlog while its wait is armed (wait_parks): whose it is, and where the wait's end puts it. */
type Park = { task: string; agent: string; from_status: string };
const PARK_DDL = `CREATE TABLE IF NOT EXISTS wait_parks (task TEXT PRIMARY KEY, agent TEXT NOT NULL, from_status TEXT NOT NULL, at INTEGER NOT NULL)`;
type AgentRow = { id: string; companyId?: string; status?: string; lifecycleHolds?: string[]; reportsTo?: string | null };
/** An issue as the park logic needs it (Paperclip's single-issue read). */
type ParkedIssue = { id: string; status?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; companyId?: string; activeRecoveryAction?: { id: string; cause?: string; status?: string; ownerType?: string } | null; executionState?: { status?: string; currentParticipant?: { type?: string; agentId?: string } | null } | null; monitorNextCheckAt?: string | null };
/**
 * Whether an `in_review` issue is one the pinned sweep re-blocks: its review branch acts only on a pending agent
 * execution-review participant (service.ts). Only that shape is parked: the finish gate's own `in_review` (checks.ts
 * holds() reads the status) must stay in review, and so must one carrying the gate's monitor.
 */
const reviewParkable = (i: ParkedIssue) => String(i.status) === "in_review" && i.executionState?.status === "pending" && i.executionState?.currentParticipant?.type === "agent" && Boolean(i.executionState?.currentParticipant?.agentId) && !i.monitorNextCheckAt;

export function createIdle({ db, facts, state, wakes, owner, team = () => false, escalate, now = Date.now, log = () => {} }: {
  /** kernel.db: a wait's fact, its wake and its park row are one transaction (the status PATCH is the one write outside). */
  db: DatabaseSync;
  facts?: Facts; state: Pick<TaskStateRead, "read">; wakes: Pick<Wakes, "open" | "polls" | "settleOn" | "settleEach" | "mirror">;
  /** The control plane as the owner: the issue read, its status PATCH, a stale recovery hold's resolution, and an agent's status. */
  owner: Api;
  /** Where a wait's question goes (escalate.ts); none: the wait is recorded and nobody is asked. */
  escalate?: Pick<Escalate, "ask" | "record" | "delegator">;
  /** Whether an agent id is a team record (its tasks go to a member; it never runs). */
  team?: (agent: string) => boolean;
  now?: () => number; log?: Log;
}) {
  db.exec(PARK_DDL);
  const q = (sql: string) => db.prepare(sql);
  /** Whether a task's own wait is armed: an open `wait:` wake (a new wait replaces the last; a bound, dropped or replaced one
   *  is no longer open). This is the one definition of "settled wait" here, read from the inbox that also schedules it. */
  const armed = (task: string) => Boolean(q("SELECT 1 FROM wakes WHERE task = ? AND state = 'open' AND key LIKE 'wait:%'").get(task));
  const parkOf = (task: string) => q("SELECT task, agent, from_status FROM wait_parks WHERE task = ?").get(task) as Park | undefined;
  const remember = (task: string, agent: string, from: string) => q("INSERT INTO wait_parks (task, agent, from_status, at) VALUES (?, ?, ?, ?) ON CONFLICT(task) DO UPDATE SET agent = excluded.agent, from_status = excluded.from_status, at = excluded.at").run(task, agent, from, now());
  const forget = (task: string) => q("DELETE FROM wait_parks WHERE task = ?").run(task);
  /**
   * Where an adopted park goes back to, from the fact log: the newest status recorded before the park. The park's own write is a
   * `to: backlog` fact, so that one is skipped — reading only the newest record would read our own park and lose the review.
   */
  const adoptedFrom = (task: string) => {
    for (const r of q("SELECT data FROM facts WHERE subject = ? AND type = 'task.status_changed' ORDER BY seq DESC").all(`task:${task}`) as { data?: string }[]) {
      let to: unknown;
      try { to = (JSON.parse(String(r.data ?? "{}")) as { to?: unknown }).to; } catch { continue; }
      if (to === "backlog") continue;
      return to === "in_review" ? "in_review" : "in_progress";
    }
    return "in_progress";
  };
  /** The status the fact log last recorded for a task. */
  const lastStatus = (task: string) => q("SELECT json_extract(data, '$.to') AS to_, at FROM facts WHERE subject = ? AND type = 'task.status_changed' ORDER BY at DESC, seq DESC LIMIT 1").get(`task:${task}`) as { to_?: string; at: string } | undefined;
  const issue = async (task: string) => {
    const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}`).catch((e: Error) => ({ status: 503, json: { error: e.message } }));
    return r.status === 404 ? null : r.status === 200 ? (r.json as ParkedIssue) : undefined;
  };
  const patch = async (id: string, body: Record<string, unknown>) => {
    const r = await owner("PATCH", `/api/issues/${encodeURIComponent(id)}`, body);
    if (r.status >= 300) throw new Error(`control plane PATCH issue → ${r.status}`);
    return r.json as ParkedIssue;
  };
  /**
   * Whether the pinned sweep would leave this agent's work alone: an invokable status, no lifecycle hold, and a healthy org
   * chain (a missing manager, terminated ancestor or cycle also reads as not invokable). A failed read counts as not
   * invokable: then the hold is left to the board. `company`'s agent list is read once per pass (agentsIn).
   */
  // One company's agent list per pass (a status change mid-pass must not be missed: the next pass reads it again).
  let agentsFor = "", agentsIn: Map<string, AgentRow> | undefined;
  const freshAgents = () => { agentsFor = ""; agentsIn = undefined; };
  const agentsOf = async (company: string) => {
    if (agentsIn && agentsFor === company) return agentsIn;
    const l = company ? await owner("GET", `/api/companies/${encodeURIComponent(company)}/agents`).catch(() => undefined) : undefined;
    if (l?.status !== 200 || !Array.isArray(l.json)) return undefined;
    agentsFor = company; agentsIn = new Map((l.json as AgentRow[]).map((x) => [x.id, x]));
    return agentsIn;
  };
  const invokable = async (agent: string, company: string) => {
    if (!agent) return false;
    const all = await agentsOf(company);
    const a = all?.get(agent);
    if (!a || !INVOKABLE.has(String(a.status)) || a.lifecycleHolds?.length) return false;
    // The org chain, as packages/shared/src/agent-eligibility.ts walks it.
    const seen = new Set<string>([a.id]);
    let cur: AgentRow | undefined = a;
    while (cur?.reportsTo) {
      if (seen.has(cur.reportsTo)) return false;
      seen.add(cur.reportsTo);
      const parent: AgentRow | undefined = all!.get(cur.reportsTo);
      if (!parent || (parent.companyId ?? a.companyId) !== a.companyId) return false;
      if (parent.status === "terminated") return false;
      cur = parent;
    }
    return true;
  };
  /**
   * One task's wait and its issue, reconciled:
   * - a wait armed → `todo`/`in_progress` becomes `backlog` unconditionally: the sweep re-blocks on the holder's invokability
   *   at its own tick, so the status, not a snapshot of the holder, is what keeps it out. `in_review` is parked only in the
   *   shape the sweep acts on (reviewParkable); the row marks the task as the kernel's to restore, once.
   * - no wait → back to where it came from once (from the row), the row going with it — but only when the holder is invokable
   *   now: restoring for an agent the sweep would block straight away is the loop this fixes, so it stays parked until then.
   * - a `blocked` task with a stale `stranded_assigned_issue` hold → resolved, re-parked if it still waits; a hold that cannot
   *   be released yet keeps its row, so the next pass retries it.
   * Every interruption (crash, unknown answer, lost row) is recovered by the next pass. Returns what this pass wrote; each
   * pass re-reads the issue, writes only the transition it named, and drops the row only after the write.
   */
  async function reconcileOne(i: ParkedIssue, p: Park | undefined): Promise<"parked" | "resumed" | "resolved" | undefined> {
    const task = i.id, status = String(i.status ?? "");
    // Who holds the task now, not who held it when it was parked: a task reassigned while it waits is restored only if its
    // current holder is invokable (the row's agent answers for an issue the control plane reports with no assignee).
    const agent = i.assigneeAgentId || p?.agent || "";
    const company = String(i.companyId ?? "");
    if (status === "blocked") {
      // A park row for a task Paperclip already blocked is this loop's own work: release the hold once, then settle it. So is a
      // task with no row whose wait is still armed: the same loop blocked it before the park could land, and the armed wait is
      // what keeps it out once released (it is parked again in this pass). A hold on a task with neither is the board's.
      if (!p && !armed(task)) return undefined;
      // The retryable state is recorded before the hold is resolved, not after the move: the resolve puts the issue in `todo`,
      // and the wait can stop being armed at any point while it is in flight. Without a row, a resolve that landed while its
      // answer was lost — or a follow-up PATCH that failed — would leave `todo` with neither a row nor an open wait to select
      // it again. With one, the next pass finishes whatever this one started (both paths below drop it only on success).
      const from = p ? p.from_status : adoptedFrom(task);
      if (!p) remember(task, agent, from);
      if ((await resolveStale(i, agent)) !== "resolved") {
        // A hold this loop leaves behind keeps its row, so the next pass retries it (resolveStale makes no call until that
        // is safe: a cadence, not a loop); dropping it would leave a task we parked owing a restore. A hold of another cause
        // is the board's, and the row it no longer guards goes.
        if (i.activeRecoveryAction?.cause !== "stranded_assigned_issue") forget(task);
        // The answer was an error: the call may still have landed. If the issue is no longer blocked, the release is done and
        // the move on from `todo` is the rest of this pass's work; if it is still blocked (or unreadable) it stays for the
        // next pass, row and all.
        const after = await issue(task).catch(() => undefined);
        if (!after || after.status === "blocked") return undefined;
      }
      // Re-parked while it still waits: `from` is where the wait's end must put it, not the `todo` the release left.
      if (armed(task)) { await park(task, agent, from); return "resolved"; }
      // The wait can end while the release is in flight (it was armed when this pass read it, and the resolve is a round
      // trip). Restoring is only safe then if the holder is invokable *now*: a pause that landed meanwhile would put the
      // task back in `in_progress` for the sweep to block at its next tick — the loop this change exists to prevent. The
      // release left the issue in `todo`, a status the sweep scans, so it is parked instead, with its row, until the first
      // pass that finds the holder invokable restores it once (the row keeps its origin across the re-park).
      if (!(await invokable(agent, company))) {
        if (!(await park(task, agent, from))) remember(task, agent, from);
        return "resolved";
      }
      // The resolve lands the issue in `todo`, the one scanned status the route accepts, and a task sitting there files a
      // status wake — a second dispatch beside the one the wait's wake already started — so it is moved on in this pass.
      const back = from === "in_review" ? "in_review" : RESUMED;
      const moved = await patch(task, { status: back }).then(() => true, (e: Error) => { log("task wait resume after resolve failed", { task, err: e.message }); return false; });
      if (moved) forget(task);
      return "resolved";
    }
    if (status !== "backlog") {
      if (armed(task) && (PARKABLE.has(status) || reviewParkable(i))) return (await park(task, agent)) ? "parked" : undefined;
      if (p && !armed(task)) {
        // The resolve that releases a held task lands it in `todo`, and moving it on from there is the rest of that pass's
        // work. If that move's PATCH failed, the row is still here and the issue is still in a scanned status, so this pass
        // finishes the transition and keeps the row until it succeeds — never a row dropped over an issue left in `todo`.
        // `todo` is never a resting place for a task this loop parked: it is the status whose move files a status wake, a
        // second job beside the one the wait's wake started. A row for a task a person moved out of backlog leaves as before.
        if (status === "todo") {
          if (!(await invokable(agent, company))) return undefined;
          const back = p.from_status === "in_review" ? "in_review" : RESUMED;
          const moved = await patch(task, { status: back }).then(() => true, (e: Error) => { log("task wait resume after resolve failed", { task, err: e.message }); return false; });
          // Left in todo with its row: the next pass tries the move again, instead of dropping the row over a swept status.
          if (!moved) return undefined;
          forget(task);
          return "resumed";
        }
        forget(task);
      }
      return undefined;
    }
    if (armed(task)) {
      // A crash between the park's PATCH and its row leaves exactly this: an armed task in backlog with no row. Take it back
      // (the pass's set is open waits and rows, so no other backlog task is read), so the wait's end still restores it once.
      if (!p) { remember(task, agent, adoptedFrom(task)); log("task wait park adopted", { task }); }
      return undefined;
    }
    if (!p) return undefined;
    if (!(await invokable(agent, company))) return undefined;
    await patch(task, { status: p.from_status === "in_review" ? "in_review" : RESUMED });
    forget(task);
    return "resumed";
  }
  /**
   * `todo`/`in_progress` → `backlog` while a wait is armed, row first so no crash leaves a parked issue nothing knows about.
   * A park that did not land is rolled back only on proof: the row is dropped when a read shows the issue is not parked,
   * kept when the outcome is unknown (a write can land and still answer with an error), which is always safe.
   */
  async function park(task: string, agent: string, origin?: string) {
    const i = await issue(task);
    const from = String(i?.status ?? "");
    if (!i || !(PARKABLE.has(from) || reviewParkable(i))) return false;
    // `origin`: where a re-park goes back to when that is not where the issue stands (a release that left `todo`).
    remember(task, agent, origin ?? from);
    try {
      // Backlog is all Paperclip's recovery sweep needs to leave an armed wait alone; no comment, which would read as the owner's.
      await patch(task, { status: "backlog" });
    } catch (e) {
      // The row stays unless the issue is *read* and found not parked: "unknown" (the read failed too) is not proof the write
      // missed, and dropping the row then would leave a parked task that no pass selects once its wait ends. Keeping it is
      // always safe — an armed wait simply parks the task again, and a row for a task that is not parked is dropped by the
      // next pass (no wait) or by the restore (wait ended).
      const after = await issue(task).catch(() => undefined);
      const landed = after ? String(after.status) === "backlog" : undefined;
      if (landed === false) forget(task);
      log("task wait park failed", { task, err: (e as Error).message, landed: String(landed) });
      return landed === true;
    }
    log("task wait parked", { task, from: i.status, agent });
    return true;
  }
  /**
   * A `stranded_assigned_issue` hold this loop left, released once through `recovery-actions/resolve` (restored → todo), and
   * only when that is safe: its wait is armed (parked again at once) or its holder is invokable. Any other hold, or a holder
   * not invokable with no wait, is `held`: no call, and the caller keeps its row to retry later. A failed call is `failed`:
   * the release may have landed, so the caller reads the issue before deciding.
   */
  async function resolveStale(i: ParkedIssue, agent: string): Promise<"resolved" | "held" | "failed"> {
    const a = i.activeRecoveryAction;
    if (!a?.id || a.cause !== "stranded_assigned_issue") return "held";
    const rePark = armed(i.id);
    if (!rePark && !(await invokable(agent, String(i.companyId ?? "")))) return "held";
    const r = await owner("POST", `/api/issues/${encodeURIComponent(i.id)}/recovery-actions/resolve`, {
      actionId: a.id, outcome: "restored", sourceIssueStatus: "todo",
      resolutionNote: rePark
        ? "AidenHQ: a settled task_wait keeps this task out of automatic recovery; release the hold so the wait is not read as stranded work."
        : "AidenHQ: the assignee is invokable again; release the automatic-recovery hold left while it was not.",
    }).catch((e: Error) => ({ status: 502, json: { error: e.message } }));
    if (r.status >= 300) {
      log("stale recovery hold not resolved", { task: i.id, action: a.id, status: r.status, err: String(r.json?.error ?? "").slice(0, 200) });
      return "failed";
    }
    log("stale recovery hold resolved", { task: i.id, action: a.id, reparked: rePark });
    return "resolved";
  }
  /** One reconcile pass over every task with a park row or an armed wait (reconcileOne, each in its own try: one failure never
   *  hides the others). */
  async function settle() {
    freshAgents();
    const tasks = new Set<string>([
      ...(q("SELECT DISTINCT task FROM wakes WHERE state = 'open' AND key LIKE 'wait:%'").all() as { task: string }[]).map((r) => r.task),
      ...(q("SELECT task FROM wait_parks").all() as { task: string }[]).map((r) => r.task),
    ]);
    const out = { parked: [] as string[], resumed: [] as string[], resolved: [] as string[] };
    for (const task of tasks) {
      try {
        // Parked in backlog with its row while its wait is armed (the issue mirror says so): nothing for this pass to do, so
        // nothing is read. Every other state is read whole (the hold and its recovery action are on the issue only).
        if (wakes.mirror(task)?.status === "backlog" && armed(task) && parkOf(task)) continue;
        const i = await issue(task);
        // Only a 404 (gone) or a closed task drops the row: an unread issue is a failure, and dropping its row would
        // strand a parked task in backlog with nothing to restore it.
        if (i === null || (i && CLOSED.has(String(i.status)))) { forget(task); continue; }
        if (!i) continue;
        const did = await reconcileOne(i, parkOf(task));
        if (did) out[did].push(task);
      } catch (e) {
        log("task wait settle failed", { task, err: (e as Error).message });
      }
    }
    if (out.parked.length || out.resumed.length || out.resolved.length) log("task wait settle", { parked: out.parked.length, resumed: out.resumed.length, resolved: out.resolved.length });
    return out;
  }
  const api = {
    /**
     * The job's own task waits: `reason` (its words), `until` (ISO) and/or `on` (the event it waits for); `for` owner or
     * delegator, with the `question` they answer (`asked: true`, with `for: owner`: the question went already, notify's decision or the agent's own reply, so it is recorded and not sent when it may go to them directly; `handoff: true` marks a wait on the owner's reply to a handoff).
     */
    async wait(caller: { agent: string; key: string; task: string }, b: { reason?: unknown; until?: unknown; on?: unknown; task?: unknown; for?: unknown; question?: unknown; asked?: unknown; handoff?: unknown }) {
      const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 300) : "";
      const on = typeof b.on === "string" ? b.on.trim().slice(0, 200) : "";
      const who = b.for === undefined ? undefined : b.for === "owner" || b.for === "delegator" ? b.for : null;
      const question = typeof b.question === "string" ? b.question.trim().slice(0, 1500) : "";
      if (!reason) throw fail(400, "bad_request", "send {reason, until?, on?, for?, question?}: why the task waits");
      if (who === null) throw fail(400, "bad_request", "for is owner or delegator");
      if (who && !question) throw fail(400, "bad_request", "a wait for the owner or the delegator sends the question it answers");
      // `asked`: the question went to the owner already (notify's decision, the agent's own reply): recorded, never sent again,
      // when it may go to them directly; otherwise the chief of staff gets it (escalate.ts).
      const asked = b.asked === true;
      if (asked && (who !== "owner" || !question)) throw fail(400, "bad_request", "asked: true goes with for: owner and the question that was asked");
      if (b.task !== undefined) {
        // A task that isn't the job's own is refused; a read that fails now (a 5xx, a timeout) is a 503 to try again, never a refusal.
        const r = await owner("GET", `/api/issues/${encodeURIComponent(String(b.task).slice(0, 100))}`).catch((e: Error) => { throw fail(503, "unavailable", `reading the task: ${e.message}`); });
        if (r.status !== 200 && r.status !== 404) throw fail(503, "unavailable", `reading the task: the control plane answered ${r.status}; try again`);
        if (r.status === 404 || r.json?.id !== caller.task) throw fail(409, "refused", "a wait is recorded on this job's own task only");
      }
      const t = now();
      // The deadline is validated before anything is sent: a question the recipient gets must arm a wait, never arrive for a call
      // that then fails. Its failure is held, though: a retry of the open question reuses that wait and its own `until`, so a
      // stale or malformed deadline on that retry is not this call's to use.
      const deadline = (): number => {
        let until: number;
        if (b.until !== undefined) {
          until = typeof b.until === "string" ? Date.parse(b.until) : NaN;
          if (!Number.isFinite(until) || until < t + MIN_WAIT) throw fail(400, "bad_request", "until is an ISO time at least 15 minutes ahead");
          if (until > t + MAX_WAIT) throw fail(400, "bad_request", "until is at most 7 days ahead: wait again then if it still waits");
        } else if (who) until = t + MAX_WAIT;
        else if (on) until = t + DAY;
        else throw fail(400, "bad_request", "send until (an ISO time, at most 7 days ahead) or on (the event it waits for)");
        return until;
      };
      let until = NaN;
      let deadlineError: Error | undefined;
      try { until = deadline(); } catch (e) { deadlineError = e as Error; }
      // Asked first: a question that can't be sent now fails the call (the agent tries again), never a silent wait. The
      // kernel picks who settles it (escalate.ts); an `asked` question that may not go to the owner directly goes there too.
      // A handoff (task_handoff on the agent's part of the owner's own task) is a report on their task, not a question: it waits
      // on them as before.
      const r = who && escalate && b.handoff !== true ? await escalate.ask(caller.task, who, question, asked, () => { if (deadlineError) throw deadlineError; }) : undefined;
      if (r?.sent === "limit") throw fail(429, "rate_limited", "You have asked the Fleet Steward or the chief of staff too many questions today: nothing was sent and this task's wait is unchanged. Decide with your handbook, brief and advisor, and note the assumption in your result.");
      // One open ask per task: a different question while the recorded one is unanswered fails the call, actionably (escalate.ask
      // answers only a retry of the same question). A state that can't be read now fails the call too.
      if (r?.sent === "open" && r.to) throw fail(409, "conflict", `This task's earlier question is still open with ${r.to}: tell that recipient to answer it, or finish the work that asks, then ask again. Nothing was sent and this task's wait is unchanged.`);
      if (r?.sent === "open") throw fail(503, "unavailable", "This task's ask state can't be read now, so nothing was sent and this task's wait is unchanged. Try again.");
      if (r?.sent === "ambiguous") throw fail(409, "conflict", "This task's earlier question is still open, but its recipient can't be told apart from the record (it was asked before the kernel recorded the exact destination), so nothing was sent: have that question answered with a comment on the task, then ask again.");
      // A retry of the question already open reuses that wait: nothing is sent, nothing recorded, and its own deadline stands. The
      // deadline reported is the one the gate read from the row that proved the ask open, never a fresh one no wait carries and
      // never a second read that could differ; when that row carries none, none is claimed (the held deadline is not this call's
      // either, since nothing new was armed).
      if (r?.sent === "same" || r?.sent === "asked-open") {
        return {
          waiting: true, ...(r.until ? { until: r.until } : {}), to: r.to as AskTo, asked: true,
          ...(r.sent === "asked-open" ? { note: `The owner already has this question, and this task's earlier question is still open with ${r.to as AskTo}: both replies land on the task and wake you.` } : {}),
        };
      }
      if (deadlineError) throw deadlineError;
      const to = r?.to ?? (who === "owner" ? "owner" : "delegator");
      // A marker only for a question the kernel actually asked: a handoff, or an ask that found the task gone, records none, so
      // it can't later block a real question as "still open" with a recipient nobody wrote to.
      const askedOf = r && (r.sent === "asked" || r.sent === "recorded") ? (r.to as AskTo) : undefined;
      // The wait's fact and its wake in one transaction: a wait that can't be recorded fails the call (the agent tries again).
      inTx(db, "task_wait", () => {
        if (askedOf) escalate!.record(caller.task, askedOf, t);
        // A wait the kernel didn't ask (a handoff, or an ask that found the task gone) leaves no ask for a later gate to read: the
        // marker of an earlier ask would otherwise pair with this wait's own question and hold the task against a real question.
        else if (escalate && who) db.prepare("DELETE FROM escalations WHERE key = ?").run(`ask:${caller.task}`);
        // A replacement can arrive in the same millisecond as the wait it replaces: give its fact and wake their own id, or
        // both are dropped as duplicates and the task keeps the old question. The suffix also makes the wake replace the old one.
        let n = 0;
        while (facts && !facts.record({ type: "work.waiting", subject: `wait:${caller.task}`, version: `wait@${t}${n ? `:${n}` : ""}`, at: iso(t), actor: `agent:${caller.key}`, task: caller.task, data: { reason: who ? (to === "owner" ? "owner_wait" : "delegator_wait") : "agent_wait", note: reason, until: iso(until), ...(r?.agent && to !== "owner" ? { agent: r.agent } : {}), ...(on ? { on } : {}), ...(question ? { question } : {}), ...(b.handoff === true ? { handoff: true } : {}) } })) n++;
        // The wait episode is in the wake key too: two replacements with the same `until` but a different millisecond must
        // still be different wakes, or the later one is dropped as a duplicate and the task keeps the old one.
        wakes.open({ key: `wait:${caller.task}:${until}:${t}${n ? `:${n}` : ""}`, task: caller.task, agent: caller.agent, cause: `wait: ${reason}`.slice(0, 200), at: until, replaces: `wait:${caller.task}:`, author: `agent:${caller.key}` });
      });
      // The wait is durable now; the issue is parked at once so the pinned recovery sweep (next tick: 60–90 s) never reads an
      // armed wait as stranded work, whoever holds the task and whatever the holder's status does while it waits. A write that
      // fails is logged and retried on the next settle pass: never a reason to fail the wait the agent already relies on.
      const after = await issue(caller.task).catch(() => undefined);
      freshAgents();
      if (after && !CLOSED.has(String(after.status))) await reconcileOne(after, parkOf(caller.task)).catch((e: Error) => log("task wait park failed", { task: caller.task, err: e.message }));
      log("task wait", { task: caller.task, agent: caller.key, until: iso(until), ...(who ? { to } : {}) });
      const chief = to === "steward" ? { note: "Your question went to the Fleet Steward, who settles it from the owner's decisions (and has it brought to the owner only when the call is theirs). Its answer comes as a comment on this task and wakes you." } : to === "chief_of_staff" ? { note: "Your question went to the chief of staff, who settles it (and brings it to the owner only when the call is theirs). Its answer comes as a comment on this task and wakes you." } : {};
      return { waiting: true, until: iso(until), since: iso(t), ...(who ? { to } : {}), ...(r?.sent === "asked" ? { asked: true } : {}), ...chief };
    },

    /** One sweep: the tasks whose holders it woke, and those idle in review it sent to their delegator. */
    async sweep() {
      // First the waits: a task whose wait is armed stays out of the sweep's eligible set, and one whose wait ended is restored
      // once (settle). A failure here never stops the idle sweep below.
      await settle().catch((e: Error) => log("task wait settle failed", { err: e.message }));
      const t = now(), opened: string[] = [];
      for (const i of state.read({ open: true }).tasks) {
        // Idle with nothing pending (or a wake nothing took) and an agent holds it; an owner's or unassigned task is not read.
        if (!IDLE_REASONS.has(i.reason) || !i.holder || i.holder === "owner" || t - Date.parse(i.since) < IDLE_AFTER_MS) continue;
        try {
          // Only a task the issue mirror reports in a status this sweep acts on (or one it hasn't seen) is read.
          const seen = wakes.mirror(i.task)?.status;
          if (seen && !SWEPT.has(seen) && seen !== "in_review") continue;
          const r = await owner("GET", `/api/issues/${encodeURIComponent(i.task)}`);
          const task = r.json as { status?: string; assigneeAgentId?: string | null };
          // In review with nothing running, filed or waiting on it (a merge that landed after
          // the last job): the holder has nothing left to do, so the one who delegated it decides, once per stretch.
          // Only once the state read the sweep started from includes the review (its `since` is then this stretch's), never while an
          // agent reviewer is pending on it or the control plane monitors it, and never against the holder's wake cap.
          if (r.status === 200 && String(task.status) === "in_review" && task.assigneeAgentId && escalate) {
            const s = lastStatus(i.task);
            if (s?.to_ !== "in_review" || s.at > i.since || reviewParkable(task as ParkedIssue) || (task as ParkedIssue).monitorNextCheckAt) continue;
            const to = await escalate.delegator(i.task, `idle-review:${i.task}:${i.since}`, (id) => ({
              body: `**${id} sits in review with nothing running, filed or waiting on it** (${Math.round((t - Date.parse(i.since)) / 3600_000)} hours). Read its thread and its result, then comment on it (that wakes its agent): to finish it when the work meets what was asked, or with the exact changes still needed; cancel it only when the work should not proceed.`,
              ownerText: `**${id} sits in review with nothing running, filed or waiting on it.** It is yours: finish it if the work is right, comment on ${id} with what its agent changes, or cancel it.`,
            }));
            if (to !== "seen" && to !== "gone") opened.push(i.task);
            continue;
          }
          if (i.idle_wakes >= IDLE_CAP) continue;
          // An agent no dispatcher runs would never take the wake (the steward's stuck-work rule has it; the state says `unpolled`).
          if (r.status !== 200 || !SWEPT.has(String(task.status)) || !task.assigneeAgentId || team(task.assigneeAgentId) || !wakes.polls(task.assigneeAgentId)) continue;
          // Keyed by when it became idle: a wake the dispatcher drops makes it orphaned again from then, so it is woken again
          // 15 minutes later, up to the daily cap (then the steward raises it).
          wakes.open({ key: `idle:${i.task}:${i.since}`, task: i.task, agent: task.assigneeAgentId, cause: "idle" });
          opened.push(i.task);
        } catch (e) {
          log("idle sweep: task skipped", { task: i.task, err: (e as Error).message });
        }
      }
      if (opened.length) log("idle sweep", { woken: opened.length });
      return opened;
    },
    /** The wait-park reconcile pass (see settle above): exposed for the backplane's tick and its tests. */
    settle,
    /**
     * One task's reconcile, from its own issue as Paperclip just reported it (wakes.ts event): a task put back into a scanned
     * status while its wait is armed is parked again at once, not at the next settle tick, so the recovery sweep's own tick
     * never sees a settled wait it could act on. Only tasks with an armed wait or a park row do anything.
     */
    async settleOne(i: ParkedIssue) {
      if (!armed(i.id) && !parkOf(i.id)) return;
      freshAgents();
      await reconcileOne(i, parkOf(i.id)).catch((e: Error) => log("task wait settle failed", { task: i.id, err: e.message }));
    },
  };
  // The task's own Paperclip event re-parks a restored wait at once (wakes.ts event → settleOne), so the sweep's 60–90 s tick
  // never sees a settled wait in a status it scans; the post-poll pass and the 5-minute idle sweep are the backstops.
  wakes.settleOn?.(api.settleOne);
  wakes.settleEach?.(api.settle);
  return api;
}
export type Idle = ReturnType<typeof createIdle>;

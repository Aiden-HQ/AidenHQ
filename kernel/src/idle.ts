// No idle agent-held task: every open task an agent holds is running, finished, blocked on something named, or waiting on
// something recorded. Two halves, both on the wake inbox (wakes.ts) and flow's idle view (flow.ts):
// - wait(): an agent's own wait on its job's task (POST /v1/wait, the tasks connection's task_wait): a `work.waiting` fact
//   (subject wait:<task>, reason agent_wait, its words as `note`), so flow names the wait instead of `orphaned`, and a wake
//   at `until` (at most 7 days; 24 hours when it names only an event), so the task resumes by itself. The task's next job
//   ends the wait (flow, and admission drops its timed wake); a new wait replaces the last.
// - sweep(): every few minutes, each open (todo, in_progress) task an agent holds (not a chat: it waits on the owner's next
//   message, which reopens it) that flow reports `orphaned` for 15 minutes
//   gets one wake for its holder, cause `idle` (dispatch words it), once each time it becomes orphaned (the key is when: a wake
//   the dispatcher drops leaves it orphaned again from the drop, so it is tried again 15 minutes later), at most 3 a day per
//   task. Past that cap nothing more wakes it: the Fleet Steward reads the count (`idle_wakes`) and raises the task as a critical
//   incident. An owner-held task is never swept (the steward's stale follow-up check has it), and isn't read: flow's holder
//   says no agent holds it.
import type { Api } from "./channels.ts";
import { factWriter, iso, type Log } from "./factlog.ts";
import type { Facts } from "./facts.ts";
import type { Flow } from "./flow.ts";
import { fail } from "./proxy.ts";
import type { Wakes } from "./wakes.ts";

export const IDLE_AFTER_MS = 15 * 60_000;
export const IDLE_CAP = 3;
const DAY = 864e5;
const MAX_WAIT = 7 * DAY;
/** The shortest wait: a wait is never a way to wake again at once (an idle task is woken after 15 minutes anyway). */
const MIN_WAIT = 15 * 60_000;
const SWEPT = new Set(["todo", "in_progress"]);

export function createIdle({ facts, flow, wakes, owner, team = () => false, now = Date.now, log = () => {} }: {
  facts?: Facts; flow: Pick<Flow, "idleNow">; wakes: Pick<Wakes, "open" | "polls">; owner: Api;
  /** Whether an agent id is a team record (its tasks go to a member; it never runs). */
  team?: (agent: string) => boolean;
  now?: () => number; log?: Log;
}) {
  const fact = factWriter(facts, log);
  /** Chat tasks seen (a label that stays): never read again. */
  const chats = new Set<string>();
  return {
    /** The job's own task waits: `reason` (its words), `until` (ISO) and/or `on` (the event it waits for). */
    async wait(caller: { agent: string; key: string; task: string }, b: { reason?: unknown; until?: unknown; on?: unknown; task?: unknown }) {
      const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 300) : "";
      const on = typeof b.on === "string" ? b.on.trim().slice(0, 200) : "";
      if (!reason) throw fail(400, "bad_request", "send {reason, until?, on?}: why the task waits");
      if (b.task !== undefined) {
        // A task that isn't the job's own is refused; a read that fails now (a 5xx, a timeout) is a 503 to try again, never a refusal.
        const r = await owner("GET", `/api/issues/${encodeURIComponent(String(b.task).slice(0, 100))}`).catch((e: Error) => { throw fail(503, "unavailable", `reading the task: ${e.message}`); });
        if (r.status !== 200 && r.status !== 404) throw fail(503, "unavailable", `reading the task: the control plane answered ${r.status}; try again`);
        if (r.status === 404 || r.json?.id !== caller.task) throw fail(409, "refused", "a wait is recorded on this job's own task only");
      }
      const t = now();
      let until: number;
      if (b.until !== undefined) {
        until = typeof b.until === "string" ? Date.parse(b.until) : NaN;
        if (!Number.isFinite(until) || until < t + MIN_WAIT) throw fail(400, "bad_request", "until is an ISO time at least 15 minutes ahead");
        if (until > t + MAX_WAIT) throw fail(400, "bad_request", "until is at most 7 days ahead: wait again then if it still waits");
      } else if (on) until = t + DAY;
      else throw fail(400, "bad_request", "send until (an ISO time, at most 7 days ahead) or on (the event it waits for)");
      fact({ type: "work.waiting", subject: `wait:${caller.task}`, version: `wait@${t}`, at: iso(t), actor: `agent:${caller.key}`, task: caller.task, data: { reason: "agent_wait", note: reason, until: iso(until), ...(on ? { on } : {}) } });
      wakes.open({ key: `wait:${caller.task}:${until}`, task: caller.task, agent: caller.agent, cause: `wait: ${reason}`.slice(0, 200), at: until, replaces: `wait:${caller.task}:`, author: `agent:${caller.key}` });
      log("task wait", { task: caller.task, agent: caller.key, until: iso(until) });
      return { waiting: true, until: iso(until) };
    },

    /** One sweep: the tasks whose holders it woke. */
    async sweep() {
      const t = now(), opened: string[] = [];
      for (const i of flow.idleNow().items) {
        // No agent holds it by the facts (an owner's or unassigned task), or a chat: nothing to read (a new assignee fact, or a
        // new idle stretch, brings it back).
        if (i.reason !== "orphaned" || t - Date.parse(i.reason_since) < IDLE_AFTER_MS || i.idle_wakes >= IDLE_CAP || i.holder === "unknown" || chats.has(i.task)) continue;
        try {
          const r = await owner("GET", `/api/issues/${encodeURIComponent(i.task)}`);
          const task = r.json as { status?: string; assigneeAgentId?: string | null; labels?: { name?: string }[] };
          // A chat waits on the owner's next message once answered (it reopens and wakes the chat); an agent no dispatcher
          // runs would never take the wake (the steward's stuck-work rule has it).
          if (r.status === 200 && task.labels?.some((l) => l.name === "chat")) { chats.add(i.task); continue; }
          if (r.status !== 200 || !SWEPT.has(String(task.status)) || !task.assigneeAgentId || team(task.assigneeAgentId) || !wakes.polls(task.assigneeAgentId)) continue;
          // Keyed by when it became orphaned: a wake the dispatcher drops makes it orphaned again from then, so it is woken again
          // 15 minutes later, up to the daily cap (then the steward raises it).
          wakes.open({ key: `idle:${i.task}:${i.reason_since}`, task: i.task, agent: task.assigneeAgentId, cause: "idle" });
          opened.push(i.task);
        } catch (e) {
          log("idle sweep: task skipped", { task: i.task, err: (e as Error).message });
        }
      }
      if (opened.length) log("idle sweep", { woken: opened.length });
      return opened;
    },
  };
}
export type Idle = ReturnType<typeof createIdle>;

// One agent's 7 days against the 7 before, from facts the system already holds: tasks done (control plane), approval records and
// billed cost (the kernel's /v1/work?since=), jobs (the kernel's ledger). A diagnostic for the Coach, not a ranking.
import { addDays, dayStart, ownerDay } from "./aidenhq-sdk/owner-day.ts";

export interface Closed { id: string; identifier: string; title: string; status: string; assigneeAgentId?: string | null; createdAt?: string | null; completedAt?: string | null; updatedAt: string }
/** One row of the kernel's job ledger (/v1/work?agent=): the shape the scorecard reads. */
export interface Job { state: string; started_at: string | null; task: string; started?: boolean }
export interface Facts {
  /** Tasks closed (done or cancelled) over the last 14 days. */
  closed: Closed[];
  /** Records filed or decided over the last 14 days (/v1/work?since=). */
  records: { requester: string | null; state: string; created_at: string }[];
  /** Billed cost per agent and owner's day (/v1/work?since=): rows are the calls, priced those that carried a cost. */
  usage: { agent: string | null; day: string; cost_usd: number; calls: number; priced: number }[];
  /** The agent's jobs, newest first (/v1/work?agent=&since=): how it ended, when it started, and the task it ran. Read from before
   * the oldest task in `closed` was filed, so every task that ran at all has its row here. */
  jobs: Job[];
}

const doneAt = (i: Closed) => Date.parse(i.completedAt ?? i.updatedAt);
const FAILED = ["failed", "timeout", "lost"];

/** `agent.key` names the agent in records (a requester is a key, not an id). */
export function scorecard(f: Facts, agent: { id: string; key: string }, now = Date.now(), tz = "UTC") {
  const agentId = agent.id;
  const today = ownerDay(now, tz);
  const [weekDay, priorDay] = [addDays(today, -6), addDays(today, -13)];
  const [week, prior] = [dayStart(weekDay, tz), dayStart(priorDay, tz)];
  const inWeek = (t: number) => t >= week;
  const inPrior = (t: number) => t >= prior && t < week;
  const mine = f.closed.filter((i) => i.status === "done" && i.assigneeAgentId === agentId);
  // A task the ledger holds no job for was never run by the agent: it filed itself as a holder and closed itself (a ship
  // record, a pin bump), so it is not work done — and its $0 must not dilute cost.perDone. Only a job that started makes a task
  // worked: a queued one never ran, and one that failed or was cancelled before launching never got a shell either. The read
  // covers every job from before the oldest closed task was filed, so an absent row means the task never ran, never that it
  // fell past the read's cut.
  const started = (j: Job) => (j.started === undefined ? j.state !== "admitted" : j.started);
  const worked = new Set(f.jobs.filter(started).map((j) => j.task));
  const ran = (i: Closed) => worked.has(i.id);
  const done = mine.filter((i) => inWeek(doneAt(i)) && ran(i));
  const autoClosed = mine.filter((i) => inWeek(doneAt(i)) && !ran(i));
  const ofAgent = f.usage.filter((c) => c.agent === agentId);
  const spend = (keep: (d: string) => boolean) => ofAgent.filter((c) => keep(c.day)).reduce((n, c) => n + c.cost_usd, 0);
  const costUsd = spend((d) => d >= weekDay);
  // Billed only when every call in the week carried a cost; otherwise the figure undercounts and says so.
  const rows = ofAgent.filter((c) => c.day >= weekDay);
  const mineRec = f.records.filter((r) => r.requester === agent.key);
  const recIn = (keep: (t: number) => boolean) => mineRec.filter((r) => keep(Date.parse(r.created_at)));
  return {
    window: { from: new Date(week).toISOString(), days: 7 },
    done: { count: done.length, prior: mine.filter((i) => inPrior(doneAt(i)) && ran(i)).length, autoClosed: autoClosed.length, tasks: done.slice(0, 20).map((i) => ({ identifier: i.identifier, title: i.title })) },
    approvals: { filed: recIn(inWeek).length, rejected: recIn(inWeek).filter((r) => r.state === "rejected").length, priorRejected: recIn(inPrior).filter((r) => r.state === "rejected").length },
    runsFailed: f.jobs.filter((j) => j.started_at && inWeek(Date.parse(j.started_at)) && FAILED.includes(j.state)).length,
    cost: { usd: costUsd, prior: spend((d) => d >= priorDay && d < weekDay), perDone: done.length ? costUsd / done.length : null, billed: rows.length > 0 && rows.every((c) => c.priced === c.calls) },
    daily: Array.from({ length: 7 }, (_, k) => {
      const d = addDays(weekDay, k);
      return { day: d, done: done.filter((i) => ownerDay(doneAt(i), tz) === d).length, costUsd: ofAgent.filter((c) => c.day === d).reduce((n, c) => n + c.cost_usd, 0) };
    }),
  };
}

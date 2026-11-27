// Fleet reporting from facts the system already holds: tasks done (Paperclip), approvals (the kernel's records), billed cost (the kernel's
// cost reports on the gateway's ledger), Diagnostics, not rankings: agents with different jobs are not compared on one number.
// scorecard: one agent, 7 days against the 7 before (the Agents page); fleetSummary: the whole fleet (fleet_status, the morning brief).
import type { Approval, Records } from "./records.js";
import type { Issue, Paperclip } from "./paperclip.js";
import type { PastRun } from "./runs.js";
import type { CostReport } from "./costs.js";
import { oneLine, report, type Row } from "./aidenhq-sdk/quality.js";
import { addDays, dayStart, ownerDay } from "./aidenhq-sdk/owner-day.js";

const DAY = 864e5;

export interface Facts {
  /** Tasks closed (done or cancelled) over the last 14 days. */
  closed: Issue[];
  /** Approval records over the last 14 days, any state. */
  approvals: Approval[];
  /** The kernel's daily cost report over the last 14 days: per agent and owner's day, dollars, calls (rows) and how many were priced. */
  cost: { agentId: string | null; day: string; costUsd: number; rows: number; priced: number }[];
  /** Agent runs, newest first (the kernel lists the newest 200). */
  runs: PastRun[];
}

const doneAt = (i: Issue) => Date.parse(i.completedAt ?? i.updatedAt);
const FAILED_RUN = ["failed", "timeout", "lost"];

/** One agent's 7 days against the prior 7, plus a daily trend of tasks done and billed cost. */
export function scorecard(f: Facts, agentId: string, now = Date.now(), tz = "UTC") {
  const today = ownerDay(now, tz);
  const [weekDay, priorDay] = [addDays(today, -6), addDays(today, -13)];
  const [week, prior] = [dayStart(weekDay, tz), dayStart(priorDay, tz)];
  const inWeek = (t: number) => t >= week;
  const inPrior = (t: number) => t >= prior && t < week;
  const mine = f.closed.filter((i) => i.status === "done" && i.assigneeAgentId === agentId);
  const done = mine.filter((i) => inWeek(doneAt(i)));
  const ofAgent = f.cost.filter((c) => c.agentId === agentId);
  const spend = (keep: (d: string) => boolean) => ofAgent.filter((c) => keep(c.day)).reduce((n, c) => n + c.costUsd, 0);
  const costUsd = spend((d) => d >= weekDay);
  // Billed only when every call in the week carried a cost; otherwise the figure undercounts and says so.
  const rows = ofAgent.filter((c) => c.day >= weekDay);
  const mineAp = f.approvals.filter((a) => a.requesterId === agentId);
  const apIn = (keep: (t: number) => boolean) => mineAp.filter((a) => keep(Date.parse(a.createdAt)));
  const runs = f.runs.filter((r) => r.agentId === agentId && r.startedAt && inWeek(Date.parse(r.startedAt)));
  return {
    window: { from: new Date(week).toISOString(), days: 7 },
    done: { count: done.length, prior: mine.filter((i) => inPrior(doneAt(i))).length, tasks: done.slice(0, 20).map((i) => ({ identifier: i.identifier, title: i.title })) },
    approvals: { filed: apIn(inWeek).length, rejected: apIn(inWeek).filter((a) => a.state === "rejected").length, priorRejected: apIn(inPrior).filter((a) => a.state === "rejected").length },
    runsFailed: runs.filter((r) => FAILED_RUN.includes(r.status)).length,
    cost: { usd: costUsd, prior: spend((d) => d >= priorDay && d < weekDay), perDone: done.length ? costUsd / done.length : null, billed: rows.length > 0 && rows.every((c) => c.priced === c.rows) },
    daily: Array.from({ length: 7 }, (_, k) => {
      const d = addDays(weekDay, k);
      return { day: d, done: done.filter((i) => ownerDay(doneAt(i), tz) === d).length, costUsd: ofAgent.filter((c) => c.day === d).reduce((n, c) => n + c.costUsd, 0) };
    }),
  };
}

export interface FleetSummary {
  window: "24h" | "7d";
  /** Tasks finished in the window, and applies, PRs, merges and deploys that landed. */
  shipped: { tasks: { identifier: string; title: string; agent: string; link: string }[]; landed: { id: string; action: string; target: string; task: string }[] };
  /** Failed outcomes and failed runs (open incidents are added by the caller from the detector). */
  failed: { outcomes: { id: string; action: string; target: string; task: string; text: string }[]; runs: number };
  /** Cards waiting on the owner and blocked tasks. */
  waiting: { cards: { id: string; action: string; target: string; task: string; ageHours: number }[]; blocked: { identifier: string; title: string; link: string }[] };
  spend: { yesterdayUsd: number; avg7dUsd: number; top: { agent: string; usd: number }[] };
  /** Reverts by who approved the change over the window (the cards of the last 14 days; reverts the fleet opened itself): the line for the owner's weekly digest. */
  quality: { line: string; reverted: { change: string; tier: string; link: string; revert: string }[] };
}

/** The whole fleet in a few lists. `blocked` is the open blocked tasks; `names` maps agent ids to names. */
export function fleetSummary(f: Facts, o: { window: "24h" | "7d"; blocked: Issue[]; names: Map<string, string>; now?: number; tz?: string }): FleetSummary {
  const now = o.now ?? Date.now();
  const since = now - (o.window === "24h" ? DAY : 7 * DAY);
  const link = (identifier: string) => `#/t/${identifier}`;
  const landed = ["push", "pr", "merge", "apply", "deploy_app"];
  const recent = f.approvals.filter((a) => Date.parse(a.usedAt ?? a.createdAt) >= since);
  const card = (a: Approval) => ({ id: a.id, action: a.action, target: a.target, task: a.identifier });
  const today = ownerDay(now, o.tz ?? "UTC");
  const yesterday = addDays(today, -1);
  const total = (keep: (d: string) => boolean) => f.cost.filter((c) => keep(c.day)).reduce((n, c) => n + c.costUsd, 0);
  const week = Array.from({ length: 7 }, (_, k) => addDays(today, -(k + 1)));
  // The same trailing week as avg7dUsd, per agent: the split of the figure the summary shows, not a different day's.
  const perAgent = new Map<string, number>();
  for (const c of f.cost) if (week.includes(c.day) && c.agentId) perAgent.set(c.agentId, (perAgent.get(c.agentId) ?? 0) + c.costUsd);
  const rows: Row[] = f.approvals.map((a) => ({ id: a.id, kind: a.action, args: a.args, tier: a.tier, panel: a.panel, by: a.decidedBy, state: a.outcome === "applied" ? "done" : a.outcome === "failed" ? "failed" : a.state, at: a.usedAt ?? a.createdAt, outcome: a.outcomeText, identifier: a.identifier }));
  const quality = report(rows, {}, now, [o.window === "24h" ? 1 : 7]);
  // A release apply that did not install closes its task cancelled, but a done task with apply cards and none of them
  // `outcome === "applied"` shipped nothing: the card data says how it ended, never the closing comment's prose. A task with
  // no apply card is unaffected, and one whose later apply did land counts. A card names its task by its identifier, or by
  // its id when the filer didn't know the identifier.
  const cards = new Map<string, Approval[]>();
  for (const a of f.approvals) cards.set(a.identifier, [...(cards.get(a.identifier) ?? []), a]);
  const shippedTask = (i: Issue) => {
    const mine = [...(cards.get(i.id) ?? []), ...(i.identifier === i.id ? [] : cards.get(i.identifier) ?? [])];
    const applies = mine.filter((a) => a.action === "apply");
    return !applies.length || applies.some((a) => a.outcome === "applied");
  };
  return {
    window: o.window,
    quality: { line: oneLine(quality), reverted: quality.reverted },
    shipped: {
      tasks: f.closed.filter((i) => i.status === "done" && doneAt(i) >= since && shippedTask(i)).map((i) => ({ identifier: i.identifier, title: i.title, agent: (i.assigneeAgentId && o.names.get(i.assigneeAgentId)) || "someone", link: link(i.identifier) })),
      landed: recent.filter((a) => landed.includes(a.action) && a.outcome === "applied").map(card),
    },
    failed: {
      outcomes: recent.filter((a) => a.outcome === "failed").map((a) => ({ ...card(a), text: (a.outcomeText ?? "").slice(0, 200) })),
      runs: f.runs.filter((r) => r.startedAt && Date.parse(r.startedAt) >= since && FAILED_RUN.includes(r.status)).length,
    },
    waiting: {
      cards: f.approvals.filter((a) => a.state === "pending" && a.tier === 2).map((a) => ({ ...card(a), ageHours: Math.round((now - Date.parse(a.createdAt)) / 36e5) })),
      blocked: o.blocked.map((i) => ({ identifier: i.identifier, title: i.title, link: link(i.identifier) })),
    },
    spend: {
      yesterdayUsd: total((d) => d === yesterday),
      avg7dUsd: total((d) => week.includes(d)) / 7,
      top: [...perAgent].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, usd]) => ({ agent: o.names.get(id) ?? id, usd })),
    },
  };
}

/** Gathers the 14 days of facts (done tasks, cards, billed cost, runs) */
export async function gatherFacts(pc: Paperclip, recentRuns: () => Promise<PastRun[]>, costs: CostReport, records: Pick<Records, "list">, now = Date.now(), tz = "UTC"): Promise<Facts> {
  const [from, to] = [new Date(dayStart(addDays(ownerDay(now, tz), -13), tz)).toISOString(), new Date(now + 1000).toISOString()];
  const [closed, runs, cards, daily] = await Promise.all([pc.closedSince(from, "500"), recentRuns(), records.list("recent", { limit: 1000 }), costs<{ agentId: string | null; day: string; usd: number; calls: number; priced: number }[]>("daily", { from, to })]);
  return { closed, runs, approvals: cards.filter((a) => a.createdAt > from || (a.decidedAt ?? "") > from), cost: daily.map((c) => ({ agentId: c.agentId, day: c.day, costUsd: c.usd, rows: c.calls, priced: c.priced })) };
}

/** fleet_status's `summary`: the fleet in a few lists over the window (24h or 7d). */
export async function statusSummary(pc: Paperclip, recentRuns: () => Promise<PastRun[]>, costs: CostReport, records: Pick<Records, "list">, window: "24h" | "7d", tz: string): Promise<FleetSummary> {
  const [facts, open, agents] = await Promise.all([gatherFacts(pc, recentRuns, costs, records, Date.now(), tz), pc.openIssues(), pc.agents()]);
  return fleetSummary(facts, { window, blocked: open.filter((i) => i.status === "blocked"), names: new Map(agents.map((a) => [a.id, a.name])), tz });
}

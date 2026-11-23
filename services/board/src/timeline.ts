// The agent page's Activity tab (web/src/AgentPage.tsx): what an agent did, newest first, one entry per kernel job. One
// kernel read (GET /v1/work?agent=, kernel/src/work.ts: the agent's last 50 jobs, each with the wake that started it, why
// it ended, the gateway's billed cost and the records it filed), shaped here. A job's steps load when the owner opens it
// (the run page's read, GET /api/runs/:id). Everything the agent produced (its error text) is untrusted: shown as plain text.
// Paperclip's agents, tasks and routines as far as the timeline names them (paperclip.ts; the web build reads this file too).
type Agent = { id: string; name: string; metadata?: Record<string, unknown> | null };
type Issue = { id: string; identifier: string; title: string };
type Routine = { id: string; title: string };

/** A job as GET /v1/work?agent= gives it. */
export interface AgentJob {
  id: string;
  task: string;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  steps: number;
  routine: string | null;
  identifier?: string | null;
  cause?: string | null;
  caused_by?: string | null;
  cost_usd?: number | null;
  /** A routine run that only closed or parked its task (kernel quiet.ts): the kernel leaves these out before its limit. */
  quiet?: boolean;
  error?: string | null;
  writes?: { id: string; kind: string; tier: number; state: string; decided_by: string | null; review_code: string | null; created_at: string }[];
}

export type Outcome = "running" | "done" | "failed" | "stopped";

export interface TimelineWrite {
  id: string;
  /** The kind as people read it (push, pr, merge, apply, or a module's kind whole). */
  action: string;
  tier: number;
  /** pending (with the reviewer or the owner), approved, ran, failed, rejected, closed. */
  state: "pending" | "approved" | "ran" | "failed" | "rejected" | "closed";
  /** Who decided, in words: code, the AI reviewer, the panel, you; null while pending or when nothing decided (Tier 0). */
  decidedBy: string | null;
}

export interface TimelineEntry {
  id: string;
  outcome: Outcome;
  /** The kernel's own end state (done, failed, timeout, lost, cancelled, running, admitted). */
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  task: { id: string; identifier: string | null; title: string | null };
  /** What woke the agent, in words ("Your comment", "Schedule: Daily brief", "Assigned by Aiden"). */
  trigger: string;
  steps: number;
  /** What the gateway billed for the job; null while it runs or when the kernel no longer knows. */
  costUsd: number | null;
  error: string | null;
  writes: TimelineWrite[];
}

const OUTCOME: Record<string, Outcome> = { running: "running", admitted: "running", done: "done", cancelled: "stopped" };
const KIND: Record<string, string> = { "apps-platform.deploy": "deploy_app", "apps-platform.run": "app_run" };
const WRITE_STATE: Record<string, TimelineWrite["state"]> = { review: "pending", owner: "pending", approved: "approved", claimed: "approved", done: "ran", failed: "failed", unknown: "failed", rejected: "rejected", stale: "closed", cancelled: "closed" };

/** Who decided a record, in words, from its decided_by stamp (kernel/src/writes.ts, records.ts). */
export function deciderWords(by: string | null | undefined): string | null {
  const d = by ?? "";
  if (!d) return null;
  if (d === "reviewer:kernel/code") return "code";
  if (d.startsWith("reviewer:")) return d.includes("+") ? "the review panel" : d.includes(";unsure:") ? "the AI reviewer, approved; the second reviewer was unsure" : "the AI reviewer";
  if (d.startsWith("stale:")) return "code (the request moved)";
  if (d.startsWith("kernel")) return "code";
  return "you";
}

/** Who caused a wake, from its wake.opened fact's author: you, an agent by name, a module, the kernel. */
function causer(by: string | null | undefined, agents: Agent[]): string | null {
  const d = by ?? "";
  if (d.startsWith("account:") || d.startsWith("owner")) return "you";
  if (d.startsWith("agent:")) {
    const key = d.slice("agent:".length);
    return agents.find((a) => a.metadata?.setupKey === `aidenhq:${key}` || a.id === key)?.name ?? key;
  }
  if (d.startsWith("module:")) return d.slice("module:".length);
  return null;
}

/** A wake's cause (kernel/src/wakes.ts) in words, with who caused it when known. */
export function triggerWords(cause: string | null | undefined, by: string | null | undefined, agents: Agent[], routineTitle?: string): string {
  const who = causer(by, agents);
  const c = cause ?? "";
  const from = who ? (who === "you" ? " by you" : ` by ${who}`) : "";
  if (c === "comment") return who === "you" ? "Your comment" : who ? `A comment from ${who}` : "A comment";
  if (c === "assigned") return `Assigned${from}`;
  if (c === "status") return `Status changed${from}`;
  if (c === "reopen") return `Reopened${from}`;
  if (c === "unblocked") return "Unblocked: what it waited on finished";
  if (c === "routine" || c.startsWith("routine:")) return `Schedule${routineTitle ? `: ${routineTitle}` : c.length > 8 ? `: ${c.slice(8)}` : ""}`;
  if (c.startsWith("scheduled")) return c.length > 11 ? `Its own follow-up: ${c.slice(11).trim()}` : "Its own follow-up";
  if (!c) return "Started";
  return `${c[0]!.toUpperCase()}${c.slice(1)}${from}`;
}

/** The kernel's jobs as the Activity tab shows them. `issues`: what the board already holds, for task titles (else the identifier). */
export function timelineOf(jobs: AgentJob[], { agents = [], issues = [], routines = [] }: { agents?: Agent[]; issues?: Issue[]; routines?: Routine[] } = {}): TimelineEntry[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  return jobs.map((j) => {
    const issue = byId.get(j.task);
    const routine = j.routine ? routines.find((r) => r.id === j.routine) : undefined;
    return {
      id: j.id,
      outcome: OUTCOME[j.state] ?? "failed",
      state: j.state,
      startedAt: j.started_at,
      endedAt: j.ended_at,
      task: { id: j.task, identifier: j.identifier ?? issue?.identifier ?? null, title: issue?.title ?? routine?.title ?? null },
      trigger: triggerWords(j.cause, j.caused_by, agents, routine?.title),
      steps: j.steps,
      costUsd: typeof j.cost_usd === "number" ? j.cost_usd : null,
      // The kernel's stop line names the account; the owner reads "Stopped by you".
      error: j.error ? (/^stopped by (account|owner)/.test(j.error) ? "Stopped by you." : j.error.slice(0, 300)) : null,
      writes: (j.writes ?? []).map((w) => ({ id: w.id, action: KIND[w.kind] ?? w.kind.replace(/^(runner|kernel)\./, ""), tier: w.tier, state: WRITE_STATE[w.state] ?? "closed", decidedBy: deciderWords(w.decided_by) })),
    };
  });
}

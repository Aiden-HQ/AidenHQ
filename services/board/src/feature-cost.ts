// What a feature cost and how long it took. A feature is a top-level task and every task delegated under it (Paperclip parent
// links); the figures come from the kernel's cost reports (billed spend per run and task, from its ledger), its approval records
// (merges) and the tasks' own times. By feature, never by agent or person.
// Calls with no task are never guessed onto a feature: they are reported as unattributed.
import type { CostReport } from "./costs.js";
import type { Issue } from "./paperclip.js";
import type { Approval } from "./records.js";

const DAY = 864e5;
/** A feature's tree is read this deep and this wide at most; past that it is cut off (and says so). */
const MAX_DEPTH = 8;
const MAX_TASKS = 300;

/** One task's model calls (the kernel's runs report): their count and dollars, and its kernel jobs (every agent run is one) and their wall time. */
export interface TaskUsage {
  issueId: string;
  calls: number;
  usd: number;
  jobs: number;
  jobMs: number;
}
type Runs = { tasks: TaskUsage[]; unattributed: { usd: number; calls: number } | null };

/** The tasks' usage (ids or identifiers), since `from` when given (else over the whole rollup); with the calls since `from` that name no task. */
export const runsOf = (report: CostReport, issues: string[], from?: string) => report<Runs>("runs", { issues, ...(from ? { from } : {}) });

export interface FeatureCost {
  identifier: string;
  title: string;
  createdAt: string;
  /** Tasks in the feature, the root included. */
  tasks: number;
  usd: number;
  calls: number;
  /** Kernel jobs (agent runs) on the tree, and their wall time: for each, the span of its model calls on its task. */
  jobs: number;
  jobMs: number;
  /** From the root's creation to the last task's completion or merge; to now while any task is still open. */
  elapsedMs: number;
  running: boolean;
  prs: number;
  /** The tree was cut at the depth or size limit. */
  truncated: boolean;
}

/** The root's descendants, breadth first, through `childrenOf` (Paperclip's list, or a map held in memory). */
export async function descendants(root: Pick<Issue, "id">, childrenOf: (id: string) => Promise<Issue[]>): Promise<{ tasks: Issue[]; truncated: boolean }> {
  const seen = new Set([root.id]);
  const tasks: Issue[] = [];
  let level = [root.id];
  let truncated = false;
  for (let depth = 0; level.length; depth++) {
    if (depth >= MAX_DEPTH) return { tasks, truncated: true };
    const next: string[] = [];
    // Paperclip limits concurrent list requests per client: a few at a time.
    for (let i = 0; i < level.length; i += 4) {
      for (const kids of await Promise.all(level.slice(i, i + 4).map(childrenOf))) {
        for (const k of kids) {
          if (seen.has(k.id)) continue;
          if (tasks.length >= MAX_TASKS) truncated = true;
          else (seen.add(k.id), tasks.push(k), next.push(k.id));
        }
      }
    }
    level = next;
  }
  return { tasks, truncated };
}

const closedAt = (i: Issue) => Date.parse(i.completedAt ?? i.cancelledAt ?? i.updatedAt);
const isClosed = (i: Issue) => i.status === "done" || i.status === "cancelled";

/** One feature's figures. `usage` and `approvals` may hold other tasks' rows: only the tree's own count. */
export function featureCost(root: Issue, tree: Issue[], usage: TaskUsage[], approvals: Approval[], now = Date.now(), truncated = false): FeatureCost {
  const all = [root, ...tree];
  const ours = new Set(all.flatMap((i) => [i.id, i.identifier]));
  const calls = usage.filter((u) => ours.has(u.issueId));
  const merged = approvals.filter((a) => a.action === "merge" && a.outcome === "applied" && (ours.has(a.issueId) || ours.has(a.identifier)));
  const running = !all.every(isClosed);
  const last = Math.max(...all.filter(isClosed).map(closedAt), ...merged.map((a) => Date.parse(a.usedAt ?? a.createdAt)));
  const start = Date.parse(root.createdAt);
  return {
    identifier: root.identifier,
    title: root.title,
    createdAt: root.createdAt,
    tasks: all.length,
    usd: calls.reduce((n, u) => n + u.usd, 0),
    calls: calls.reduce((n, u) => n + u.calls, 0),
    jobs: calls.reduce((n, u) => n + u.jobs, 0),
    jobMs: calls.reduce((n, u) => n + u.jobMs, 0),
    elapsedMs: Math.max(0, (running || !Number.isFinite(last) ? now : last) - start),
    running,
    prs: merged.length,
    truncated,
  };
}

/** The last 14 days' top-level tasks that have delegated work, each rolled up, newest first; `from` is the window's start. */
export async function recentFeatures(pool: Issue[], report: CostReport, approvals: Approval[], now = Date.now()) {
  const from = now - 14 * DAY;
  const byParent = new Map<string, Issue[]>();
  for (const i of pool) if (i.parentId) byParent.set(i.parentId, [...(byParent.get(i.parentId) ?? []), i]);
  const trees: { root: Issue; tasks: Issue[]; truncated: boolean }[] = [];
  for (const root of pool.filter((i) => !i.parentId && Date.parse(i.createdAt) >= from && byParent.has(i.id))) trees.push({ root, ...(await descendants(root, async (id) => byParent.get(id) ?? [])) });
  const { tasks, unattributed } = await runsOf(report, trees.flatMap((t) => [t.root, ...t.tasks]).flatMap((i) => [i.id, i.identifier]), new Date(from).toISOString());
  const byIssue = new Map(tasks.map((u) => [u.issueId, u]));
  const ofTree = (t: Issue[]) => t.flatMap((i) => [i.id, i.identifier]).flatMap((id) => byIssue.get(id) ?? []);
  return {
    features: trees.map((t) => featureCost(t.root, t.tasks, ofTree([t.root, ...t.tasks]), approvals, now, t.truncated)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // Calls in the window that name no task: they belong to no feature, and no guess is made.
    unattributed: unattributed!,
  };
}

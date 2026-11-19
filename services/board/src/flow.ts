// The Flow page's reads (web/src/Flow.tsx): the kernel's GET /v1/flow (kernel/src/flow.ts, docs/design/flow.md §5), read the way
// runs.ts reads /v1/work: summary (bottlenecks, DORA, churn, fleet), idle items, and one item's waterfall. Seconds throughout.

/** One stage's row of the summary. With fewer than five occurrences the percentiles are absent and `samples` has the raw durations. */
export interface FlowStage {
  name: string;
  label: string;
  n: number;
  work_p50?: number;
  work_p75?: number;
  wait_p50?: number;
  wait_p75?: number;
  /** Seconds waited per reason (grader_retry, checks, owner, ...). */
  waits: Record<string, number>;
  samples?: number[];
  /** The items behind the p75: the slowest occurrences, slowest first (when the kernel lists them). */
  slow?: { task: string; identifier?: string; seconds: number }[];
}

export interface FlowSummary {
  stages: FlowStage[];
  dora: { deploys_per_day: number; lead_p50: number | null; failure_rate: number | null; restore_p50: number | null } | null;
  churn: { rewritten_30d: number; hot_lines: number } | null;
  fleet: {
    first_pass_grade?: number | null;
    first_pass_review?: number | null;
    cost_per_outcome?: number | null;
    [k: string]: unknown;
  };
}

export interface IdleItem {
  task: string;
  identifier: string;
  since: string;
  reason: string;
  holder: string | null;
}

export interface Waterfall {
  task: string;
  root: string;
  facts: { type: string; subject: string; at: string; actor: string; data?: Record<string, unknown> }[];
  stages: { name: string; label: string; start: string; end: string | null; actor: string | null; task: string }[];
  idle: { start: string; end: string | null; reason: string; blocked_on?: string; holder: string | null }[];
}

export interface FlowQuery {
  since: string;
  to: string;
  scope?: string;
}

/** The kernel's flow reads, with the board's key. */
export interface Flow {
  summary(q: FlowQuery): Promise<FlowSummary>;
  idle(): Promise<IdleItem[]>;
  item(id: string): Promise<Waterfall | null>;
  /** The code host's history import (the page's button); absent when no code host is enabled. */
  backfill?: () => Promise<void>;
}

export function kernelFlow(k: { url: string; token: string }, backfill?: Flow["backfill"]): Flow {
  const get = async (q: URLSearchParams) => {
    const res = await fetch(`${k.url}/v1/flow?${q}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
    return res.json();
  };
  return {
    summary: async ({ since, to, scope }) => (await get(new URLSearchParams({ since, to, by: "stage", ...(scope && scope !== "all" ? { scope } : {}) }))) as FlowSummary,
    idle: async () => ((await get(new URLSearchParams({ idle: "1" }))) as { items: IdleItem[] }).items,
    item: async (id) => (await get(new URLSearchParams({ item: id }))) as Waterfall | null,
    backfill,
  };
}

/** The code host's backfill endpoint with its module token (the owner's button; the host answers once the import is queued). */
export function codehostBackfill(c: { url: string; token: string }): NonNullable<Flow["backfill"]> {
  return async () => {
    const res = await fetch(`${c.url}/aidenhq/v1/backfill`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`the code host answered ${res.status}`);
  };
}

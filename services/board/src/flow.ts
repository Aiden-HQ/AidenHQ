// The Flow page's reads (web/src/Flow.tsx): the kernel's GET /v1/flow (kernel/src/flow.ts, docs/design/flow.md §5), read the way
// runs.ts reads /v1/work: summary (bottlenecks, DORA, churn, fleet, insights), idle items, one item's waterfall, and the journeys
// (docs/design/flow-insights.md: the timeline, a piece of work's or a PR's). Seconds throughout.

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
  slow?: { task: string; identifier: string | null; seconds: number }[];
}

export interface FlowSummary {
  stages: FlowStage[];
  dora: { deploys_per_day: number; lead_p50: number | null; failure_rate: number | null; restore_p50: number | null } | null;
  churn: { rewritten_30d: number | null; hot_lines: number } | null;
  fleet: {
    first_pass_review?: number | null;
    cost_per_outcome?: number | null;
    [k: string]: unknown;
  };
  /** The journey the insights are over (the asked one, else the first declared one with items). */
  journey?: string | null;
  /** The journey analytics (docs/design/flow-insights.md §3); null when no journey has items. */
  insights?: Insights | null;
}

/** A metric with its weekly series and its value over the previous period of the same length. */
export interface Metric {
  value: number | null;
  previous: number | null;
  weekly: { week: string; value: number | null }[];
}

export type AuthorKind = "agent" | "owner" | "outside";

export interface Insights {
  phases: { name: string; label: string; n: number; p50: number | null; p85: number | null; p95: number | null; idle_s: number; rounds_mean: number; weekly: { week: string; p50: number | null; n: number }[] }[];
  scatter: { subject: string; url: string | null; task: string | null; identifier: string | null; title: string | null; end: string; total_s: number; author_kind: string | null }[];
  /** Per phase: how many items took each number of rounds. */
  rounds: Record<string, Record<string, number>>;
  rejections: { reason: string; n: number }[];
  first_pass: { week: string; rate: number | null; n: number }[];
  aging: { subject: string; url: string | null; task: string | null; identifier: string | null; author_kind: string | null; title: string | null; phase: string; age_s: number; idle_reason: string | null }[];
  cfd: { day: string; counts: Record<string, number> }[];
  /** The items started in the period, how many had each phase, and how many ended delivered. */
  funnel: { step: string; label: string; n: number }[];
  /** Delivered: a PR merged, a piece of work done; undelivered: closed or cancelled. */
  cost: { per_delivered: { week: string; usd: number | null }[]; by_agent: { key: string; usd: number; delivered: number }[]; by_model: { key: string; usd: number; delivered: number }[]; undelivered_usd: number };
  dora5: { deploys_per_day: Metric; lead_time_s: Metric; change_fail_rate: Metric; recovery_s: Metric; rework_rate: Metric };
  throughput: { day: string; delivered: number; started: number }[];
  bottlenecks: { phase: string; kind: "idle" | "rounds" | "slow"; text: string }[];
}

/** A journey a module declares (module.yaml `journeys:`), as the kernel lists it. */
export interface JourneyInfo {
  name: string;
  label: string;
  phases: { name: string; label: string }[];
}

/** One item of a journey (a piece of work, or a PR): its phases as blocks, loops folded into rounds. */
export interface JourneyItem {
  subject: string;
  title: string | null;
  task: string | null;
  identifier: string | null;
  url: string | null;
  /** A PR's own. */
  repo: string | null;
  number: number | null;
  author: string | null;
  author_kind: AuthorKind | null;
  /** The other PRs and issues it holds (a piece of work's PRs and issue; a PR's issue). */
  links: { subject: string; url: string | null }[];
  state: "open" | "merged" | "closed" | "deployed" | "done" | "cancelled";
  start: string;
  end: string | null;
  total_s: number;
  blocks: { phase: string; start: string; end: string; rounds: number; idle_s: number; idle: Record<string, number> }[];
}

export interface JourneyList extends JourneyInfo {
  journey: string;
  items: JourneyItem[];
  truncated: boolean;
}

export type JourneySort = "recent" | "slowest" | "rounds";

export interface JourneyQuery {
  journey: string;
  since: string;
  to: string;
  /** The author kinds to keep; all when absent. */
  author?: AuthorKind[];
  sort?: JourneySort;
  limit?: number;
}

export interface IdleItem {
  task: string;
  identifier: string | null;
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
  /** The journey the insights are over. */
  journey?: string;
}

/** The kernel's flow reads, with the board's key. */
export interface Flow {
  summary(q: FlowQuery): Promise<FlowSummary>;
  idle(): Promise<IdleItem[]>;
  item(id: string): Promise<Waterfall | null>;
  /** One task's own facts (the kernel's ?task=), never its descendants'. */
  task(id: string): Promise<Waterfall | null>;
  journeys(): Promise<JourneyInfo[]>;
  journey(q: JourneyQuery): Promise<JourneyList | null>;
}

export function kernelFlow(k: { url: string; token: string }): Flow {
  const get = async (q: URLSearchParams) => {
    const res = await fetch(`${k.url}/v1/flow?${q}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
    return res.json();
  };
  return {
    summary: async ({ since, to, scope, journey }) => (await get(new URLSearchParams({ since, to, by: "stage", ...(scope && scope !== "all" ? { scope } : {}), ...(journey ? { insights: journey } : {}) }))) as FlowSummary,
    idle: async () => ((await get(new URLSearchParams({ idle: "1" }))) as { items: IdleItem[] }).items,
    task: async (id) => (await get(new URLSearchParams({ task: id }))) as Waterfall | null,
    item: async (id) => (await get(new URLSearchParams({ item: id }))) as Waterfall | null,
    journeys: async () => ((await get(new URLSearchParams({ journeys: "1" }))) as { journeys: JourneyInfo[] } | null)?.journeys ?? [],
    journey: async ({ journey, since, to, author, sort, limit }) =>
      (await get(new URLSearchParams({ journey, since, to, ...(author ? { author: author.join(",") } : {}), ...(sort ? { sort } : {}), ...(limit ? { limit: String(limit) } : {}) }))) as JourneyList | null,
  };
}

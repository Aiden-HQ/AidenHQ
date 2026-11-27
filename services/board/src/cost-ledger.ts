// The Costs tab's ledger views: what the model gateway's ledger says was billed, from the kernel's cost reports (its rollup of
// the ledger per 15-minute bucket, grouped there) so the browser gets groups, never rows. Every range snaps to those buckets.
//  - summary: the overview (today / 7 / 30 days against the period before, the OpenRouter key's limit, the install's day and
//    month against its spend limits, from the kernel's spend summary) and,
//    over the chosen range, spend by model, by kind of call (lane), by agent and over time by model: one report (summary).
//  - top: one agent's or model's most expensive runs and tasks in the range, for the drill-down.
import { BadRequest } from "./board.js";
import { departmentOf } from "./activity.js";
import type { CostReport, KeyUsage, SpendSummary } from "./costs.js";
import type { Agent } from "./paperclip.js";
import type { CatalogModel } from "./model-catalog.js";

const DAY = 864e5;
/** The kernel's rollup buckets: every range's start is floored to one, its end ceiled. */
const STEP = 15 * 60_000;
const floor = (ms: number) => Math.floor(ms / STEP) * STEP;
const ceil = (ms: number) => Math.ceil(ms / STEP) * STEP;
/** The kernel keeps 62 days of the rollup; a range may not reach further back than that. */
const MAX_SPAN = 62 * DAY;

/** A group's sums as the kernel reports them; msSum and msN cover the ok calls that timed themselves. */
export interface LedgerMetrics {
  usd: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  interrupted: number;
  msSum: number;
  msN: number;
}
/** The range's figures for one model, lane and agent (null: a system call). */
interface LedgerCell extends LedgerMetrics {
  model: string;
  lane: string;
  agentId: string | null;
}
/** The kernel's summary report (kernel/src/gateway/costs.ts). */
interface Summary {
  earliest: string | null;
  groups: LedgerCell[];
  /** Dollars and calls by the viewer's hour or day and model. */
  series: { t: string; model: string; usd: number; calls: number }[];
  windows: { usd: number; calls: number }[];
  modelOrder: string[];
  tasks: { count: number; usd: number; top: { issueId: string; agentId: string | null; usd: number; calls: number }[] };
  failed: { agentId: string | null; status: string; calls: number; usd: number }[];
  loops: { runId: string; agentId: string | null; calls: number; usd: number; first: string; last: string }[];
}
type GroupRow = LedgerMetrics & { a: string | null; b: string | null; first: string | null; last: string | null };
export type LedgerFilter = { agentId?: string; model?: string };

/** A group's figures; ms is the mean latency of its ok calls that timed themselves (null: none did). */
export interface Metrics {
  usd: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  /** Calls a kernel restart cut off: their trued-up cost (OpenRouter's record), never an error. */
  interrupted: number;
  ms: number | null;
}
const ZERO: LedgerMetrics = { usd: 0, calls: 0, input: 0, cached: 0, output: 0, errors: 0, interrupted: 0, msSum: 0, msN: 0 };
const plus = (a: LedgerMetrics, b: LedgerMetrics): LedgerMetrics => ({ usd: a.usd + b.usd, calls: a.calls + b.calls, input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, errors: a.errors + b.errors, interrupted: a.interrupted + b.interrupted, msSum: a.msSum + b.msSum, msN: a.msN + b.msN });
const metrics = (m: LedgerMetrics = ZERO): Metrics => ({ usd: m.usd, calls: m.calls, input: m.input, cached: m.cached, output: m.output, errors: m.errors, interrupted: m.interrupted, ms: m.msN ? Math.round(m.msSum / m.msN) : null });
/** Sums cells by key, most spend first. */
function rollup<T>(cells: T[], key: (c: T) => string, m: (c: T) => LedgerMetrics): [string, LedgerMetrics][] {
  const out = new Map<string, LedgerMetrics>();
  for (const c of cells) out.set(key(c), plus(out.get(key(c)) ?? ZERO, m(c)));
  return [...out].sort((a, b) => b[1].usd - a[1].usd || b[1].calls - a[1].calls);
}

export type Bucket = "hour" | "day";
export interface LedgerRange {
  from: string;
  to: string;
  bucket: Bucket;
  /** The viewer's offset from UTC in minutes (east positive): the time chart buckets by their clock. Caps and "today" stay UTC. */
  offset: number;
}

/**
 * from/to (ISO instants, to exclusive; snapped to the 15-minute buckets, from floored and to ceiled) and bucket from the query;
 * defaults to the last 7 days by day. Fails loudly on nonsense.
 */
export function ledgerRange(q: URLSearchParams, now = Date.now()): LedgerRange {
  const rawTo = q.get("to") ? Date.parse(q.get("to")!) : now;
  const rawFrom = q.get("from") ? Date.parse(q.get("from")!) : rawTo - 7 * DAY;
  if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) throw new BadRequest("from and to are ISO dates");
  if (rawTo <= rawFrom) throw new BadRequest("to must be after from");
  if (rawTo - rawFrom > MAX_SPAN) throw new BadRequest("a range spans at most 62 days (the usage kept)");
  const from = floor(rawFrom), to = ceil(rawTo);
  const bucket = (q.get("bucket") ?? (to - from <= 2 * DAY ? "hour" : "day")) as Bucket;
  if (bucket !== "hour" && bucket !== "day") throw new BadRequest("bucket is hour or day");
  if (bucket === "hour" && to - from > 7 * DAY) throw new BadRequest("hourly buckets cover at most 7 days");
  const offset = Number(q.get("offset") ?? 0);
  // Every real timezone is a whole quarter hour from UTC, so the viewer's hours and days are whole buckets.
  if (!Number.isInteger(offset) || offset % 15 || Math.abs(offset) > 14 * 60) throw new BadRequest("offset is a whole number of quarter hours from UTC, in minutes");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket, offset };
}

/** What the ledger shows of a task. */
export type TaskNames = { identifier: string | null; title: string | null; status: string | null };

export interface LedgerDeps {
  report: CostReport;
  agents: () => Promise<Agent[]>;
  key: () => Promise<KeyUsage | string>;
  /** The kernel's spend summary (the install's day and month against its limits); without it no limit shows. */
  spend: () => Promise<SpendSummary | null>;
  /** Tasks' identifiers, titles and statuses by id, in one read (the kernel's issue mirror); without it the task figures are left out. */
  issues?: (ids: string[]) => Promise<Map<string, TaskNames>>;
  /**
   * OpenRouter's models as the gateway lists them (their prices feed the cache savings), from a read the board already made:
   * a cold gateway catalog must never hold the ledger back, so this never waits. Without them the savings are left out.
   */
  catalog?: () => CatalogModel[] | null;
}

export async function ledgerSummary(d: LedgerDeps, r: LedgerRange, now = Date.now()) {
  const iso = (n: number) => new Date(n).toISOString();
  // The overview's periods and the insights' windows, each snapped: to the bucket after now, from the one before its start.
  const end = ceil(now);
  const midnight = Math.floor(now / DAY) * DAY;
  const week = floor(now - 7 * DAY), month = floor(now - 30 * DAY);
  const from = Date.parse(r.from), to = Date.parse(r.to);
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const monday = midnight - ((new Date(now).getUTCDay() + 6) % 7) * DAY;
  const W = { today: [midnight, end], yesterday: [midnight - DAY, end - DAY], week: [week, end], prevWeek: [2 * week - end, week], month: [month, end], prevMonth: [2 * month - end, month], prev: [2 * from - to, from], monthStart: [monthStart, end], monday: [monday, end] } satisfies Record<string, [number, number]>;
  const names = Object.keys(W) as (keyof typeof W)[];
  const [agents, key, spend, s] = await Promise.all([
    d.agents().catch(() => [] as Agent[]),
    d.key(),
    d.spend().catch(() => null),
    d.report<Summary>("summary", { from: r.from, to: r.to, bucket: r.bucket, offset: r.offset, windows: names.map((n) => W[n].map(iso)), order: [iso(month), iso(end)], top: d.issues ? TASK_SAMPLE : 0, loop: LOOP_CALLS }),
  ]);
  const win = Object.fromEntries(names.map((n, i) => [n, s.windows[i]!])) as Record<keyof typeof W, { usd: number; calls: number }>;
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? `Agent ${id.slice(0, 8)}`;
  const today = new Map((spend?.agents ?? []).map((a) => [a.agent_id, a]));
  const earliest = s.earliest;
  /** Spend in a window and in the same span just before it; prev null when the ledger doesn't reach back that far. */
  const period = (cur: keyof typeof W, before: keyof typeof W) => ({ ...win[cur], prev: earliest !== null && earliest <= iso(W[before][0]) ? win[before].usd : null });

  const cube = s.groups;
  const all = (c: LedgerMetrics) => c;
  const total = rollup(cube, () => "", all)[0]?.[1];
  const byAgentModel = rollup(cube.filter((c) => c.agentId), (c) => `${c.agentId}\n${c.model}`, all);
  // An agent's main model: the one it spent most on in the range.
  const mainModel = new Map<string, string>();
  for (const [k] of byAgentModel) {
    const [id, model] = k.split("\n") as [string, string];
    if (!mainModel.has(id)) mainModel.set(id, model);
  }

  return {
    from: r.from,
    to: r.to,
    bucket: r.bucket,
    offset: r.offset,
    earliest,
    overview: {
      // Today is the UTC day so far (as OpenRouter and the gateway's day limit count), set against yesterday up to the same quarter hour.
      today: period("today", "yesterday"),
      week: period("week", "prevWeek"),
      month: period("month", "prevMonth"),
      // OpenRouter's own figures for the key (every caller of it), and its limit when one is set.
      key: typeof key === "string" ? { error: key } : { today: key.usage_daily, month: key.usage_monthly, limit: key.limit, remaining: key.limit_remaining, reset: key.limit_reset },
      // The install's day and month against its spend limits (the kernel's sums), and what each agent spent today, most first.
      limits: spend?.install ?? null,
      todayByAgent: (spend?.agents ?? []).filter((a) => a.spent > 0).map((a) => ({ agentId: a.agent_id, name: nameOf(a.agent_id), usd: a.spent })),
    },
    totals: { ...metrics(total), prevUsd: period("prev", "prev").prev },
    // Models by the last 30 days' spend: the chart's colour order, so a model keeps its colour whatever the range.
    modelOrder: s.modelOrder,
    models: rollup(cube, (c) => c.model, all).map(([model, m]) => ({ model, ...metrics(m) })),
    lanes: rollup(cube, (c) => c.lane, all).map(([lane, m]) => ({ lane, ...metrics(m) })),
    agents: rollup(cube.filter((c) => c.agentId), (c) => c.agentId!, all).map(([agentId, m]) => ({ agentId, name: nameOf(agentId), model: mainModel.get(agentId) ?? null, ...metrics(m), today: today.get(agentId)?.spent ?? 0 })),
    insights: await ledgerInsights(d, s, win, W, agents, key, now),
    series: s.series.sort((a, b) => a.t.localeCompare(b.t) || b.usd - a.usd || b.calls - a.calls),
  };
}

/* ----------------------------------------------------------------------------- insights */
/** A run with this many calls or more is taken as looping. */
export const LOOP_CALLS = 150;
/** Tasks looked up in Paperclip for status: the costliest ones in the range. */
const TASK_SAMPLE = 80;
/** A forecast needs at least this much ledger history behind its run-rate. */
const MIN_RATE_MS = 6 * 36e5;
/** The ledger and OpenRouter agree when within this much of OpenRouter's figure (the board pulls the ledger every 60 s). */
const AGREE = { usd: 0.1, share: 0.03 };

/**
 * End-of-month forecast: spend so far this month plus the run-rate over the last 7 days (or since the ledger began, when that is
 * shorter; at least 6 hours of it) times the days left. null when there is too little history.
 */
export function forecast(a: { monthToDate: number; windowUsd: number; windowMs: number; now: number }) {
  const d = new Date(a.now);
  const daysLeft = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - a.now) / DAY;
  if (a.windowMs < MIN_RATE_MS) return { projected: null, perDay: null, daysLeft };
  const perDay = a.windowUsd / (a.windowMs / DAY);
  return { projected: a.monthToDate + perDay * daysLeft, perDay, daysLeft };
}

/**
 * The ledger against OpenRouter's own figure for each calendar period (UTC): "accurate" within AGREE of it, "gap" beyond. A period
 * the ledger doesn't fully cover (it starts at `earliest`) is "partial" and not judged. gap = OpenRouter minus ledger: positive is
 * spend that bypassed the gateway (or isn't itemised), negative a ledger ahead of OpenRouter's counter.
 */
export function coverage(periods: { name: string; from: number; real: number; ledger: number }[], earliest: string | null) {
  const rows = periods.map((p) => {
    const covered = earliest !== null && Date.parse(earliest) <= p.from;
    const gap = p.real - p.ledger;
    const state = !covered ? ("partial" as const) : Math.abs(gap) <= Math.max(AGREE.usd, AGREE.share * p.real) ? ("accurate" as const) : ("gap" as const);
    return { name: p.name, from: new Date(p.from).toISOString(), real: p.real, ledger: p.ledger, gap, share: p.real > 0 ? gap / p.real : 0, state };
  });
  const judged = rows.filter((x) => x.state !== "partial");
  return { state: !judged.length ? ("unverified" as const) : judged.some((x) => x.state === "gap") ? ("gap" as const) : ("accurate" as const), periods: rows };
}

/**
 * What caching saved: cached input tokens × (the model's list price for fresh input minus its list price for cached input). List
 * prices only (the gateway's catalog of OpenRouter's /models, USD per million tokens); routing can bill more than list, so it is an estimate. Models with no cached price are left out.
 */
export function cacheSavings(models: { model: string; cached: number }[], catalog: CatalogModel[] | null | undefined) {
  if (!catalog?.length) return null;
  const byId = new Map(catalog.map((m) => [m.id, m]));
  let saved = 0;
  for (const m of models) {
    const p = byId.get(m.model.replace(/^openrouter\//, ""));
    if (p?.cached_in != null) saved += (m.cached * Math.max(0, p.in - p.cached_in)) / 1e6;
  }
  return saved;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

async function ledgerInsights(d: LedgerDeps, s: Summary, win: Record<"today" | "week" | "monthStart" | "monday", { usd: number }>, W: Record<"today" | "week" | "monthStart" | "monday", [number, number]>, agents: Agent[], key: KeyUsage | string, now: number) {
  const { groups: cube, earliest } = s;
  const nameOf = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? `Agent ${id.slice(0, 8)}`) : "System calls");
  const all = (c: LedgerMetrics) => c;

  // Forecast: this month so far (the part the ledger covers) and the recent run-rate.
  const monthStart = W.monthStart[0];
  const rateFrom = Math.max(W.week[0], earliest ? Date.parse(earliest) : now);
  const monthToDate = win.monthStart.usd;
  const fc = { ...forecast({ monthToDate, windowUsd: win.week.usd, windowMs: now - rateFrom, now }), monthToDate, partialMonth: earliest !== null && Date.parse(earliest) > monthStart };

  // Coverage: today, this week (since Monday), this month, each against OpenRouter's counter for the key.
  const cov =
    typeof key === "string"
      ? { state: "unavailable" as const, error: key, periods: [] }
      : {
          ...coverage(
            [
              { name: "Today", from: W.today[0], real: key.usage_daily, ledger: win.today.usd },
              { name: "This week", from: W.monday[0], real: key.usage_weekly, ledger: win.monday.usd },
              { name: "This month", from: monthStart, real: key.usage_monthly, ledger: monthToDate },
            ],
            earliest,
          ),
          error: null,
        };

  // Cache: hit rate over the range and what it saved at list prices.
  const total = rollup(cube, () => "", all)[0]?.[1] ?? ZERO;
  const catalog = d.catalog?.() ?? null;
  const cache = {
    hit: total.input + total.cached ? total.cached / (total.input + total.cached) : null,
    cached: total.cached,
    input: total.input,
    savedUsd: cacheSavings(rollup(cube, (c) => c.model, all).map(([model, m]) => ({ model, cached: m.cached })), catalog),
  };

  // Departments: each agent's own `department:` (the registry compile resolved), system calls apart.
  const dept = new Map(agents.map((a) => [a.id, departmentOf(a)]));
  const depts = new Map<string, { id: string; name: string; order: number; agents: Set<string>; m: LedgerMetrics }>();
  for (const c of cube) {
    const x = c.agentId ? (dept.get(c.agentId) ?? { id: "general", name: "General", order: 1_000 }) : { id: "system", name: "System calls", order: 2_000 };
    const row = depts.get(x.id) ?? { id: x.id, name: x.name, order: x.order, agents: new Set<string>(), m: ZERO };
    if (c.agentId) row.agents.add(c.agentId);
    row.m = plus(row.m, c);
    depts.set(x.id, row);
  }
  const departments = [...depts.values()].sort((a, b) => b.m.usd - a.m.usd).map((x) => ({ id: x.id, name: x.name, agents: x.agents.size, ...metrics(x.m) }));

  // Tasks: the costliest ones are looked up in Paperclip for title and status; the totals over all tasks come from the kernel.
  const { count, usd: attributed } = s.tasks;
  const costly = d.issues ? s.tasks.top : [];
  const names = d.issues && costly.length ? await d.issues(costly.map((x) => x.issueId)).catch(() => new Map<string, TaskNames>()) : new Map<string, TaskNames>();
  const sample = costly.map((x) => {
    const issue = names.get(x.issueId);
    return { issueId: x.issueId, identifier: issue?.identifier ?? null, title: issue?.title ?? null, status: issue?.status ?? null, agent: nameOf(x.agentId), usd: x.usd, calls: x.calls };
  });
  const done = sample.filter((t) => t.status === "done");
  const cancelled = sample.filter((t) => t.status === "cancelled");
  const sum = (xs: { usd: number }[]) => xs.reduce((s, t) => s + t.usd, 0);
  const tasks = {
    count,
    usd: attributed,
    perTask: count ? attributed / count : null,
    sampled: sample.length,
    // Among the costliest tasks only (a cheap one never makes the sample), so an upper estimate.
    done: { count: done.length, perTask: done.length ? sum(done) / done.length : null, median: median(done.map((t) => t.usd)) },
    top: sample.slice(0, 10),
  };

  const failed = s.failed;
  const long = s.loops;
  const wasted = {
    failed: { usd: sum(failed), calls: failed.reduce((s, f) => s + f.calls, 0), list: failed.slice(0, 8).map((f) => ({ agent: nameOf(f.agentId), status: f.status, calls: f.calls, usd: f.usd })) },
    cancelled: { usd: sum(cancelled), count: cancelled.length, list: cancelled.slice(0, 8) },
    looping: { threshold: LOOP_CALLS, usd: sum(long), count: long.length, list: long.slice(0, 8).map((x) => ({ runId: x.runId, agent: nameOf(x.agentId), calls: x.calls, usd: x.usd, first: x.first })) },
  };

  return { forecast: fc, coverage: cov, cache, departments, tasks, wasted };
}

const TOP = 15;

/** One agent's or one model's most expensive runs and tasks in the range (titles for the top tasks only). */
export async function ledgerTop(d: Pick<LedgerDeps, "report" | "agents"> & Required<Pick<LedgerDeps, "issues">>, r: LedgerRange, filter: LedgerFilter) {
  if (!filter.agentId === !filter.model) throw new BadRequest("name one agent or one model");
  const [agents, top] = await Promise.all([
    d.agents().catch(() => [] as Agent[]),
    d.report<{ total: GroupRow | null; split: GroupRow[]; runs: GroupRow[]; tasks: GroupRow[]; noTask: number; noRun: number }>("top", { from: r.from, to: r.to, agent: filter.agentId, model: filter.model, limit: TOP }),
  ]);
  const who = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? `Agent ${id.slice(0, 8)}`) : null);
  const runs = top.runs.map((x) => ({
    runId: x.a!,
    agent: who(x.b),
    first: x.first,
    last: x.last,
    ...metrics(x),
  }));
  const names = top.tasks.length ? await d.issues(top.tasks.map((x) => x.a!)).catch(() => new Map<string, TaskNames>()) : new Map<string, TaskNames>();
  const tasks = top.tasks.map((x) => {
    const issue = names.get(x.a!);
    return { issueId: x.a!, identifier: issue?.identifier ?? null, title: issue?.title ?? null, agent: who(x.b), ...metrics(x) };
  });
  // An agent's spend by model, or a model's by agent (system calls under "System").
  const split = top.split.map((x) => ({ name: filter.agentId ? x.a! : (who(x.a) ?? "System calls"), ...metrics(x) }));
  // Spend on calls that name no task, or no run (system calls, records from before attribution): no list can show it.
  return { filter, total: metrics(top.total ?? undefined), split, runs, tasks, noTask: top.noTask, noRun: top.noRun };
}

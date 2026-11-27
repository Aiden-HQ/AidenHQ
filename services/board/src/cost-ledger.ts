// The Costs tab's ledger views: what the model gateway's ledger (pulled into the board's usage table by pullUsage) says was billed,
// aggregated in SQL so the browser gets groups, never rows.
//  - summary: the overview (today / 7 / 30 days against the period before, the OpenRouter key's limit, the install's day and
//    month against its spend limits, from the kernel's spend summary) and,
//    over the chosen range, spend by model, by kind of call (lane), by agent and over time by model: one grouped pass (ledgerCube).
//  - top: one agent's or model's most expensive runs and tasks in the range, for the drill-down.
import { BadRequest } from "./board.js";
import { departmentOf } from "./activity.js";
import type { KeyUsage, SpendSummary } from "./costs.js";
import type { Agent } from "./paperclip.js";
import type { CatalogModel } from "./model-catalog.js";
import type { LedgerFilter, LedgerMetrics, Store } from "./store.js";

const DAY = 864e5;
/** The board keeps 62 days of usage (pullUsage); a range may not reach further back than that. */
const MAX_SPAN = 62 * DAY;

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

/** from/to (ISO instants, to exclusive) and bucket from the query; defaults to the last 7 days by day. Fails loudly on nonsense. */
export function ledgerRange(q: URLSearchParams, now = Date.now()): LedgerRange {
  const to = q.get("to") ? Date.parse(q.get("to")!) : now;
  const from = q.get("from") ? Date.parse(q.get("from")!) : to - 7 * DAY;
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new BadRequest("from and to are ISO dates");
  if (to <= from) throw new BadRequest("to must be after from");
  if (to - from > MAX_SPAN) throw new BadRequest("a range spans at most 62 days (the usage kept)");
  const bucket = (q.get("bucket") ?? (to - from <= 2 * DAY ? "hour" : "day")) as Bucket;
  if (bucket !== "hour" && bucket !== "day") throw new BadRequest("bucket is hour or day");
  if (bucket === "hour" && to - from > 7 * DAY) throw new BadRequest("hourly buckets cover at most 7 days");
  const offset = Number(q.get("offset") ?? 0);
  if (!Number.isInteger(offset) || Math.abs(offset) > 14 * 60) throw new BadRequest("offset is whole minutes from UTC");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket, offset };
}

/** What the ledger shows of a task. */
export type TaskNames = { identifier: string | null; title: string | null; status: string | null };

export interface LedgerDeps {
  store: Pick<Store, "ledgerCube" | "ledgerBy" | "usageSpend" | "usageEarliest" | "taskCount" | "failedCalls" | "longRuns">;
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
  const { store } = d;
  const [agents, key, spend] = await Promise.all([d.agents().catch(() => [] as Agent[]), d.key(), d.spend().catch(() => null)]);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? `Agent ${id.slice(0, 8)}`;
  const today = new Map((spend?.agents ?? []).map((a) => [a.agent_id, a]));
  const iso = (n: number) => new Date(n).toISOString();
  const earliest = store.usageEarliest();
  /** Spend in [from, to) and in the same span just before it; prev null when the ledger doesn't reach back that far. */
  const period = (from: number, to: number) => {
    const prevFrom = from - (to - from);
    return { ...store.usageSpend(iso(from), iso(to)), prev: earliest !== null && earliest <= iso(prevFrom) ? store.usageSpend(iso(prevFrom), iso(from)).usd : null };
  };
  const midnight = Math.floor(now / DAY) * DAY;

  const cube = store.ledgerCube(r.from, r.to, r.bucket, r.offset);
  const all = (c: LedgerMetrics) => c;
  const total = rollup(cube, () => "", all)[0]?.[1];
  const byAgentModel = rollup(cube.filter((c) => c.agentId), (c) => `${c.agentId}\n${c.model}`, all);
  // An agent's main model: the one it spent most on in the range.
  const mainModel = new Map<string, string>();
  for (const [k] of byAgentModel) {
    const [id, model] = k.split("\n") as [string, string];
    if (!mainModel.has(id)) mainModel.set(id, model);
  }
  const range = period(Date.parse(r.from), Date.parse(r.to));

  return {
    from: r.from,
    to: r.to,
    bucket: r.bucket,
    offset: r.offset,
    earliest,
    overview: {
      // Today is the UTC day so far (as OpenRouter and the gateway's day limit count), set against yesterday up to the same hour.
      today: { ...store.usageSpend(iso(midnight), iso(now)), prev: earliest !== null && earliest <= iso(midnight - DAY) ? store.usageSpend(iso(midnight - DAY), iso(now - DAY)).usd : null },
      week: period(now - 7 * DAY, now),
      month: period(now - 30 * DAY, now),
      // OpenRouter's own figures for the key (every caller of it), and its limit when one is set.
      key: typeof key === "string" ? { error: key } : { today: key.usage_daily, month: key.usage_monthly, limit: key.limit, remaining: key.limit_remaining, reset: key.limit_reset },
      // The install's day and month against its spend limits (the kernel's sums), and what each agent spent today, most first.
      limits: spend?.install ?? null,
      todayByAgent: (spend?.agents ?? []).filter((a) => a.spent > 0).map((a) => ({ agentId: a.agent_id, name: nameOf(a.agent_id), usd: a.spent })),
    },
    totals: { ...metrics(total), prevUsd: range.prev },
    // Models by the last 30 days' spend: the chart's colour order, so a model keeps its colour whatever the range.
    modelOrder: store.ledgerBy("model", iso(now - 30 * DAY), iso(now)).map((x) => x.a!),
    models: rollup(cube, (c) => c.model, all).map(([model, m]) => ({ model, ...metrics(m) })),
    lanes: rollup(cube, (c) => c.lane, all).map(([lane, m]) => ({ lane, ...metrics(m) })),
    agents: rollup(cube.filter((c) => c.agentId), (c) => c.agentId!, all).map(([agentId, m]) => ({ agentId, name: nameOf(agentId), model: mainModel.get(agentId) ?? null, ...metrics(m), today: today.get(agentId)?.spent ?? 0 })),
    insights: await ledgerInsights(d, r, cube, agents, key, earliest, now),
    series: rollup(cube, (c) => `${c.t}\n${c.model}`, all)
      .map(([k, m]) => ({ t: k.split("\n")[0]!, model: k.split("\n")[1]!, usd: m.usd, calls: m.calls }))
      .sort((a, b) => a.t.localeCompare(b.t)),
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

async function ledgerInsights(d: LedgerDeps, r: LedgerRange, cube: ReturnType<Store["ledgerCube"]>, agents: Agent[], key: KeyUsage | string, earliest: string | null, now: number) {
  const { store } = d;
  const iso = (n: number) => new Date(n).toISOString();
  const nameOf = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? `Agent ${id.slice(0, 8)}`) : "System calls");
  const all = (c: LedgerMetrics) => c;

  // Forecast: this month so far (the part the ledger covers) and the recent run-rate.
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const since = earliest ? Math.max(monthStart, Date.parse(earliest)) : now;
  const rateFrom = Math.max(now - 7 * DAY, earliest ? Date.parse(earliest) : now);
  const monthToDate = store.usageSpend(iso(since), iso(now)).usd;
  const fc = { ...forecast({ monthToDate, windowUsd: store.usageSpend(iso(rateFrom), iso(now)).usd, windowMs: now - rateFrom, now }), monthToDate, partialMonth: earliest !== null && Date.parse(earliest) > monthStart };

  // Coverage: today, this week (since Monday), this month, each against OpenRouter's counter for the key.
  const day = Math.floor(now / DAY) * DAY;
  const cov =
    typeof key === "string"
      ? { state: "unavailable" as const, error: key, periods: [] }
      : {
          ...coverage(
            [
              { name: "Today", from: day, real: key.usage_daily },
              { name: "This week", from: day - ((new Date(now).getUTCDay() + 6) % 7) * DAY, real: key.usage_weekly },
              { name: "This month", from: monthStart, real: key.usage_monthly },
            ].map((p) => ({ ...p, ledger: store.usageSpend(iso(p.from), iso(now)).usd })),
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

  // Tasks: the costliest ones are looked up in Paperclip for title and status; the totals over all tasks come from SQL.
  const attributed = store.ledgerBy("hasIssue", r.from, r.to).find((x) => Number(x.a) === 1)?.usd ?? 0;
  const count = store.taskCount(r.from, r.to);
  const costly = d.issues ? store.ledgerBy("issue", r.from, r.to, {}, TASK_SAMPLE) : [];
  const names = d.issues && costly.length ? await d.issues(costly.map((x) => x.a!)).catch(() => new Map<string, TaskNames>()) : new Map<string, TaskNames>();
  const sample = costly.map((x) => {
    const issue = names.get(x.a!);
    return { issueId: x.a!, identifier: issue?.identifier ?? null, title: issue?.title ?? null, status: issue?.status ?? null, agent: nameOf(x.b), usd: x.usd, calls: x.calls };
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

  const failed = store.failedCalls(r.from, r.to);
  const long = store.longRuns(r.from, r.to, LOOP_CALLS);
  const wasted = {
    failed: { usd: sum(failed), calls: failed.reduce((s, f) => s + f.calls, 0), list: failed.slice(0, 8).map((f) => ({ agent: nameOf(f.agentId), status: f.status, calls: f.calls, usd: f.usd })) },
    cancelled: { usd: sum(cancelled), count: cancelled.length, list: cancelled.slice(0, 8) },
    looping: { threshold: LOOP_CALLS, usd: sum(long), count: long.length, list: long.slice(0, 8).map((x) => ({ runId: x.runId, agent: nameOf(x.agentId), calls: x.calls, usd: x.usd, first: x.first })) },
  };

  return { forecast: fc, coverage: cov, cache, departments, tasks, wasted };
}

const TOP = 15;

/** One agent's or one model's most expensive runs and tasks in the range (titles for the top tasks only). */
export async function ledgerTop(d: Pick<LedgerDeps, "store" | "agents"> & Required<Pick<LedgerDeps, "issues">>, r: LedgerRange, filter: LedgerFilter) {
  if (!filter.agentId === !filter.model) throw new BadRequest("name one agent or one model");
  const agents = await d.agents().catch(() => [] as Agent[]);
  const who = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? `Agent ${id.slice(0, 8)}`) : null);
  const runs = d.store.ledgerBy("run", r.from, r.to, filter, TOP).map((x) => ({
    runId: x.a!,
    agent: who(x.b),
    first: x.first,
    last: x.last,
    ...metrics(x),
  }));
  const top = d.store.ledgerBy("issue", r.from, r.to, filter, TOP);
  const names = top.length ? await d.issues(top.map((x) => x.a!)).catch(() => new Map<string, TaskNames>()) : new Map<string, TaskNames>();
  const tasks = top.map((x) => {
    const issue = names.get(x.a!);
    return { issueId: x.a!, identifier: issue?.identifier ?? null, title: issue?.title ?? null, agent: who(x.b), ...metrics(x) };
  });
  // An agent's spend by model, or a model's by agent (system calls under "System").
  const split = filter.agentId
    ? d.store.ledgerBy("model", r.from, r.to, filter).map((x) => ({ name: x.a!, ...metrics(x) }))
    : d.store.ledgerBy("caller", r.from, r.to, filter).map((x) => ({ name: who(x.a) ?? "System calls", ...metrics(x) }));
  const total = metrics(d.store.ledgerBy("total", r.from, r.to, filter)[0]);
  // Spend on calls that name no task, or no Paperclip run (system calls, records from before attribution): no list can show it.
  const unnamed = (by: "hasIssue" | "hasRun") => d.store.ledgerBy(by, r.from, r.to, filter).find((x) => Number(x.a) === 0)?.usd ?? 0;
  return { filter, total, split, runs, tasks, noTask: unnamed("hasIssue"), noRun: unnamed("hasRun") };
}

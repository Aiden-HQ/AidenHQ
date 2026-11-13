// The Costs tab's ledger views: what the model gateway's ledger (pulled into the board's usage table by pullUsage) says was billed,
// aggregated in SQL so the browser gets groups, never rows. The older estimate-and-check view stays in costs.ts.
//  - summary: the overview (today / 7 / 30 days against the period before, the OpenRouter key's limit, each agent's day cap) and,
//    over the chosen range, spend by model, by kind of call (lane), by agent and over time by model: one grouped pass (ledgerCube).
//  - top: one agent's or model's most expensive runs and tasks in the range, for the drill-down.
import { readFileSync } from "node:fs";
import { BadRequest } from "./board.js";
import type { KeyUsage } from "./costs.js";
import type { Agent, Issue } from "./paperclip.js";
import type { LedgerFilter, LedgerMetrics, Store } from "./store.js";

const DAY = 864e5;
/** The board keeps 62 days of usage (pullUsage); a range may not reach further back than that. */
const MAX_SPAN = 62 * DAY;
/** The gateway's default agent-day cap (services/gateway/lib.mjs DEFAULT_CAPS); grants may set another. */
const DEFAULT_DAY_CAP = 30;

/** A group's figures; ms is the mean latency of its ok calls that timed themselves (null: none did). */
export interface Metrics {
  usd: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  ms: number | null;
}
const ZERO: LedgerMetrics = { usd: 0, calls: 0, input: 0, cached: 0, output: 0, errors: 0, msSum: 0, msN: 0 };
const plus = (a: LedgerMetrics, b: LedgerMetrics): LedgerMetrics => ({ usd: a.usd + b.usd, calls: a.calls + b.calls, input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, errors: a.errors + b.errors, msSum: a.msSum + b.msSum, msN: a.msN + b.msN });
const metrics = (m: LedgerMetrics = ZERO): Metrics => ({ usd: m.usd, calls: m.calls, input: m.input, cached: m.cached, output: m.output, errors: m.errors, ms: m.msN ? Math.round(m.msSum / m.msN) : null });
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
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket };
}

/** Each agent's day cap: grants caps.day_usd (setup writes them, keyed by Paperclip id), else the gateway's default. */
function dayCaps(grantsFile: string | undefined): (agentId: string) => number {
  let agents: Record<string, { caps?: { day_usd?: number } }> = {};
  try {
    agents = JSON.parse(readFileSync(grantsFile ?? "", "utf8")).agents ?? {};
  } catch {}
  return (id) => agents[id]?.caps?.day_usd ?? DEFAULT_DAY_CAP;
}

export interface LedgerDeps {
  store: Pick<Store, "ledgerCube" | "ledgerBy" | "usageSpend" | "spendByAgent" | "usageEarliest">;
  agents: () => Promise<Agent[]>;
  key: () => Promise<KeyUsage | string>;
  grantsFile?: string;
}

export async function ledgerSummary(d: LedgerDeps, r: LedgerRange, now = Date.now()) {
  const { store } = d;
  const [agents, key] = await Promise.all([d.agents().catch(() => [] as Agent[]), d.key()]);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? `Agent ${id.slice(0, 8)}`;
  const capOf = dayCaps(d.grantsFile);
  const iso = (n: number) => new Date(n).toISOString();
  const earliest = store.usageEarliest();
  /** Spend in [from, to) and in the same span just before it; prev null when the ledger doesn't reach back that far. */
  const period = (from: number, to: number) => {
    const prevFrom = from - (to - from);
    return { ...store.usageSpend(iso(from), iso(to)), prev: earliest !== null && earliest <= iso(prevFrom) ? store.usageSpend(iso(prevFrom), iso(from)).usd : null };
  };
  const midnight = Math.floor(now / DAY) * DAY;
  const today = store.spendByAgent(iso(midnight), iso(now));

  const cube = store.ledgerCube(r.from, r.to, r.bucket);
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
    earliest,
    overview: {
      // Today is the UTC day so far (as OpenRouter and the gateway's day caps count), set against yesterday up to the same hour.
      today: { ...store.usageSpend(iso(midnight), iso(now)), prev: earliest !== null && earliest <= iso(midnight - DAY) ? store.usageSpend(iso(midnight - DAY), iso(now - DAY)).usd : null },
      week: period(now - 7 * DAY, now),
      month: period(now - 30 * DAY, now),
      // OpenRouter's own figures for the key (every caller of it), and its limit when one is set.
      key: typeof key === "string" ? { error: key } : { today: key.usage_daily, month: key.usage_monthly, limit: key.limit, remaining: key.limit_remaining, reset: key.limit_reset },
      // Today's spend against each agent's day cap, nearest the cap first.
      caps: [...today].map(([agentId, usd]) => ({ agentId, name: nameOf(agentId), usd, cap: capOf(agentId) })).sort((a, b) => b.usd / b.cap - a.usd / a.cap),
    },
    totals: { ...metrics(total), prevUsd: range.prev },
    // Models by the last 30 days' spend: the chart's colour order, so a model keeps its colour whatever the range.
    modelOrder: store.ledgerBy("model", iso(now - 30 * DAY), iso(now)).map((x) => x.a!),
    models: rollup(cube, (c) => c.model, all).map(([model, m]) => ({ model, ...metrics(m) })),
    lanes: rollup(cube, (c) => c.lane, all).map(([lane, m]) => ({ lane, ...metrics(m) })),
    agents: rollup(cube.filter((c) => c.agentId), (c) => c.agentId!, all).map(([agentId, m]) => ({ agentId, name: nameOf(agentId), model: mainModel.get(agentId) ?? null, ...metrics(m), today: today.get(agentId) ?? 0, dayCap: capOf(agentId) })),
    series: rollup(cube, (c) => `${c.t}\n${c.model}`, all)
      .map(([k, m]) => ({ t: k.split("\n")[0]!, model: k.split("\n")[1]!, usd: m.usd, calls: m.calls }))
      .sort((a, b) => a.t.localeCompare(b.t)),
  };
}

const TOP = 15;

/** One agent's or one model's most expensive runs and tasks in the range (titles for the top tasks only). */
export async function ledgerTop(d: Pick<LedgerDeps, "store" | "agents"> & { issue: (id: string) => Promise<Pick<Issue, "identifier" | "title">> }, r: LedgerRange, filter: LedgerFilter) {
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
  const tasks = await Promise.all(
    d.store.ledgerBy("issue", r.from, r.to, filter, TOP).map(async (x) => {
      const issue = await d.issue(x.a!).catch(() => null);
      return { issueId: x.a!, identifier: issue?.identifier ?? null, title: issue?.title ?? null, agent: who(x.b), ...metrics(x) };
    }),
  );
  // An agent's spend by model, or a model's by agent (system calls under "System").
  const split = filter.agentId
    ? d.store.ledgerBy("model", r.from, r.to, filter).map((x) => ({ name: x.a!, ...metrics(x) }))
    : d.store.ledgerBy("caller", r.from, r.to, filter).map((x) => ({ name: who(x.a) ?? "System calls", ...metrics(x) }));
  const total = metrics(d.store.ledgerBy("total", r.from, r.to, filter)[0]);
  // Spend on calls that name no task, or no Paperclip run (system calls, records from before attribution): no list can show it.
  const unnamed = (by: "hasIssue" | "hasRun") => d.store.ledgerBy(by, r.from, r.to, filter).find((x) => Number(x.a) === 0)?.usd ?? 0;
  return { filter, total, split, runs, tasks, noTask: unnamed("hasIssue"), noRun: unnamed("hasRun") };
}

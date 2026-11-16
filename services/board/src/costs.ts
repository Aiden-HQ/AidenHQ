// The Costs tab: what each agent and system component spent on models in a window, as close to OpenRouter's bill as we can see.
//  - Billed: every call through the model gateway (kernel/src/gateway; agent computers' calls reach it through the launcher)
//    is kept with what OpenRouter billed for it; the board pulls those (pullUsage). The runner's Engineer jobs (opencode) and AI reviewer report OpenRouter's cost likewise.
//  - Estimated: agents in Paperclip's own container call OpenRouter directly, so only Paperclip's token counts exist. Their
//    dollars are tokens × list price × that model's billed/list ratio over the last 7 days of billed calls, Engineer jobs left
//    out (opencode's costs sit far below what the gateway sees billed for the same model, cause unknown). The list price is the
//    cheapest provider's, while routing (ZDR) lands on pricier ones. An alias (`~…-latest`) is priced as the model it resolves to, which is what OpenRouter bills: the
//    alias's own listing can carry another model's prices.
//  - Paperclip counts a run that resumed a Codex session as the session's running total; resumedOvercount takes the repeat off.
// OpenRouter's own total for the key (every caller of it) sits next to the sum, so whatever is not itemised stays visible.
import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";
import type { Paperclip } from "./paperclip.js";
import type { Store, UsageTotal } from "./store.js";

const OPENROUTER = "https://openrouter.ai/api/v1";
const DAY = 864e5;

export const WINDOWS = ["today", "yesterday", "7d", "30d"] as const;
export type CostWindow = (typeof WINDOWS)[number];

/** A call's run attribution (RunIdentity in kernel/src/gateway/lib.ts, plus how the call went); every field optional. See UsageRecord. */
const Attribution = {
  runKey: z.string().regex(/^[\w:.-]{1,128}$/).nullable().optional(),
  /** Paperclip's run id, when the credential names it (a run JWT): the run page's exact join. */
  runId: z.string().min(1).max(80).nullable().optional(),
  issueId: z.string().min(1).max(80).nullable().optional(),
  rev: z.string().regex(/^[0-9a-f]{1,64}$/).nullable().optional(),
  kind: z.enum(["agent", "advisor", "grader", "reviewer", "fanout", "source", "ci-code-review", "aside"]).nullable().optional(),
  ms: z.number().int().min(0).nullable().optional(),
  status: z.string().regex(/^[a-z0-9_]{1,40}$/).nullable().optional(),
};

export const UsageSchema = z
  .object({
    key: z.string().min(1).max(200),
    component: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(120),
    input: z.number().int().min(0),
    cached: z.number().int().min(0),
    output: z.number().int().min(0),
    costUsd: z.number().min(0).nullable().optional(),
    ...Attribution,
  })
  .strict();

/**
 * The window's bounds, and the calendar period (UTC) OpenRouter reports for the key that the check line compares against. The key
 * endpoint has no figure for yesterday (field null): that one is compared by hand with the day's bar on OpenRouter's Activity page.
 */
export function bounds(w: CostWindow, now = new Date()) {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = w === "today" ? day : w === "yesterday" ? day - DAY : now.getTime() - (w === "7d" ? 7 : 30) * DAY;
  const to = w === "yesterday" ? day : now.getTime();
  // OpenRouter's usage_weekly starts Monday 00:00 UTC; usage_monthly the 1st.
  const period =
    w === "today"
      ? { name: "today (UTC)", field: "usage_daily" as const, from: day }
      : w === "yesterday"
        ? { name: "yesterday (UTC)", field: null, from }
        : w === "7d"
          ? { name: "this week (since Monday, UTC)", field: "usage_weekly" as const, from: day - ((now.getUTCDay() + 6) % 7) * DAY }
          : { name: "this month (UTC)", field: "usage_monthly" as const, from: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) };
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), period: { ...period, from: new Date(period.from).toISOString() } };
}

/** OpenRouter's per-token list prices (USD strings), by model id. */
type Pricing = { prompt?: string; completion?: string; input_cache_read?: string };
export type Prices = Map<string, Pricing>;
type Tokens = { input: number; cached: number; output: number };
const bare = (model: string) => model.replace(/^openrouter\//, "");

/** Dollars at the list price, cached input at the cached price where the list has one; null when the model isn't listed. */
export function estimate(prices: Prices, model: string, t: Tokens): number | null {
  const p = prices.get(bare(model));
  if (!p) return null;
  const n = (s?: string) => Number(s ?? 0) || 0;
  return t.input * n(p.prompt) + t.cached * n(p.input_cache_read ?? p.prompt) + t.output * n(p.completion);
}

/** Per model, what OpenRouter billed over what the list price says for the same calls (only records that all carry a cost). */
export function billedRatios(usage: UsageTotal[], prices: Prices): Map<string, number> {
  const sums = new Map<string, { billed: number; list: number }>();
  for (const u of usage) {
    const list = estimate(prices, u.model, u);
    if (u.costUsd === null || u.priced !== u.runs || !list) continue;
    const s = sums.get(bare(u.model)) ?? { billed: 0, list: 0 };
    s.billed += u.costUsd;
    s.list += list;
    sums.set(bare(u.model), s);
  }
  return new Map([...sums].map(([m, s]) => [m, s.billed / s.list]));
}

/**
 * Price an alias (`~deepseek/deepseek-flash-latest`) as the model agent computers' calls on it were answered by (the gateway keeps
 * the resolved slug): that is the model OpenRouter bills, and the alias's own listing can carry another model's prices, with a
 * different cached/uncached split. `usage` is store.usage before asConfiguredModel.
 */
export function withResolvedPrices(prices: Prices, usage: UsageTotal[], modelOf: Map<string, string>): Prices {
  const seen = new Map<string, { model: string; runs: number }>();
  for (const u of usage) {
    const alias = u.agentId && modelOf.get(u.agentId) ? bare(modelOf.get(u.agentId)!) : "";
    if (!alias || alias === bare(u.model) || !prices.has(bare(u.model))) continue;
    if (u.runs > (seen.get(alias)?.runs ?? 0)) seen.set(alias, { model: bare(u.model), runs: u.runs });
  }
  if (!seen.size) return prices;
  const out = new Map(prices);
  for (const [alias, s] of seen) out.set(alias, prices.get(s.model)!);
  return out;
}

/** A run as Paperclip lists it (heartbeat-runs): its tokens and the Codex session it resumed and ended in. */
export interface SessionRun {
  agentId: string;
  finishedAt?: string | null;
  createdAt: string;
  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  inputTokens?: string | number | null;
  cachedInputTokens?: string | number | null;
  outputTokens?: string | number | null;
  usageJson?: { model?: string } | null;
}

/**
 * Paperclip counts a run that resumed a Codex session (same session id before and after) as the session's running total: Codex
 * reports cumulative usage on resume while Paperclip's adapter declares per-run usage. On 2026-11-11 that doubled Aiden's tokens
 * and put Roadmap Keeper's 64% over its own (each matching its Codex session logs once corrected). Per agent and model, the repeated part for runs ending in [from, to): each resumed run's
 * previous run in the same session. A run whose total is below its predecessor's (a compacted session) is taken as its own.
 */
export function resumedOvercount(runs: SessionRun[], from: string, to: string): Map<string, Tokens> {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const end = (r: SessionRun) => r.finishedAt ?? r.createdAt;
  const last = new Map<string, Tokens>();
  const over = new Map<string, Tokens>();
  for (const r of [...runs].sort((a, b) => end(a).localeCompare(end(b)))) {
    const t = { input: n(r.inputTokens), cached: n(r.cachedInputTokens), output: n(r.outputTokens) };
    const prev = r.sessionIdBefore && r.sessionIdBefore === r.sessionIdAfter ? last.get(`${r.agentId}|${r.sessionIdBefore}`) : undefined;
    if (prev && end(r) >= from && end(r) < to && t.input + t.cached >= prev.input + prev.cached) {
      const k = `${r.agentId}|${bare(r.usageJson?.model ?? "")}`;
      const o = over.get(k) ?? { input: 0, cached: 0, output: 0 };
      over.set(k, { input: o.input + prev.input, cached: o.cached + prev.cached, output: o.output + Math.min(prev.output, t.output) });
    }
    if (r.sessionIdAfter && t.input + t.cached) last.set(`${r.agentId}|${r.sessionIdAfter}`, t);
  }
  return over;
}

/** Paperclip's per agent and model tokens less the resumed-session repeats. */
export function withoutResumedOvercount(byModel: ByAgentModel[], over: Map<string, Tokens>): ByAgentModel[] {
  return byModel.map((x) => {
    const o = over.get(`${x.agentId}|${bare(x.model)}`);
    if (!o) return x;
    return { ...x, inputTokens: Math.max(0, x.inputTokens - o.input), cachedInputTokens: Math.max(0, x.cachedInputTokens - o.cached), outputTokens: Math.max(0, x.outputTokens - o.output) };
  });
}

export interface ByAgentModel {
  agentId: string;
  agentName: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
export interface ByAgent {
  agentId: string;
  apiRunCount: number;
  subscriptionRunCount?: number;
}

export interface CostModel {
  model: string;
  input: number;
  cached: number;
  output: number;
  /** Dollars: as OpenRouter billed them when `reported`, else (partly) estimated; null when the model has no list price. */
  usd: number | null;
  reported: boolean;
}
export interface CostRow {
  name: string;
  kind: "agent" | "system";
  runs: number;
  input: number;
  cached: number;
  output: number;
  usd: number | null;
  /** Some model in the row has no price: `usd` covers only the rest. */
  partial: boolean;
  reported: boolean;
  models: CostModel[];
}

/**
 * One row per agent (Paperclip's tokens, plus agent computers' billed calls) and per system component (store.usage), largest
 * cost first. An agent's billed calls replace the estimate for the tokens they cover; only the rest is estimated.
 */
export function costRows(byModel: ByAgentModel[], byAgent: ByAgent[], usage: UsageTotal[], prices: Prices, ratios = new Map<string, number>(), names = new Map<string, string>()): CostRow[] {
  const rows = new Map<string, CostRow>();
  const add = (key: string, name: string, kind: CostRow["kind"], m: CostModel) => {
    const r = rows.get(key) ?? { name, kind, runs: 0, input: 0, cached: 0, output: 0, usd: null, partial: false, reported: true, models: [] };
    r.input += m.input;
    r.cached += m.cached;
    r.output += m.output;
    if (m.usd === null) r.partial = true;
    else r.usd = (r.usd ?? 0) + m.usd;
    r.reported &&= m.reported;
    r.models.push(m);
    rows.set(key, r);
  };
  const estimated = (model: string, t: Tokens) => {
    const list = estimate(prices, model, t);
    return list === null ? null : list * (ratios.get(bare(model)) ?? 1);
  };
  const billed = new Map(usage.filter((u) => u.agentId).map((u) => [`${u.agentId}|${bare(u.model)}`, u]));
  for (const x of byModel) {
    const b = billed.get(`${x.agentId}|${bare(x.model)}`);
    billed.delete(`${x.agentId}|${bare(x.model)}`);
    const t = { input: x.inputTokens, cached: x.cachedInputTokens, output: x.outputTokens };
    // Paperclip's tokens that billed calls don't cover: the agent ran in Paperclip's container, or before the gateway kept costs.
    const rest = { input: Math.max(0, t.input - (b?.input ?? 0)), cached: Math.max(0, t.cached - (b?.cached ?? 0)), output: Math.max(0, t.output - (b?.output ?? 0)) };
    const restTokens = rest.input + rest.cached + rest.output;
    if (!b && !restTokens) continue;
    // Within 2% is timing (Paperclip counts a run when it ends, the gateway each call as it ends): all billed.
    const covered = Boolean(b) && restTokens <= 0.02 * (t.input + t.cached + t.output);
    const restUsd = covered ? 0 : estimated(x.model, rest);
    const usd = restUsd === null ? (b?.costUsd ?? null) : (b?.costUsd ?? 0) + restUsd;
    const tokens = { input: Math.max(t.input, b?.input ?? 0), cached: Math.max(t.cached, b?.cached ?? 0), output: Math.max(t.output, b?.output ?? 0) };
    add(`agent:${x.agentId}`, x.agentName, "agent", { model: x.model, ...tokens, usd, reported: covered });
  }
  // Billed calls of an agent Paperclip shows no tokens for in this window (a run still going, or one that ended after it).
  for (const b of billed.values()) {
    const id = b.agentId!;
    const name = byModel.find((x) => x.agentId === id)?.agentName ?? names.get(id) ?? `Agent ${id.slice(0, 8)}`;
    add(`agent:${id}`, name, "agent", { model: b.model, input: b.input, cached: b.cached, output: b.output, usd: b.costUsd, reported: true });
  }
  for (const a of byAgent) {
    const r = rows.get(`agent:${a.agentId}`);
    if (r) r.runs = a.apiRunCount + (a.subscriptionRunCount ?? 0);
  }
  for (const u of usage) {
    if (u.agentId) continue;
    const t = { input: u.input, cached: u.cached, output: u.output };
    // The source's own cost when every record reported one; otherwise all of it estimated (never a mix).
    const reported = u.priced === u.runs && u.costUsd !== null;
    add(`system:${u.component}`, u.component, "system", { model: u.model, ...t, usd: reported ? u.costUsd : estimated(u.model, t), reported });
    rows.get(`system:${u.component}`)!.runs += u.runs;
  }
  for (const r of rows.values()) r.models.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  return [...rows.values()].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.input + b.cached + b.output - (a.input + a.cached + a.output));
}

let priceCache: { at: number; prices: Prices } | undefined;
/** OpenRouter's public model list, refreshed every 6 hours; an empty map (no dollars, tokens still shown) when unreachable. */
export async function prices(): Promise<Prices> {
  if (priceCache && Date.now() - priceCache.at < 6 * 3600_000) return priceCache.prices;
  try {
    const res = await fetch(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(String(res.status));
    const data = ((await res.json()) as { data?: { id: string; pricing?: Pricing }[] }).data ?? [];
    priceCache = { at: Date.now(), prices: new Map(data.map((m) => [m.id, m.pricing ?? {}])) };
  } catch {
    if (!priceCache) return new Map();
  }
  return priceCache!.prices;
}

/** limit: the key's spend limit (null: none), limit_remaining what is left of it, limit_reset how often it resets (monthly, ...). */
export type KeyUsage = { usage_daily: number; usage_weekly: number; usage_monthly: number; limit: number | null; limit_remaining: number | null; limit_reset: string | null };
let keyCache: { at: number; usage: KeyUsage } | undefined;
/** What OpenRouter itself says the key spent (it is shared by every caller: agents, the runner, computers, source writers). */
export async function keyUsage(): Promise<KeyUsage | string> {
  if (keyCache && Date.now() - keyCache.at < 60_000) return keyCache.usage;
  let key = "";
  try {
    key = readFileSync(process.env.OPENROUTER_KEY_FILE ?? "", "utf8").trim();
  } catch {}
  if (!key) return "no OpenRouter key on the board (OPENROUTER_KEY_FILE)";
  try {
    const res = await fetch(`${OPENROUTER}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return `OpenRouter answered ${res.status}`;
    const d = ((await res.json()) as { data: Partial<KeyUsage> }).data;
    keyCache = { at: Date.now(), usage: { usage_daily: d.usage_daily ?? 0, usage_weekly: d.usage_weekly ?? 0, usage_monthly: d.usage_monthly ?? 0, limit: d.limit ?? null, limit_remaining: d.limit_remaining ?? null, limit_reset: d.limit_reset ?? null } };
    return keyCache.usage;
  } catch (e) {
    return `OpenRouter unreachable (${(e as Error).message})`;
  }
}

const runCache = new Map<string, { at: number; runs: Promise<SessionRun[]> }>();
/**
 * An agent's last 1000 runs (Paperclip's list cap; about 11 days of Aiden), cached 5 minutes. Older resumed runs stay uncorrected.
 * Unreachable: no runs, so no correction (Paperclip's own counts).
 */
function agentRuns(pc: Paperclip, agentId: string): Promise<SessionRun[]> {
  const c = runCache.get(agentId);
  if (c && Date.now() - c.at < 300_000) return c.runs;
  const runs = pc.request<SessionRun[]>("GET", `/api/companies/${pc.companyId}/heartbeat-runs?agentId=${encodeURIComponent(agentId)}&limit=1000`).catch(() => []);
  runCache.set(agentId, { at: Date.now(), runs });
  return runs;
}

async function rowsFor(pc: Paperclip, usage: (from: string, to: string) => UsageTotal[], from: string, to: string, p: Prices, ratios: Map<string, number>, names: Map<string, string>) {
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const co = `/api/companies/${pc.companyId}/costs`;
  const [byModel, byAgent] = await Promise.all([pc.request<ByAgentModel[]>("GET", `${co}/by-agent-model?${q}`), pc.request<ByAgent[]>("GET", `${co}/by-agent?${q}`)]);
  const runs = (await Promise.all([...new Set(byModel.map((x) => x.agentId))].map((id) => agentRuns(pc, id)))).flat();
  return costRows(withoutResumedOvercount(byModel, resumedOvercount(runs, from, to)), byAgent, usage(from, to), p, ratios, names);
}

const sum = (rows: CostRow[]) => rows.reduce((s, r) => s + (r.usd ?? 0), 0);

export async function costs(pc: Paperclip, store: Pick<Store, "usage">, w: CostWindow) {
  const b = bounds(w);
  const [list, key, agents] = await Promise.all([prices(), keyUsage(), pc.agents().catch(() => [])]);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const modelOf = new Map(agents.flatMap((a) => (typeof a.adapterConfig?.model === "string" && a.adapterConfig.model ? [[a.id, a.adapterConfig.model] as const] : [])));
  const usage = (from: string, to: string) => asConfiguredModel(store.usage(from, to), modelOf);
  const week = [new Date(Date.now() - 7 * DAY).toISOString(), new Date().toISOString()] as const;
  const p = withResolvedPrices(list, store.usage(...week), modelOf);
  // Engineer jobs don't calibrate: opencode's per-step costs come to about half of what agent computers' calls of the same model
  // were billed against the list price (0.32× vs 0.57× on 2026-11-12), cause unknown; they would drag every estimate down.
  const ratios = billedRatios(usage(...week).filter((u) => u.component !== "Engineer jobs"), p);
  const [rows, periodRows] = await Promise.all([rowsFor(pc, usage, b.from, b.to, p, ratios, names), b.period.from === b.from ? undefined : rowsFor(pc, usage, b.period.from, b.to, p, ratios, names)]);
  const total = rows.reduce((t, r) => ({ runs: t.runs + r.runs, input: t.input + r.input, cached: t.cached + r.cached, output: t.output + r.output }), { runs: 0, input: 0, cached: 0, output: 0 });
  return {
    window: w,
    from: b.from,
    to: b.to,
    pricesAvailable: p.size > 0,
    rows,
    total: { ...total, usd: sum(rows), billed: rows.reduce((s, r) => s + r.models.filter((m) => m.reported).reduce((t, m) => t + (m.usd ?? 0), 0), 0) },
    // Billed/list per model, applied to the estimated tokens.
    ratios: Object.fromEntries(ratios),
    // Itemised vs OpenRouter's real figure over the calendar period it reports (never a rolling sum against a calendar total).
    check: {
      period: b.period.name,
      from: b.period.from,
      itemised: sum(periodRows ?? rows),
      real: typeof key === "string" || !b.period.field ? null : key[b.period.field],
      error: !b.period.field ? "OpenRouter's key endpoint reports today, this week and this month only; compare with the day's bar on its Activity page" : typeof key === "string" ? key : undefined,
    },
  };
}

const PulledRecord = z.object({
  key: z.string().min(1).max(200),
  at: z.string().datetime(),
  // None for the model gateway's system calls (the AI reviewer, source writers); they are counted by component.
  agentId: z.string().min(1).max(80).nullable(),
  component: z.string().trim().min(1).max(80).optional(),
  model: z.string().max(120),
  input: z.number().int().min(0),
  cached: z.number().int().min(0),
  output: z.number().int().min(0),
  costUsd: z.number().min(0).nullable(),
  ...Attribution,
  /** App CI code review: `<owner>/<repo>#<pr>`, from the job's GitHub OIDC token (kernel/src/gateway/ci.ts). */
  subject: z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,9}$/).nullable().optional(),
});

/** Gateway records, each checked on its own: a bad one is skipped, never the batch (it must not hold the pull back). */
export function pulledRecords(body: unknown): z.infer<typeof PulledRecord>[] {
  const records = (body as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) throw new Error("the gateway's answer has no records");
  return records.flatMap((r) => {
    const p = PulledRecord.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

/**
 * Gateway records carry the model OpenRouter answered with (the resolved slug); Paperclip and the price list use the agent's
 * configured model (often a `~` alias). Each agent's records are counted under its configured model, merged.
 */
export function asConfiguredModel(usage: UsageTotal[], modelOf: Map<string, string>): UsageTotal[] {
  const out = new Map<string, UsageTotal>();
  for (const u of usage) {
    const model = (u.agentId && modelOf.get(u.agentId)) || u.model;
    const k = `${u.component}|${u.agentId ?? ""}|${model}`;
    const o = out.get(k);
    if (!o) out.set(k, { ...u, model });
    else {
      o.runs += u.runs;
      o.input += u.input;
      o.cached += u.cached;
      o.output += u.output;
      o.priced += u.priced;
      o.costUsd = o.costUsd === null && u.costUsd === null ? null : (o.costUsd ?? 0) + (u.costUsd ?? 0);
    }
  }
  return [...out.values()];
}

/**
 * Every minute: model calls from the model gateway's ledger, with what OpenRouter billed, deduped by generation id; usage
 * older than 62 days goes. The gateway keeps 40 days of calls, so a board down for less than that loses none.
 */
export function pullUsage(gateway: { url: string; token: string } | undefined, store: Pick<Store, "addUsage" | "pruneUsage" | "meta" | "setMeta">, log: Logger, everyMs = 60_000, metaKey = "usage_pulled_at") {
  if (!gateway) return;
  const tick = async () => {
    try {
      // From the last pull less a margin (a call is stamped as its answer ends); the overlap dedupes by key.
      const last = store.meta(metaKey);
      const since = last ? new Date(Date.parse(last) - 10 * 60_000).toISOString() : "";
      const now = new Date().toISOString();
      const res = await fetch(`${gateway.url}/usage`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify({ since }), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`the gateway answered ${res.status}`);
      for (const r of pulledRecords(await res.json())) store.addUsage({ ...r, component: r.component ?? "agent", model: r.model || "unknown" });
      store.setMeta(metaKey, now);
      // Kept 62 days, so the Costs tab can set the last 30 days against the 30 before.
      store.pruneUsage(new Date(Date.now() - 62 * DAY).toISOString());
    } catch (err) {
      log.warn({ err: String(err).slice(0, 200), from: gateway.url }, "usage pull failed");
    }
  };
  void tick();
  setInterval(tick, everyMs).unref();
}

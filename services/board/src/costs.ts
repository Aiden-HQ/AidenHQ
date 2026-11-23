// The Costs tab's sources (cost-ledger.ts reads them):
//  - the model gateway's ledger: every model call, with what OpenRouter billed for it, mirrored into the board's usage table every
//    minute (pullUsage), so the tab can group it in SQL;
//  - the kernel's spend summary: the install's day and month against its spend limits, as the gateway enforces them (spendSummary);
//  - OpenRouter's own figures for the key (keyUsage) and its list prices (prices).
import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";
import type { Store } from "./store.js";

const OPENROUTER = "https://openrouter.ai/api/v1";
const DAY = 864e5;

/** A call's run attribution (RunIdentity in kernel/src/gateway/lib.ts, plus how the call went); every field optional. See UsageRecord. */
const Attribution = {
  runKey: z.string().regex(/^[\w:.-]{1,128}$/).nullable().optional(),
  /** The run the call was for: a kernel job's id (the run page's join), or Paperclip's run id from a run JWT. */
  runId: z.string().min(1).max(80).nullable().optional(),
  issueId: z.string().min(1).max(80).nullable().optional(),
  rev: z.string().regex(/^[0-9a-f]{1,64}$/).nullable().optional(),
  // The gateway's own label for the call (any it files: agent, reviewer, check, ci-code-review, ...); a kind this list doesn't know must never drop the call and its dollars.
  kind: z.string().min(1).max(40).nullable().optional(),
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

/** OpenRouter's per-token list prices (USD strings), by model id. */
type Pricing = { prompt?: string; completion?: string; input_cache_read?: string };
export type Prices = Map<string, Pricing>;
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
 * Every minute: model calls from the model gateway's ledger, with what OpenRouter billed, deduped by generation id; usage
 * older than 62 days goes. The gateway keeps 40 days of calls, so a board down for less than that loses none.
 */
export function pullUsage(gateway: { url: string; token: string } | undefined, store: Pick<Store, "addUsage" | "pruneUsage" | "meta" | "setMeta">, log: Logger, everyMs = 60_000, metaKey = "usage_pulled_at") {
  if (!gateway) return;
  let pulling = false; // a catch-up longer than a tick: the next tick waits for it, never starts a second pull
  const tick = async () => {
    if (pulling) return;
    pulling = true;
    try {
      // From the last pull less a margin (a call is stamped as its answer ends); the overlap dedupes by key.
      const last = store.meta(metaKey);
      const since = last ? new Date(Date.parse(last) - 10 * 60_000).toISOString() : "";
      const now = new Date().toISOString();
      // Page by page (a full answer names the next one: after a time and key), the cursor moved only once every page is in.
      for (let from: { since: string; after?: string } = { since }; ; ) {
        const res = await fetch(`${gateway.url}/usage`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify(from), signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`the gateway answered ${res.status}`);
        const body = await res.json();
        const records = pulledRecords(body);
        for (const r of records) store.addUsage({ ...r, component: r.component ?? "agent", model: r.model || "unknown" });
        const skipped = (body as { records: unknown[] }).records.length - records.length;
        if (skipped) log.warn({ skipped }, "usage records the board could not read: their dollars are not counted");
        const next = (body as { next?: { since?: unknown; after?: unknown } }).next;
        if (!next) break;
        if (typeof next.since !== "string" || typeof next.after !== "string" || `${next.since}\0${next.after}` <= `${from.since}\0${from.after ?? ""}`) throw new Error("the gateway's next usage page does not move forward");
        from = { since: next.since, after: next.after };
      }
      store.setMeta(metaKey, now);
      // Kept 62 days, so the Costs tab can set the last 30 days against the 30 before.
      store.pruneUsage(new Date(Date.now() - 62 * DAY).toISOString());
    } catch (err) {
      log.warn({ err: String(err).slice(0, 200), from: gateway.url }, "usage pull failed");
    } finally {
      pulling = false;
    }
  };
  void tick();
  setInterval(tick, everyMs).unref();
}

/** The install's spend against its two limits, from the kernel (GET /v1/spend/summary: the sums the gateway enforces; a UTC day and month). */
export interface SpendSummary {
  day: string;
  month: string;
  install: { day: { spent: number; cap: number }; month: { spent: number; cap: number } };
  agents: { agent_id: string; spent: number }[];
}

/** The kernel's spend summary; null when it doesn't answer (the header then shows no spend line). */
export async function spendSummary(gateway: { url: string; token: string } | undefined): Promise<SpendSummary | null> {
  if (!gateway) return null;
  try {
    const res = await fetch(`${gateway.url}/v1/spend/summary`, { headers: { authorization: `Bearer ${gateway.token}` }, signal: AbortSignal.timeout(3_000) });
    return res.ok ? ((await res.json()) as SpendSummary) : null;
  } catch {
    return null;
  }
}

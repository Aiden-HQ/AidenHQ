// The Costs tab's sources (cost-ledger.ts reads them):
//  - the model gateway's ledger: every model call, with what OpenRouter billed for it, as the kernel's cost reports group it
//    (costReport: POST /v1/costs/<report>, kernel/src/gateway/costs.ts);
//  - the kernel's spend summary: the install's day and month against its spend limits, as the gateway enforces them (spendSummary);
//  - OpenRouter's own figures for the key (keyUsage); list prices come from the gateway's model catalog (modelCatalog).
import { readFileSync } from "node:fs";
import { BadRequest } from "./board.js";
import type { CatalogModel } from "./model-catalog.js";

const OPENROUTER = "https://openrouter.ai/api/v1";

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

/** The kernel's cost reports (kernel/src/gateway/costs.ts): the ledger's rollup, grouped there. */
export type CostReport = <T>(name: "summary" | "top" | "runs" | "issues" | "daily" | "calls", body: Record<string, unknown>) => Promise<T>;

/** A cost report from the kernel (POST /v1/costs/<name>, the board's key); its 400 is the caller's (BadRequest). */
export function costReport(gateway: { url: string; token: string } | undefined): CostReport {
  return async <T>(name: string, body: Record<string, unknown>) => {
    if (!gateway) throw new Error("the board has no model gateway configured (AIDENHQ_GATEWAY_URL, gateway_board_key)");
    const res = await fetch(`${gateway.url}/v1/costs/${name}`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (res.status === 400) throw new BadRequest(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "bad cost report request");
    if (!res.ok) throw new Error(`the kernel's ${name} cost report answered ${res.status}`);
    return (await res.json()) as T;
  };
}

/** The install's spend against its two limits, from the kernel (GET /v1/spend/summary: the sums the gateway enforces; the owner's day and month). */
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

/** The gateway's catalog as the board last read it, and when (a read must never wait on the gateway's own cold refresh). */
let catalogCache: { at: number; models: CatalogModel[] } | undefined;
/** A catalog read under way, shared by every caller that asks for one meanwhile. */
let catalogPending: Promise<CatalogModel[] | null> | undefined;
/** A good catalog is reused this long; a read that found nothing is retried after MISS_CATALOG_MS. */
const CATALOG_TTL_MS = 10 * 60_000;
const MISS_CATALOG_MS = 60_000;
/** When the last read was started (a failed one backs off). */
let catalogTried = 0;

/**
 * One read of OpenRouter's text models from the kernel's gateway (GET /v1/models/catalog: the list it already holds). null
 * when it can't be read; an empty answer is no list (the gateway's cold refresh found nothing) and is not kept.
 */
function readCatalog(gateway: { url: string; token: string }): Promise<CatalogModel[] | null> {
  catalogTried = Date.now();
  return (catalogPending ??= (async () => {
    try {
      const res = await fetch(`${gateway.url}/v1/models/catalog`, { headers: { authorization: `Bearer ${gateway.token}` }, signal: AbortSignal.timeout(25_000) });
      const models = res.ok ? ((await res.json()) as { models: CatalogModel[] }).models : null;
      if (models?.length) catalogCache = { at: Date.now(), models };
      return models?.length ? models : null;
    } catch {
      return null;
    } finally {
      catalogPending = undefined;
    }
  })());
}

/**
 * OpenRouter's text models (their prices feed the cache-savings estimate), from the last good read. Never waits: the first
 * read after a start, or a refresh, runs in the background, so a cold gateway catalog can't hold the Costs page back; the
 * estimate is null until the list arrives, as it is when the gateway has none.
 */
export function modelCatalogCached(gateway: { url: string; token: string } | undefined): CatalogModel[] | null {
  if (!gateway) return null;
  const stale = catalogCache ? Date.now() - catalogCache.at >= CATALOG_TTL_MS : Date.now() - catalogTried >= MISS_CATALOG_MS;
  if (stale && !catalogPending) void readCatalog(gateway);
  return catalogCache?.models ?? null;
}

/** OpenRouter's text models, waiting for a read (the model picker's route needs the list before it can draw). null when it can't be read. */
export async function modelCatalog(gateway: { url: string; token: string } | undefined): Promise<CatalogModel[] | null> {
  if (!gateway) return null;
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
  return catalogPending ?? readCatalog(gateway);
}

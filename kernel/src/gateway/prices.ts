// What each model costs, from OpenRouter's public models list (GET /api/v1/models: every model and `~vendor/name-latest` alias
// with its pricing): the gateway reserves each call at these prices before it is sent (lib.ts). What a call is recorded at is
// OpenRouter's own per-call cost (usage.cost), not these. The list is held in memory, refreshed hourly; a failed refresh keeps
// the last good one. A model the list doesn't name is looked up again (at most once a minute, so a new model works without
// waiting for the hour); with no list at all yet (a cold start) the fetch is retried before the call is turned away.

/** A model's prices for a reservation: USD per million tokens, each the dearest tier the list shows, and the output ceiling. */
export type Price = { in: number; cached_in: number; out: number; max_output: number };

/**
 * The most output tokens a call is reserved for and sent with when it names no limit itself (Codex names none). The list's own
 * ceiling (top_provider.max_completion_tokens) runs to 943718 for some models; one such call would hold a whole cap's room.
 */
export const MAX_OUTPUT = 131072;
const REFRESH_MS = 3600_000;
const MISS_MS = 60_000;

type Pricing = Record<string, unknown> & { overrides?: Record<string, unknown>[] };
type Entry = { id?: unknown; context_length?: unknown; pricing?: Pricing; top_provider?: { max_completion_tokens?: unknown } | null };

/** USD per token as listed → USD per million; undefined when it isn't a price (a router's -1, a missing field). */
const perM = (v: unknown) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n >= 0 ? n * 1e6 : undefined; };

/** One list entry → its reservation prices, or undefined when the list gives it no usable price (refused like an unknown id). */
export function priceOf(e: Entry): Price | undefined {
  const tiers = [e.pricing ?? {}, ...(Array.isArray(e.pricing?.overrides) ? e.pricing.overrides : [])];
  const prompt = perM(e.pricing?.prompt), completion = perM(e.pricing?.completion);
  if (prompt === undefined || completion === undefined) return undefined;
  // Dearest tier: a long prompt's override, and a cache write (billed above plain input) priced as input.
  const most = (keys: string[]) => Math.max(0, ...tiers.flatMap((t) => keys.map((k) => perM(t[k]) ?? 0)));
  const ceiling = Number(e.top_provider?.max_completion_tokens) || Number(e.context_length) || MAX_OUTPUT;
  return {
    in: most(["prompt", "input_cache_write", "input_cache_write_1h"]),
    cached_in: most(["input_cache_read"]) || prompt,
    out: most(["completion"]),
    max_output: Math.min(MAX_OUTPUT, Math.max(1, Math.floor(ceiling))),
  };
}

export function createPrices({ url, now = Date.now, retryMs = [1000, 3000], log = () => {} }: { url: string; now?: () => number; retryMs?: number[]; log?: (msg: string, f?: Record<string, unknown>) => void }) {
  let list = new Map<string, Price>();
  let tried = 0;
  let pending: Promise<void> | undefined;
  /** One fetch of the list, shared by every caller waiting on it; the last good list stays on any failure. */
  const refresh = () => (pending ??= (async () => {
    tried = now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`OpenRouter's models list answered ${res.status}`);
      const data = ((await res.json()) as { data?: Entry[] }).data;
      const next = new Map<string, Price>();
      for (const e of Array.isArray(data) ? data : []) { const p = typeof e?.id === "string" ? priceOf(e) : undefined; if (p) next.set(e.id as string, p); }
      if (!next.size) throw new Error("OpenRouter's models list was empty");
      list = next;
    } catch (e) {
      log("model prices refresh failed", { err: String((e as Error).message).slice(0, 200) });
    }
  })().finally(() => (pending = undefined)));
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  timer.unref();
  return {
    refresh,
    /** Each id's prices, or `missing` (ids OpenRouter doesn't list), or `unavailable` (no list could be read at all). */
    async lookup(ids: string[]): Promise<{ prices: Price[] } | { missing: string[] } | { unavailable: true }> {
      const absent = () => ids.filter((id) => !list.has(id));
      if (absent().length && (!list.size || now() - tried >= MISS_MS)) await refresh();
      for (let n = 0; !list.size && n < retryMs.length; n++) { await new Promise((r) => setTimeout(r, retryMs[n])); await refresh(); }
      if (!list.size) return { unavailable: true };
      const missing = absent();
      return missing.length ? { missing } : { prices: ids.map((id) => list.get(id)!) };
    },
    close: () => clearInterval(timer),
  };
}

// The model picker's catalog: OpenRouter's text models as the kernel's gateway holds them (GET /v1/models/catalog), and the
// pure rules that turn it into the picker's list (shared with the web app: no node imports here).

/** One model: USD per million tokens, `created` in unix seconds (the gateway's CatalogModel). */
export interface CatalogModel { id: string; name: string; provider: string; created: number; context: number; in: number; out: number; tools: boolean; reasoning: boolean }

/** What an engine can run, as its module declares it: one provider's models (`provider`), and models that call tools (`tools`). */
export interface Accepts { provider?: string; tools?: boolean }

export const fits = (m: CatalogModel, a: Accepts = {}) => (!a.provider || m.provider === a.provider) && (!a.tools || m.tools);

/** The bare id the picker shows: a `~vendor/name-latest` alias without its tilde. */
export const shortId = (id: string) => id.replace(/^~/, "");

const VERSION = /^(v?\d+(\.\d+)*|\d{8})$/;
/**
 * The model's family: its id without version numbers and dates, so openai/gpt-6.1-sol and openai/gpt-6.2-sol (or a dated
 * snapshot of either) are one family, while sizes and variants (llama-70b, :free) stay apart. The newest of a family is shown;
 * the rest are its older versions.
 */
export const family = (id: string) => {
  const [name = "", variant = ""] = shortId(id).split(":");
  const [vendor = "", ...rest] = name.split("/");
  return `${vendor}/${rest.join("/").split("-").filter((t) => !VERSION.test(t)).join("-")}${variant && `:${variant}`}`;
};

export interface Row { id: string; model?: CatalogModel }
export interface Section { title: string; rows: Row[] }
export interface Listing { sections: Section[]; /** older versions left out */ older: number }

/**
 * The picker's list for a search: Recommended (the engine's short list, as listed), then the `~…-latest` aliases, then each
 * provider's models, newest first. A model shows once. Older versions of a family are left out until `showOlder`, or a search
 * (which looks for the old one on purpose). With no catalog (not loaded, or it failed) only the recommended models are offered.
 * `current`, a saved id the list no longer holds, stays first so an unrelated edit keeps it.
 */
export function listing({ catalog, recommended, accepts, query, showOlder, current }: { catalog: CatalogModel[]; recommended: readonly string[]; accepts?: Accepts; query: string; showOlder: boolean; current?: string }): Listing {
  const usable = catalog.filter((m) => fits(m, accepts));
  const byId = new Map(usable.map((m) => [m.id, m]));
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (r: Row) => q.every((t) => `${r.id} ${r.model?.name ?? ""}`.toLowerCase().includes(t));
  const seen = new Set<string>();
  const sections: Section[] = [];
  const add = (title: string, rows: Row[]) => {
    const fresh = rows.filter((r) => match(r) && !seen.has(r.id));
    fresh.forEach((r) => seen.add(r.id));
    if (fresh.length) sections.push({ title, rows: fresh });
  };
  const row = (model: CatalogModel): Row => ({ id: model.id, model });

  // With a catalog, a recommended id it doesn't list is dropped (the gateway would refuse it); without one it is all there is.
  add("Recommended", recommended.filter((id) => !catalog.length || byId.has(id)).map((id) => ({ id, model: byId.get(id) })));
  add("Latest aliases", usable.filter((m) => m.id.startsWith("~")).sort((a, b) => a.id.localeCompare(b.id)).map(row));

  const concrete = usable.filter((m) => !m.id.startsWith("~")).sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  const newest = new Map<string, string>();
  for (const m of concrete) if (!newest.has(family(m.id))) newest.set(family(m.id), m.id);
  const all = showOlder || q.length > 0;
  let older = 0;
  for (const p of [...new Set(concrete.map((m) => m.provider))].sort()) {
    const mine = concrete.filter((m) => m.provider === p);
    const kept = mine.filter((m) => all || newest.get(family(m.id)) === m.id || seen.has(m.id));
    older += mine.length - kept.length;
    add(p, kept.map(row));
  }
  if (current && catalog.length && !byId.has(current) && match({ id: current })) sections.unshift({ title: "Not offered", rows: [{ id: current }] });
  return { sections, older };
}

/** "$2.5 / $10": USD per million tokens in and out. */
export const priceText = (m: CatalogModel) => {
  const f = (n: number) => (n === 0 ? "0" : n >= 10 ? String(Math.round(n)) : String(Number(n.toPrecision(2))));
  return `$${f(m.in)} / $${f(m.out)}`;
};
/** "400k", "1M". */
export const contextText = (n: number) => (n >= 1e6 ? `${Number((n / 1e6).toFixed(1))}M` : `${Math.round(n / 1e3)}k`);

/** What a model-backed option tends to use per review, by its cost tier: [input, output] tokens. A guess to tune from the ledger. */
const TIER_TOKENS = { low: [0.4e6, 0.04e6], high: [2.5e6, 0.15e6] } as const;
/** A rough USD guess for one option on a model (a free option, and a model the list doesn't price, count 0). */
export const optionCost = (tier: "free" | "low" | "high", m: CatalogModel | undefined) => (tier === "free" || !m ? 0 : (TIER_TOKENS[tier][0] * m.in + TIER_TOKENS[tier][1] * m.out) / 1e6);
/** A guess in dollars: "$0.40", "<$0.01", "$12". */
export const costText = (usd: number) => (usd < 0.005 ? "<$0.01" : usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`);

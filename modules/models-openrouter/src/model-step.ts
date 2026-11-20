// The first-run model step (/setup/model), the models-openrouter module's, run in the kernel's process: the kernel's admin
// listener (127.0.0.1:3120) serves its pages and routes, signed in, and holds the vault; this holds the flow. Connect is
// OpenRouter's OAuth PKCE (openrouter.ai/docs/use-cases/oauth-pkce): the owner signs in at OpenRouter, which sends a one-time
// code back to /setup/openrouter/<state>; the code and the verifier kept here become an API key. Then one 1-token call to the
// default model, on the gateway's upstream, proves the key works and has credit; only then (or when it only lacks credit) is
// it saved. The callback carries no session (a cross-site return), so its state is the only thing it is trusted by: random,
// bound to the owner's account that made it, spent on first use and gone after 10 minutes.
import { createHash, randomBytes } from "node:crypto";

const b64url = (b: Buffer) => b.toString("base64url");
/** The upstream API base (the gateway's, AIDENHQ_GATEWAY_UPSTREAM) without its /api/v1, for the browser's /auth page. */
const site = (upstream: string) => upstream.replace(/\/api\/v1\/?$/, "");

/** The authorization URL for this callback, and the verifier the exchange needs (kept server-side). */
export function startPkce(callback: string, o: { upstream?: string; state?: string } = {}): { url: string; verifier: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: "S256", key_label: "AidenHQ", ...(o.state ? { state: o.state } : {}) });
  return { url: `${site(o.upstream ?? "https://openrouter.ai/api/v1")}/auth?${q}`, verifier };
}

/**
 * Whether the model works: a key in the vault AND the last check of exactly that key passed. The model step records each
 * check's outcome (the key's hash, or "failed") next to the key, so a key saved without credit, or replaced, isn't ready until
 * a check of it passes. A key with no record at all predates the model step (ops/setup.sh, an older instance): ready.
 */
export const CHECKED = "openrouter_key_checked";
export function readiness(v: { get: (name: string) => string; exists: (name: string) => boolean; save: (name: string, value: string) => void }) {
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  return {
    ready: () => { const k = v.get("openrouter_key"); return Boolean(k) && (!v.exists(CHECKED) || v.get(CHECKED) === hash(k)); },
    checked: (key: string, ok: boolean) => v.save(CHECKED, ok ? hash(key) : "failed"),
  };
}

/** The code from the callback and its verifier → the API key. */
export async function exchange(code: string, verifier: string, fetchImpl: typeof fetch = fetch, upstream = "https://openrouter.ai/api/v1"): Promise<string> {
  const r = await fetchImpl(`${upstream}/auth/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }), signal: AbortSignal.timeout(20_000) });
  const j = (await r.json().catch(() => ({}))) as { key?: unknown };
  if (!r.ok || typeof j.key !== "string" || !j.key) throw new Error(`OpenRouter answered ${r.status}`);
  return j.key;
}

/** One max-1-token call to the default model with this key: ok, no_credit (402), or error (a refused key, anything else). */
export async function checkModel(key: string, o: { model: string; upstream?: string; fetchImpl?: typeof fetch }): Promise<"ok" | "no_credit" | "error"> {
  const r = await (o.fetchImpl ?? fetch)(`${o.upstream ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: o.model, max_tokens: 1, messages: [{ role: "user", content: "Say ok." }], provider: { zdr: true } }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  await r?.body?.cancel().catch(() => {});
  return r?.ok ? "ok" : r?.status === 402 ? "no_credit" : "error";
}

/** The vault's model key (the module's provided secret). */
export const MODEL_KEY = "openrouter_key";
const PENDING_MS = 600_000;

export function createModelStep(o: {
  /** The gateway's upstream (AIDENHQ_GATEWAY_UPSTREAM). */
  upstream: string;
  /** The model the check calls: the first one the modules price. */
  model: () => string;
  /** The kernel's vault view: reads, and writes as new 0600 files renamed into place. */
  vault: { get: (name: string) => string; exists: (name: string) => boolean; save: (name: string, value: string) => void };
  /** Whether a key fits the module's setup pattern. */
  fits: (key: string) => boolean;
  /** The install-wide daily cap (settings.spend_day_usd), if set. */
  dayCap?: () => number | undefined;
  fetchImpl?: typeof fetch;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const state = readiness(o.vault);
  // Pending Connects, by their state: the verifier and the owner who started it.
  const pending = new Map<string, { verifier: string; account: string; at: number }>();
  /** One 1-token call with the key; saved when it works or only lacks credit (Retry then needs no new key). */
  async function take(key: string, by: string) {
    const r = await checkModel(key, { model: o.model(), upstream: o.upstream, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    if (r === "error") return r;
    o.vault.save(MODEL_KEY, key);
    state.checked(key, r === "ok"); // ready only once a check of this key passed (no credit: Retry checks it again)
    o.log?.("model key saved", { by, check: r });
    return r;
  }
  return {
    ready: state.ready,
    saved: () => o.vault.get(MODEL_KEY),
    dayCap: () => o.dayCap?.(),
    fits: o.fits,
    take,
    /** A Connect link for the owner `account`, whose callback is `callback(state)`. */
    connect(callback: (state: string) => string, account: string): string {
      for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
      const id = randomBytes(16).toString("base64url");
      const { url, verifier } = startPkce(callback(id), { upstream: o.upstream, state: id });
      pending.set(id, { verifier, account, at: Date.now() });
      return url;
    },
    /**
     * OpenRouter's callback: the state's pending entry, spent here whatever happens. "" when there is none (a reload, an old or
     * made-up state: the unauthenticated page then says nothing of the vault); a denial carries no code.
     */
    async callback(id: string, code: string): Promise<"ok" | "credit" | "failed" | ""> {
      const p = pending.get(id);
      pending.delete(id);
      if (!p) return "";
      if (!code || Date.now() - p.at > PENDING_MS) return "failed";
      const key = await exchange(code, p.verifier, o.fetchImpl ?? fetch, o.upstream).catch((e: Error) => (o.log?.("openrouter exchange failed", { err: e.message.slice(0, 200) }), ""));
      const r = key && o.fits(key) ? await take(key, `account:${p.account}`) : "error";
      return r === "ok" ? "ok" : r === "no_credit" ? "credit" : "failed";
    },
  };
}
export type ModelStep = ReturnType<typeof createModelStep>;

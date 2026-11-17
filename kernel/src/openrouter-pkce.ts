// Connect OpenRouter on the first-run model step (/setup/model; OpenRouter's OAuth PKCE, openrouter.ai/docs/use-cases/oauth-pkce):
// the owner signs in at OpenRouter, which sends a one-time code back to /setup/openrouter; the code and the verifier kept here
// become an API key. Then one 1-token call to the default model, on the gateway's upstream, proves the key works and has credit.
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

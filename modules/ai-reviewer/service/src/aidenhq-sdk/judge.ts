// The judges' shared pieces (design §4.4 "Judge"): the AI reviewer and the grader keep their own contracts, prompts and
// credentials, and share the models they may use, the cross-family choice and the one schema-bound, tool-less model call.
//
// Canonical copy: kernel/sdk/src/judge.ts. The reviewer and grading services hold byte-identical copies at
// src/aidenhq-sdk/judge.ts: edit this one, then run `node scripts/sync-shared.ts`.

// GPT Luna at medium, then DeepSeek Flash at high (the owner's pick, 2026-11-13; the reviewer eval scores it). GLM Flash at high
// is the owner's checker model (the reviewer's second opinion).
export const LUNA = "~openai/gpt-luna-latest";
export const DEEPSEEK = "~deepseek/deepseek-flash-latest";
export const GLM = "~z-ai/glm-flash-latest";
/** Each judge model's reasoning effort. */
export const EFFORT: Record<string, string> = { [LUNA]: "medium", [DEEPSEEK]: "high", [GLM]: "high" };
/** Output cap, reasoning included: room for high-effort reasoning; Luna allows 128,000. */
export const MAX_TOKENS = 100_000;
/** The largest diff a judge reads; the reviewer sends a larger one to the owner as too large. */
export const MAX_DIFF = 150_000;

/**
 * The models to ask, in order: GPT Luna, then DeepSeek Flash, minus the author's own model family (a DeepSeek author, most of
 * the fleet, gets Luna only; an OpenAI author gets DeepSeek only; never its own family, not even as the fallback).
 */
const FAMILIES: [string, RegExp][] = [
  [LUNA, /openai|gpt/i],
  [DEEPSEEK, /deepseek/i],
];
export const judgeModels = (authorModel = "") => FAMILIES.filter(([, re]) => !re.test(String(authorModel))).map(([m]) => m);

/**
 * A second opinion's models, in order: never the author's family nor the first judge's (GPT Sol, the advisor, is OpenAI like
 * Luna, so it can't be the second opinion on Luna's verdict).
 */
const SECOND: [string, RegExp][] = [
  [GLM, /z-ai|glm/i],
  [DEEPSEEK, /deepseek/i],
  [LUNA, /openai|gpt/i],
];
export const secondModels = (authorModel = "", first = "") => SECOND.filter(([, re]) => !re.test(String(authorModel)) && !re.test(String(first))).map(([m]) => m);

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 524]);
/** Retries for a caller that reaches OpenRouter directly (an eval); through the model gateway, which retries, pass none. */
export const RETRY_DELAYS_MS = [1000, 3000, 9000, 20000];

/**
 * fetch that retries a transient OpenRouter failure (429/5xx "high demand", a reset or timeout) with jittered backoff,
 * honouring Retry-After (capped at 20s); a 4xx validation or auth error is returned at once.
 */
async function fetchRetrying(fetchFn: typeof fetch, delays: number[], url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  for (let n = 0; ; n++) {
    let res: Response | undefined, err: any;
    try { res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { err = e; }
    if (!(err ? true : RETRY_STATUS.has(res!.status)) || n >= delays.length) { if (err) throw err; return res!; }
    const after = Number(res?.headers?.get("retry-after"));
    const wait = Math.min(after > 0 ? after * 1000 : delays[n]! * (0.75 + Math.random() / 2), 20_000);
    console.error(`openrouter retry ${n + 1}/${delays.length} (${res?.status ?? String(err.message).slice(0, 80)}) in ${Math.round(wait)}ms`);
    await res?.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * OpenRouter chat completions with a strict JSON schema, ZDR providers only, no tools. Resolves { content, refusal, usage }.
 * The services pass the model gateway's url and the token the kernel minted for the call; an eval passes OpenRouter's key.
 */
export function openRouterAsk(key: string, { timeoutMs = 600_000, fetchFn = fetch, schema, url = "https://openrouter.ai/api/v1/chat/completions", retryDelaysMs = [] as number[] }: {
  timeoutMs?: number; fetchFn?: typeof fetch; schema: unknown; url?: string; retryDelaysMs?: number[];
}) {
  return async (model: string, { system, user }: { system: string; user: string }) => {
    const res = await fetchRetrying(fetchFn, retryDelaysMs, url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true, schema } },
        provider: { zdr: true },
        reasoning: { effort: EFFORT[model] ?? "high" },
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
    }, timeoutMs);
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json: any = await res.json();
    const msg = json?.choices?.[0]?.message ?? {};
    return { content: msg.content ?? "", refusal: msg.refusal ?? null, usage: json?.usage };
  };
}

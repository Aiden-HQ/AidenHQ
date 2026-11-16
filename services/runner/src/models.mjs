// The runner's own model calls (the grader; lean-core moves it to the grading module): the model families, and OpenRouter
// chat completions with a strict JSON schema, through the model gateway. The AI reviewer is its own module (reviewer@1):
// the runner asks it through the kernel (review-request.mjs) and never calls a reviewer model itself.
import { existsSync, readFileSync } from "node:fs";

// GPT Luna at medium, then DeepSeek Flash at high (the owner's pick, 2026-11-13). GLM Flash at high is the owner's checker model.
export const LUNA = "~openai/gpt-luna-latest";
export const DEEPSEEK = "~deepseek/deepseek-flash-latest";
export const GLM = "~z-ai/glm-flash-latest";
/** Each model's reasoning effort. */
export const EFFORT = { [LUNA]: "medium", [DEEPSEEK]: "high", [GLM]: "high" };
/** Output cap, reasoning included: room for high-effort reasoning; Luna allows 128,000. */
export const MAX_TOKENS = 100_000;
/** The largest diff a model reads (the grader's DIFF block); the AI reviewer sends a larger one back as too large. */
export const MAX_DIFF = 150_000;

/** The models to ask, in order: GPT Luna, then DeepSeek Flash, minus the author's own family (never its own, not even as the fallback). */
const FAMILIES = [
  [LUNA, /openai|gpt/i],
  [DEEPSEEK, /deepseek/i],
];
export const familyModels = (authorModel = "") => FAMILIES.filter(([, re]) => !re.test(String(authorModel))).map(([m]) => m);

/** OpenRouter chat completions with a strict JSON schema, ZDR providers only, no tools. Resolves { content, refusal, usage }. */
export function openRouterAsk(key, { timeoutMs = 600_000, fetchFn = fetch, schema, url = "https://openrouter.ai/api/v1/chat/completions" }) {
  return async (model, { system, user }) => {
    const res = await fetchFn(url, {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json = await res.json();
    const msg = json?.choices?.[0]?.message ?? {};
    return { content: msg.content ?? "", refusal: msg.refusal ?? null, usage: json?.usage };
  };
}

/** The runner's OpenRouter key (the same file its OpenRouter engine uses), or OPENROUTER_API_KEY. */
export function openRouterKey(cfg) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  if (cfg?.openrouterKeyFile && existsSync(cfg.openrouterKeyFile)) return readFileSync(cfg.openrouterKeyFile, "utf8").trim();
  return "";
}

// The judges' shared pieces (design §4.4 "Judge"): the AI reviewer and the grader keep their own contracts, prompts and
// credentials, and share the models they may use, the cross-family choice and the one schema-bound model call (with the
// caller's read-only tools, when it gives any).
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
/** The most diff a judge is shown inline; the reviewer's tools read the rest. */
export const MAX_DIFF = 150_000;
/** The most rounds of tool calls one judge call takes; past it the call fails (`max_turns`) and the caller escalates. */
export const MAX_TURNS = 30;

/** A read-only tool a judge may call: its description and JSON schema for the model, and the code that answers it. */
export type JudgeTool = { description: string; parameters: Record<string, unknown>; run: (args: Record<string, unknown>) => string };

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
async function fetchRetrying(fetchFn: typeof fetch, delays: number[], url: string, init: RequestInit, timeoutMs: number, onRetry = () => {}): Promise<Response> {
  for (let n = 0; ; n++) {
    let res: Response | undefined, err: any;
    try { res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { err = e; }
    if (!(err ? true : RETRY_STATUS.has(res!.status)) || n >= delays.length) { if (err) throw err; return res!; }
    const after = Number(res?.headers?.get("retry-after"));
    const wait = Math.min(after > 0 ? after * 1000 : delays[n]! * (0.75 + Math.random() / 2), 20_000);
    onRetry();
    console.error(`openrouter retry ${n + 1}/${delays.length} (${res?.status ?? String(err.message).slice(0, 80)}) in ${Math.round(wait)}ms`);
    await res?.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * OpenRouter chat completions with a strict JSON schema, ZDR providers only. Resolves { content, refusal, usage, turns }. With
 * `tools` (the caller's, read-only), the model may call them first: each round's calls are answered by code (the caller fences
 * what they return) until it answers, at most MAX_TURNS rounds. The services pass the model gateway's url and the token the
 * kernel minted for the call; an eval passes OpenRouter's key.
 */
export function openRouterAsk(key: string, { timeoutMs = 600_000, fetchFn = fetch, schema, url = "https://openrouter.ai/api/v1/chat/completions", retryDelaysMs = [], onProgress = () => {} }: {
  timeoutMs?: number; fetchFn?: typeof fetch; schema: unknown; url?: string; retryDelaysMs?: number[];
  /** Each step that advances the call (a new model call, a retry, a model answer, a tool round): a call that hangs reports nothing. */
  onProgress?: () => void;
}) {
  return async (model: string, { system, user, tools = {} }: { system: string; user: string; tools?: Record<string, JudgeTool> }) => {
    // A new model call is progress: the caller only reaches it once the one before it answered or gave up (a fallback).
    onProgress();
    const messages: Record<string, unknown>[] = [{ role: "system", content: system }, { role: "user", content: user }];
    const defs = Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, description: t.description, parameters: t.parameters } }));
    const usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
    for (let turn = 0; ; turn++) {
      const res = await fetchRetrying(fetchFn, retryDelaysMs, url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true, schema } },
          ...(defs.length ? { tools: defs } : {}),
          provider: { zdr: true },
          reasoning: { effort: EFFORT[model] ?? "high" },
          max_tokens: MAX_TOKENS,
          temperature: 0,
        }),
      }, timeoutMs, onProgress);
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const json: any = await res.json();
      for (const k of ["prompt_tokens", "completion_tokens", "cost"] as const) usage[k] += Number(json?.usage?.[k]) || 0;
      const msg = json?.choices?.[0]?.message ?? {};
      const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      onProgress();
      if (!calls.length || !defs.length) return { content: msg.content ?? "", refusal: msg.refusal ?? null, usage, turns: turn };
      if (turn >= MAX_TURNS) throw new Error(`max_turns: the judge asked for more than ${MAX_TURNS} rounds of tool calls`);
      // The model's own turn goes back as it came (its reasoning too, which a reasoning model needs to continue).
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls, ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}) });
      for (const c of calls) {
        const tool = Object.hasOwn(tools, c?.function?.name) ? tools[c.function.name] : undefined;
        let out: string;
        try { out = tool ? tool.run(JSON.parse(c.function.arguments || "{}")) : `no tool named ${String(c?.function?.name).slice(0, 60)}`; } catch (e) { out = `error: ${String((e as Error).message).slice(0, 300)}`; }
        messages.push({ role: "tool", tool_call_id: c.id, content: out });
      }
    }
  };
}

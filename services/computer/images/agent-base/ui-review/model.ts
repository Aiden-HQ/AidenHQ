// The model client: OpenRouter-compatible chat completions with images and a JSON schema. The engine reads only
// OPENROUTER_BASE_URL and OPENROUTER_API_KEY (job boxes get both from the gateway). Every call has a hard timeout (request and
// answer body together); a call that times out or fails in transit (network, 429, 5xx) is tried once more. An answer that is
// not the JSON asked for is retried once with the parse error quoted.
import { readFileSync } from "node:fs";

export const DEFAULT_MODEL = "google/gemini-4-carbon";
/** One model call's hard limit, request and body together (a stalled stream once hung a fix-check for good). */
export const CALL_TIMEOUT_MS = 180_000;

export type AskOptions = {
  model: string; system: string; text: string; images: string[]; schema: object;
  /** Throws when the parsed answer has the wrong shape; the error message is quoted in the one retry. */
  validate?: (answer: unknown) => void;
  base?: string; key?: string;
};

/** The run's spend, added up from each answer's usage.cost. */
export const spend = { usd: 0, calls: 0 };

const dataUri = (path: string) => `data:image/${path.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(path).toString("base64")}`;

type Message = { role: string; content: unknown };
class Transient extends Error {}

async function once(o: AskOptions, messages: Message[]): Promise<string> {
  const base = o.base ?? process.env.OPENROUTER_BASE_URL;
  const key = o.key ?? process.env.OPENROUTER_API_KEY;
  if (!base || !key) throw new Error("ui-review: OPENROUTER_BASE_URL and OPENROUTER_API_KEY are required for a model call");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Transient(`model call timed out after ${CALL_TIMEOUT_MS / 1000} s`)), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: o.model, messages, max_tokens: 32000, reasoning: { effort: "low" }, usage: { include: true },
        response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: o.schema } },
      }),
      signal: ac.signal,
    });
    const body = await res.text();
    if (res.status === 429 || res.status >= 500) throw new Transient(`model call failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    const d = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number } };
    spend.usd += d.usage?.cost ?? 0;
    spend.calls++;
    return d.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    if (ac.signal.aborted) throw ac.signal.reason;
    if (e instanceof TypeError) throw new Transient(`model call failed: ${(e.cause as Error)?.message ?? e.message}`); // fetch's network error
    throw e;
  } finally { clearTimeout(timer); }
}

/** One model call: a timeout or a failure in transit is tried once more; a second one throws. */
async function complete(o: AskOptions, messages: Message[]): Promise<string> {
  try { return await once(o, messages); } catch (e) {
    if (!(e instanceof Transient)) throw e;
    return once(o, messages);
  }
}

/** Asks the model for JSON matching `schema`. A malformed or mis-shaped answer is retried once with the error quoted; a second failure throws. */
export async function ask(o: AskOptions): Promise<unknown> {
  const content: unknown[] = [{ type: "text", text: o.text }, ...o.images.map((p) => ({ type: "image_url", image_url: { url: dataUri(p) } }))];
  const messages: Message[] = [{ role: "system", content: o.system }, { role: "user", content }];
  const parse = (raw: string): { value?: unknown; error?: string } => {
    try {
      const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      o.validate?.(value);
      return { value };
    } catch (e) { return { error: (e as Error).message }; }
  };
  const first = await complete(o, messages);
  const a = parse(first);
  if (a.error === undefined) return a.value;
  messages.push({ role: "assistant", content: first }, { role: "user", content: `That answer could not be used: ${a.error}\nAnswer again with only the JSON the schema asks for.` });
  const b = parse(await complete(o, messages));
  if (b.error !== undefined) throw new Error(`model answer rejected twice: ${b.error}`);
  return b.value;
}

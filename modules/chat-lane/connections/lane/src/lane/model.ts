// One lane turn's model loop: streamed chat completions through the instance gateway, with the agent's lane tools, at
// most `maxSteps` model calls. The gateway credential is a per-turn token signed with gateway_lane_secret (the gateway
// accepts it for a capped agent call only).
import { createHmac } from "node:crypto";

export type ChatMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ToolDef { type: "function"; function: { name: string; description?: string; parameters: unknown } }

/** Same format as services/gateway/token.ts: `ahqj_<payload>.<hmac>`, kind agent. */
export function laneToken(secret: string, agentId: string, name: string, ttlMs = 10 * 60_000, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ k: "agent", a: agentId, i: null, c: name, x: now + ttlMs })).toString("base64url");
  return `ahqj_${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** One streamed completion: the text and tool calls it produced. `onText` sees the text so far as it arrives. */
export async function complete(o: { gatewayUrl: string; token: string; body: Record<string, unknown>; signal?: AbortSignal; onText?: (text: string) => void }): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${o.gatewayUrl.replace(/\/$/, "")}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${o.token}` },
    body: JSON.stringify({ ...o.body, stream: true }),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!res.ok || !res.body) throw new Error(`model call failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  let text = "";
  const calls: { id: string; name: string; args: string }[] = [];
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let ev: any;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.error) throw new Error(`model error: ${String(ev.error.message ?? JSON.stringify(ev.error)).slice(0, 300)}`);
      const delta = ev.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        o.onText?.(text);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = Number(tc.index ?? 0);
        const c = (calls[i] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}`, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } }));
  return { text, toolCalls };
}

/**
 * The tool loop: call the model; run any tool calls (through `callTool`); repeat until it answers in text or `maxSteps`
 * model calls are spent (then the last call runs without tools, so it must answer).
 */
export async function runLoop(o: {
  gatewayUrl: string;
  token: string;
  model: string;
  reasoning: "off" | "low";
  messages: ChatMsg[];
  tools: ToolDef[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxSteps?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}): Promise<{ text: string; steps: number; tools: string[] }> {
  const messages = [...o.messages];
  const used: string[] = [];
  const max = o.maxSteps ?? 6;
  for (let step = 1; step <= max; step++) {
    const last = step === max;
    const body: Record<string, unknown> = {
      model: o.model,
      messages,
      reasoning: o.reasoning === "low" ? { effort: "low" } : { enabled: false },
      ...(o.tools.length && !last ? { tools: o.tools } : {}),
    };
    const r = await complete({ gatewayUrl: o.gatewayUrl, token: o.token, body, ...(o.signal ? { signal: o.signal } : {}), ...(o.onText ? { onText: o.onText } : {}) });
    if (!r.toolCalls.length) return { text: r.text.trim(), steps: step, tools: used };
    messages.push({ role: "assistant", content: r.text || null, tool_calls: r.toolCalls });
    const results = await Promise.all(
      r.toolCalls.map(async (c) => {
        used.push(c.function.name);
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(c.function.arguments || "{}"); } catch { return "error: the arguments were not valid JSON"; }
        return o.callTool(c.function.name, args).catch((e: Error) => `error: ${e.message}`);
      }),
    );
    r.toolCalls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: results[i]! }));
  }
  return { text: "", steps: max, tools: used };
}

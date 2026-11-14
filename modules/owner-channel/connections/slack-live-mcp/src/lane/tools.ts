// The lane's tools: an MCP client per (agent, connection), calling the agent's granted MCP servers with its own agent key
// (X-Agent-Key), so every call passes the same grants check as a normal run. Only the tools in the agent's `chat.tools`
// are offered to the model; schemas come from tools/list and are cached.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LaneAgent } from "./config.js";
import type { ToolDef } from "./model.js";

const MAX_RESULT = 6000;

export function makeTools() {
  const clients = new Map<string, Promise<Client>>();
  const schemas = new Map<string, { at: number; defs: ToolDef[] }>();

  const client = (agent: LaneAgent, url: string, token: string): Promise<Client> => {
    const k = `${agent.key}|${agent.apiKey.slice(-8)}|${url}`;
    let c = clients.get(k);
    if (!c) {
      const headers: Record<string, string> = { "x-agent-key": agent.apiKey, ...(token ? { authorization: `Bearer ${token}` } : {}) };
      c = (async () => {
        const cl = new Client({ name: "fast-lane", version: "0.1.0" });
        await cl.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
        return cl;
      })();
      c.catch(() => clients.delete(k));
      clients.set(k, c);
    }
    return c;
  };

  /** The model-facing tool definitions for this agent (only its lane tools). */
  async function defs(agent: LaneAgent): Promise<ToolDef[]> {
    const k = `${agent.key}|${agent.tools.map((t) => `${t.connection}.${t.name}`).join(",")}`;
    const hit = schemas.get(k);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.defs;
    const out: ToolDef[] = [];
    for (const url of new Set(agent.tools.map((t) => t.url))) {
      const want = agent.tools.filter((t) => t.url === url);
      try {
        const listed = await (await client(agent, url, want[0]!.token)).listTools();
        for (const t of listed.tools) if (want.some((w) => w.name === t.name)) out.push({ type: "function", function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.inputSchema } });
      } catch {
        // A connection that is down just offers no tools this turn.
      }
    }
    schemas.set(k, { at: Date.now(), defs: out });
    return out;
  }

  /** Runs one tool; its text result, cut to a fixed size. A tool not in the agent's lane tools is refused here. */
  async function call(agent: LaneAgent, name: string, args: Record<string, unknown>): Promise<string> {
    const t = agent.tools.find((x) => x.name === name);
    if (!t) return `error: ${name} isn't one of your tools here`;
    const run = async () => (await client(agent, t.url, t.token)).callTool({ name, arguments: args });
    const r = await run().catch(async () => {
      clients.clear(); // a dropped connection: reconnect once
      return run();
    });
    const text = ((r.content ?? []) as { type: string; text?: string }[]).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    const body = r.isError ? `error: ${text}` : text;
    return body.length > MAX_RESULT ? `${body.slice(0, MAX_RESULT)}\n…(cut)` : body;
  }

  return { defs, call };
}
export type Tools = ReturnType<typeof makeTools>;

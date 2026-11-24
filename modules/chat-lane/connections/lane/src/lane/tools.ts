// The lane's tools: an MCP client per (agent, connection), calling the kernel's proxy with the lane's own module token and
// the agent it speaks for (x-aidenhq-lane-agent; the kernel takes that agent's grants on its chat task, kernel/src/identity.ts
// laneCaller), so every call passes the same grants check as a normal run. Only the tools in the agent's `chat.tools` are offered
// to the model; schemas come from tools/list and are cached.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LaneAgent } from "./config.js";
import type { ToolDef } from "./model.js";

const MAX_RESULT = 6000;

export function makeTools(token: string) {
  const clients = new Map<string, Promise<Client>>();
  const schemas = new Map<string, { at: number; defs: ToolDef[] }>();

  const client = (agent: LaneAgent, connection: string): Promise<Client> => {
    const k = `${agent.id}|${connection}`;
    let c = clients.get(k);
    if (!c) {
      const url = new URL(`/c/${connection}/mcp`, process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130");
      c = (async () => {
        const cl = new Client({ name: "fast-lane", version: "0.1.0" });
        await cl.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}`, "x-aidenhq-lane-agent": agent.id } } }));
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
    let failed = false;
    for (const connection of new Set(agent.tools.map((t) => t.connection))) {
      const want = agent.tools.filter((t) => t.connection === connection);
      try {
        const listed = await (await client(agent, connection)).listTools();
        for (const t of listed.tools) if (want.some((w) => w.name === t.name)) out.push({ type: "function", function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.inputSchema } });
      } catch (e) {
        // A connection that is down offers no tools this turn, and the reduced list is not cached.
        failed = true;
        console.error(`lane: listing tools of ${connection} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!failed) schemas.set(k, { at: Date.now(), defs: out });
    return out;
  }

  /** Runs one tool; its text result, cut to a fixed size. A tool not in the agent's lane tools is refused here. */
  async function call(agent: LaneAgent, name: string, args: Record<string, unknown>): Promise<string> {
    const t = agent.tools.find((x) => x.name === name);
    if (!t) return `error: ${name} isn't one of your tools here`;
    const run = async () => (await client(agent, t.connection)).callTool({ name, arguments: args });
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

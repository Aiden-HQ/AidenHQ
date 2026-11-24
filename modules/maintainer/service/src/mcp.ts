// The module's MCP connection (a stateless JSON-RPC subset: initialize, tools/list, tools/call) for the kernel's
// proxy: the module's tools and its Fleet page view. Every call carries the kernel's caller assertion, whose signed roles gate
// each tool; the connection returns untrusted (a PR's title is a stranger's text).
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Caller } from "./aidenhq-sdk/caller.ts";

type Dict = Record<string, unknown>;
export interface Tool {
  name: string; description: string; inputSchema: object; roles?: string[];
  run: (args: Dict, caller: { agent: string; roles: string[]; assertion?: string; task?: string; kind?: string }) => Promise<unknown>;
}
type Msg = { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; uri?: string } };
const text = (v: unknown, isError = false, structured = false) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }], ...(structured && v && typeof v === "object" ? { structuredContent: v } : {}), ...(isError ? { isError: true } : {}) });
/** The Fleet page: an MCP Apps view (text/html;profile=mcp-app) the module serves as a resource. */
export interface View { uri: string; html: string }

// A page.html with the shared kit (page-kit.css, page-kit.js: services/shared) inlined at its kit:css and kit:js markers.
export function pageHtml(dir: URL): string {
  const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
  return read("./page.html").replace("/*kit:css*/", () => read("./page-kit.css")).replace("/*kit:js*/", () => read("./page-kit.js"));
}

export function createMcp(name: string, tools: Tool[], views: View[] = []) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async function handle(msg: Msg, caller: () => Promise<Caller & { assertion?: string }>): Promise<object | undefined> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {}, ...(views.length ? { resources: {} } : {}) }, serverInfo: { name, version: "0.1.0" } });
    if (msg.method === "tools/list") return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (msg.method === "resources/read") {
      const v = views.find((x) => x.uri === msg.params?.uri);
      return v ? reply({ contents: [{ uri: v.uri, mimeType: "text/html;profile=mcp-app", text: v.html }] }) : { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32002, message: "no such resource" } };
    }
    if (msg.method === "tools/call") {
      const tool = byName.get(String(msg.params?.name));
      if (!tool) return reply(text(`no tool ${String(msg.params?.name)}`, true));
      let who: Caller & { assertion?: string };
      try { who = await caller(); } catch (e) { return reply(text(`Refused: ${(e as Error).message}.`, true)); }
      if (who.kind !== "owner" && tool.roles && !tool.roles.some((r) => who.roles.includes(r))) return reply(text(`Refused: ${tool.name} is for an agent with the ${tool.roles.join(" or ")} role.`, true));
      try { return reply(text(await tool.run(msg.params?.arguments ?? {}, who), false, who.kind === "owner")); } catch (e) { return reply(text(String((e as Error).message ?? e), true)); }
    }
    return msg.id === undefined ? undefined : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  };
}

/** POST /mcp with the connection's service key; false for any other path. */
export function serveMcp(handle: ReturnType<typeof createMcp>, key: () => string, caller: (req: IncomingMessage) => Promise<Caller & { assertion?: string }>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== "POST" || !URL.canParse(req.url ?? "/", "http://localhost") || new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") return false;
    const want = Buffer.from(key()), got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return void res.writeHead(401).end(), true;
    let n = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) { n += (c as Buffer).length; if (n > 400_000) return void res.writeHead(413).end(), true; chunks.push(c as Buffer); }
    let msg: Msg | Msg[];
    try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return void res.writeHead(400).end(), true; }
    const who = () => caller(req);
    const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => handle(m, who)))).filter(Boolean) : await handle(msg, who);
    if (out === undefined) return void res.writeHead(202).end(), true;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    return true;
  };
}

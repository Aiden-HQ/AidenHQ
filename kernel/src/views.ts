// POST /v1/views/:module/mcp (the board's key): a module view's one call, for the owner (docs/design/board-ui.md "Modules").
// A view (an MCP Apps resource a module's Fleet page shows) reaches only what its page declares: compile puts each view and
// its tools on the module's own connection (connections.json `views`), and this route answers `resources/read` of that view
// and `tools/call` of those tools, nothing else. The call goes to the module once, with a caller assertion of kind `owner`
// (no agent, no roles, no flight: the owner's view acts at no control-plane route); the module decides what the owner may do.
// The answer is the module's own message for this request, as it sent it: the owner's own UI reads it, never an agent.
import http from "node:http";
import type { Asserter } from "./assert.ts";
import type { Connection } from "./identity.ts";
import type { Resolver } from "./net.ts";
import { fail, mapMessages } from "./proxy.ts";

const MAX_ANSWER = 4 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export type ViewCall = { view: string; method: "resources/read" | "tools/call"; params: Record<string, unknown> };

export function createViews({ connections, asserter, resolver, secret }: { connections: () => Record<string, Connection>; asserter: Asserter; resolver: Resolver; secret: (name: string) => string }) {
  /** The module's JSON-RPC answer (`result` or `error`) to one view call; refused (403 view-refused) unless its page declares it. */
  return async function call(module: string, body: unknown): Promise<Record<string, unknown>> {
    const b = (body ?? {}) as Partial<ViewCall>;
    const view = typeof b.view === "string" ? b.view : "";
    const params = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params : {};
    const entry = Object.entries(connections()).find(([, c]) => c.module === module && c.views && Object.hasOwn(c.views, view));
    if (!entry) throw fail(403, "view-refused", `${module} has no view ${view.slice(0, 120)}`);
    const [name, conn] = entry;
    let out: Record<string, unknown>, tool = "";
    if (b.method === "resources/read") {
      if (params.uri !== view) throw fail(403, "view-refused", "a view reads only its own resource");
      out = { uri: view };
    } else if (b.method === "tools/call") {
      tool = typeof params.name === "string" ? params.name : "";
      if (!conn.views![view]!.includes(tool)) throw fail(403, "view-refused", `${view} may not call ${tool.slice(0, 80)}: its page doesn't list it`);
      out = { name: tool, arguments: params.arguments && typeof params.arguments === "object" ? params.arguments : {} };
    } else throw fail(403, "view-refused", "a view reads its resource or calls its tools, nothing else");
    const signed = asserter.signCaller({ agent: "", key: "", name: "owner", roles: [], tool: `${name}.${tool}`, aud: module, kind: "owner" });
    const to = await resolver.resolve(conn.url);
    const req = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: b.method, params: out }));
    const { status, sse, text } = await new Promise<{ status: number; sse: boolean; text: string }>((ok, ko) => {
      const r = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: TIMEOUT_MS, headers: { host: new URL(conn.url).host, authorization: `Bearer ${secret(conn.auth_secret)}`, "x-aidenhq-caller": signed.jwt, accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": req.length } }, (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => ((n += c.length) <= MAX_ANSWER ? chunks.push(c) : res.destroy(new Error("answer too large"))));
        res.on("end", () => ok({ status: res.statusCode ?? 502, sse: String(res.headers["content-type"] ?? "").includes("text/event-stream"), text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", ko);
      });
      r.on("timeout", () => r.destroy(new Error(`${name} didn't answer in time`)));
      r.on("error", (e) => (resolver.forget(conn.url), ko(fail(502, "bad_upstream", e.message))));
      r.end(req);
    });
    if (status >= 300) throw fail(502, "bad_upstream", `${name} answered ${status}`);
    let answer: Record<string, unknown> | undefined;
    mapMessages(text, sse, (m) => { if (m.id === 1 && !("method" in m)) answer = m.error ? { error: m.error } : { result: m.result }; });
    if (!answer) throw fail(502, "bad_upstream", `${name} sent no answer`);
    return answer;
  };
}
export type Views = ReturnType<typeof createViews>;

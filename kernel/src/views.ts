// POST /v1/views/:module/mcp (the board's key): a module view's one call, for the owner (docs/design/board-ui.md "Modules").
// A view (an MCP Apps resource a module's Fleet page shows) reaches only what its page declares: compile puts each view and
// its tools on the module's own connection (connections.json `views`), and this route answers `resources/read` of that view
// and `tools/call` of those tools, nothing else. The call goes to the module once, with a caller assertion of kind `owner`
// (no agent, no roles, no flight: the owner's view acts at no control-plane route); the module decides what the owner may do.
// The answer is the module's own message for this request, as it sent it: the owner's own UI reads it, never an agent.
import type { Asserter } from "./assert.ts";
import type { Connection } from "./identity.ts";
import type { Resolver } from "./net.ts";
import { fail, mapMessages, postOnce } from "./proxy.ts";

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
      // A board read (`read:<id>`, board.reads) is a tool only; only a page's ui:// view has a resource.
      if (!view.startsWith("ui://")) throw fail(403, "view-refused", "only a page's ui:// view has a resource to read");
      if (params.uri !== view) throw fail(403, "view-refused", "a view reads only its own resource");
      out = { uri: view };
    } else if (b.method === "tools/call") {
      tool = typeof params.name === "string" ? params.name : "";
      if (!conn.views![view]!.includes(tool)) throw fail(403, "view-refused", `${view} may not call ${tool.slice(0, 80)}: its page doesn't list it`);
      out = { name: tool, arguments: params.arguments && typeof params.arguments === "object" ? params.arguments : {} };
    } else throw fail(403, "view-refused", "a view reads its resource or calls its tools, nothing else");
    const signed = asserter.signCaller({ agent: "", key: "", name: "owner", roles: [], tool: `${name}.${tool}`, aud: module, kind: "owner" });
    const { status, sse, text } = await postOnce({ conn, name, resolver, secret, caller: signed.jwt, method: b.method, params: out }).catch((e: Error) => { throw fail(502, "bad_upstream", e.message); });
    if (status >= 300) throw fail(502, "bad_upstream", `${name} answered ${status}`);
    let answer: Record<string, unknown> | undefined;
    mapMessages(text, sse, (m) => { if (m.id === 1 && !("method" in m)) answer = m.error ? { error: m.error } : { result: m.result }; });
    if (!answer) throw fail(502, "bad_upstream", `${name} sent no answer`);
    return answer;
  };
}
export type Views = ReturnType<typeof createViews>;

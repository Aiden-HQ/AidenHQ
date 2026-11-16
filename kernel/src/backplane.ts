// The kernel's backplane listener (10.231.0.1:3130): the tool proxy, caller identity, the keys modules check assertions
// with, the agent directory modules read, and the control plane as the calling agent.
//   GET  /healthz              ok
//   GET  /v1/jwks              the caller-assertion keys
//   GET  /v1/whoami            (run, job or module token) who the bearer is and its granted tools
//   GET  /v1/agents            (module token) every agent's key, roles and the fields setup records for it, never its tools
//   POST /c/<connection>/mcp   (run or module token) the tool proxy (proxy.ts)
//   ANY  /v1/cp/agent/<path>   (module token + caller assertion) cp.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Asserter } from "./assert.ts";
import type { Grant, Whoami } from "./identity.ts";
import { fail } from "./proxy.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, ...a: string[]) => Promise<void>;
/** Directory fields a module may read; everything else in the grants table (tools, models, caps, images) stays here. */
const DIRECTORY = ["key", "roles", "trial", "delegate_to", "memory_inbox", "review_log", "graded"];
const SETTINGS = ["grading", "loop_brake"];

export function createBackplane({ whoami, asserter, proxy, cp, grantsFile, log = () => {} }: {
  whoami: Whoami; asserter: Asserter; proxy: Handler; cp: Handler; grantsFile: () => { agents?: Record<string, Grant> } & Record<string, unknown>; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const send = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [path = "", q] = String(req.url ?? "").split(/\?(.*)/s);
    const query = q ? `?${q}` : "";
    try {
      if (req.method === "GET" && path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      if (req.method === "GET" && path === "/v1/jwks") return send(res, 200, asserter.jwks);
      if (req.method === "GET" && path === "/v1/whoami") {
        const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
        return send(res, 200, { kind: w.kind, ...(w.agent ? { agent: w.agent } : {}), roles: w.roles, ...(w.task ? { task: w.task } : {}), ...(w.run ? { run: w.run } : {}), ...(w.module ? { module: w.module } : {}), tools: w.tools });
      }
      if (req.method === "GET" && path === "/v1/agents") {
        const w = await whoami(bearer(req)).catch(() => undefined);
        if (w?.kind !== "module") throw fail(401, "unauthorized", "a module's own token is required");
        const t = grantsFile();
        const agents = Object.fromEntries(Object.entries(t.agents ?? {}).map(([id, g]) => [id, Object.fromEntries(DIRECTORY.filter((k) => g[k] !== undefined).map((k) => [k, g[k]]))]));
        return send(res, 200, { agents, settings: Object.fromEntries(SETTINGS.map((k) => [k, t[k] ?? "on"])) });
      }
      const c = /^\/c\/([a-z0-9_]+)\/mcp$/.exec(path);
      if (c) return await proxy(req, res, c[1]!);
      if (path.startsWith("/v1/cp/agent/")) return await cp(req, res, path.slice("/v1/cp/agent".length), query);
      send(res, 404, { error: "no such route" });
    } catch (err) {
      const e = err as Error & { status?: number; type?: string };
      const status = e.status ?? 500;
      if (status >= 500) log("backplane error", { url: path, status, err: String(e.message).slice(0, 300) });
      if (!res.headersSent) send(res, status, { error: { code: status, type: e.type ?? "error", message: e.message } });
      else res.destroy();
    }
  };
}

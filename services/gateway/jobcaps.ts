// POST /c/<connection>/mcp: a runner job's reads of a connection (its jobcaps, config/jobcaps.json, compiled from the modules'
// `jobcaps:`), with the job's own token as the bearer. The token (gateway_job_secret, kind agent; never a lane token) must name
// a jobcap on that connection. Deny by default: only initialize, ping, notifications/initialized, tools/list (filtered to the
// jobcap's tools) and tools/call of one of those tools are forwarded, each re-serialized from what was checked (never the raw
// bytes), to the connection's read endpoint with its read secret. The job never holds the endpoint or the secret, and its
// token never goes further than this.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken } from "./token.ts";

/** One jobcap (config/jobcaps.json, by id). */
export type Jobcap = { connection: string; url: string; bearer_secret: string; tools: string[]; tool_timeout_s?: number; prompt?: string };
type Log = (msg: string, fields?: Record<string, unknown>) => void;

const MAX_BODY = 4 * 1024 * 1024;
const MAX_LIST = 8 * 1024 * 1024;
// Request headers never forwarded: the job's own token, hop-by-hop ones and the encoding (a tools/list answer is rewritten).
const DROP = new Set(["authorization", "host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding", "x-agent-key", "proxy-authorization"]);
const FORWARDED = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);
const fail = (status: number, type: string, message: string) => Object.assign(new Error(message), { status, type });

async function readAll(stream: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > max) throw fail(413, "too_large", "too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** A tools/list answer with only `allowed` tools; undefined when it isn't a JSON-RPC message (the answer is then refused). */
function filterMessage(text: string, allowed: Set<string>): string | undefined {
  let m: { result?: { tools?: { name?: unknown }[] } };
  try { m = JSON.parse(text); } catch { return undefined; }
  if (!m || typeof m !== "object") return undefined;
  if (Array.isArray(m.result?.tools)) m.result.tools = m.result.tools.filter((t) => allowed.has(String(t?.name)));
  return JSON.stringify(m);
}

/** The whole answer to a tools/list, JSON or SSE, with only `allowed` tools. Throws on anything it can't read. */
export function filterToolsList(body: string, sse: boolean, allowed: Set<string>): string {
  if (!sse) return filterMessage(body, allowed) ?? (() => { throw fail(502, "bad_upstream", "the connection's tool list isn't JSON"); })();
  return body.split(/\r?\n/).map((line) => {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m || !m[1]!.trim()) return line;
    const out = filterMessage(m[1]!, allowed);
    if (out === undefined) throw fail(502, "bad_upstream", "the connection's tool list isn't JSON");
    return `data: ${out}`;
  }).join("\n");
}

export function jobcapRoute({ jobcaps, secret, log = () => {}, now = Date.now }: { jobcaps: () => Record<string, Jobcap>; secret: (name: string) => string; log?: Log; now?: () => number }) {
  return async function route(req: IncomingMessage, res: ServerResponse, connection: string): Promise<void> {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    const who = verifyToken(secret("gateway_job_secret"), token, now());
    if (!who || who.k !== "agent") throw fail(401, "unauthorized", "a job's own token is required");
    const all = jobcaps();
    const caps = (who.j ?? []).map((id) => all[id]).filter((c): c is Jobcap => c?.connection === connection);
    if (!caps.length) throw fail(401, "unauthorized", `this job has no jobcap on ${connection}`);
    // Streamable HTTP: no server-initiated stream (405 tells the client so); DELETE ends a session.
    if (req.method !== "POST" && req.method !== "DELETE") { res.writeHead(405, { allow: "POST, DELETE" }).end(); return; }
    const cap = caps[0]!;
    const allowed = new Set(caps.flatMap((c) => c.tools));
    const raw = await readAll(req, MAX_BODY);
    let method = "", tool: string | undefined, body = Buffer.alloc(0);
    if (req.method === "POST") {
      let msg: { method?: unknown; id?: unknown; params?: Record<string, unknown> };
      try { msg = JSON.parse(raw.toString("utf8")); } catch { throw fail(400, "bad_request", "the body must be one JSON-RPC message"); }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw fail(400, "bad_request", "the body must be one JSON-RPC message (no batches)");
      method = typeof msg.method === "string" ? msg.method : "";
      const id = msg.id ?? null;
      const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : undefined;
      const refuse = (code: number, message: string) => {
        log("jobcap refused", { url: `/c/${connection}/mcp`, agent: who.a, issue: who.i, method, ...(tool ? { tool } : {}) });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
      };
      if (!FORWARDED.has(method)) return refuse(-32601, "method-refused");
      // What upstream gets is rebuilt from the checked fields only: a duplicate or odd key can't change what it runs.
      let fwd: Record<string, unknown> | undefined = params;
      if (method === "tools/call") {
        tool = typeof params?.name === "string" ? params.name : "";
        if (!allowed.has(tool)) return refuse(-32602, "tool-unlisted");
        fwd = { name: tool, ...(params?.arguments !== undefined ? { arguments: params.arguments } : {}), ...(params?._meta !== undefined ? { _meta: params._meta } : {}) };
      } else if (method === "tools/list") fwd = typeof params?.cursor === "string" ? { cursor: params.cursor } : undefined;
      body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...("id" in msg ? { id } : {}), method, ...(fwd ? { params: fwd } : {}) }));
    }
    log("jobcap call", { url: `/c/${connection}/mcp`, agent: who.a, issue: who.i, method: method || req.method, ...(tool ? { tool } : {}) });
    const up = new URL(cap.url);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP.has(k)) headers[k] = v;
    headers.host = up.host;
    headers["content-length"] = String(body.length);
    const bearer = secret(cap.bearer_secret);
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const timeoutMs = (Math.max(...caps.map((c) => c.tool_timeout_s ?? 0), 120) + 30) * 1000;
    await new Promise<void>((resolve, reject) => {
      const out = http.request({ host: up.hostname, port: Number(up.port || 80), path: `${up.pathname}${up.search}`, method: req.method, headers, timeout: timeoutMs }, async (ur) => {
        try {
          const hdrs = { ...ur.headers };
          if (method !== "tools/list" || (ur.statusCode ?? 500) >= 300) {
            res.writeHead(ur.statusCode ?? 502, hdrs);
            ur.pipe(res);
            ur.on("end", resolve);
            ur.on("error", reject);
            return;
          }
          const sse = String(ur.headers["content-type"] ?? "").includes("text/event-stream");
          const body = filterToolsList((await readAll(ur, MAX_LIST)).toString("utf8"), sse, allowed);
          delete hdrs["content-length"];
          delete hdrs["transfer-encoding"];
          delete hdrs["content-encoding"];
          res.writeHead(ur.statusCode ?? 200, { ...hdrs, "content-length": Buffer.byteLength(body) }).end(body);
          resolve();
        } catch (e) { reject(e); }
      });
      out.on("timeout", () => out.destroy(fail(504, "timeout", `${connection} didn't answer in time`)));
      out.on("error", (e) => reject((e as { status?: number }).status ? e : fail(502, "bad_upstream", `${connection} is unreachable (${e.message})`)));
      out.end(body);
    });
  };
}

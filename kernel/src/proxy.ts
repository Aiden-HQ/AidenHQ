// POST /c/<connection>/mcp: every agent tool call (spec §3.2). Resolve the caller from its own bearer (whoami), refuse a
// tool the connection's manifest doesn't list (tool-unlisted) or the caller isn't granted (no-grant), then forward a
// message rebuilt from the checked fields only, with the module's service key and, on a tools/call, a signed caller
// assertion that is in flight until the module's answer ends. tools/list comes back filtered to the granted, listed tools;
// a result from a connection that returns untrusted text comes back fenced. The caller's own credential never leaves here.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fence } from "../sdk/src/fence.ts";
import type { Asserter } from "./assert.ts";
import { NoGrants, type Connection, type Identity, type Whoami } from "./identity.ts";
import type { Resolver } from "./net.ts";

type Log = (msg: string, fields?: Record<string, unknown>) => void;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_ANSWER = 16 * 1024 * 1024;
const FORWARDED = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);
// Request headers passed on: the MCP transport's own. Nothing else (the caller's bearer above all) leaves.
const PASS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);
export const fail = (status: number, type: string, message: string) => Object.assign(new Error(message), { status, type });

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

/**
 * Each JSON-RPC message of an answer (JSON or SSE) through `fn`, which may return false to drop it; the answer re-emitted from
 * the kept messages only. Strict: an SSE line that isn't a data, event, id or retry field, a comment or a blank line, or a
 * message that isn't one JSON object, fails the whole answer (nothing of it reaches the caller).
 */
export function mapMessages(body: string, sse: boolean, fn: (m: Record<string, any>) => boolean | void): string {
  const bad = () => fail(502, "bad_upstream", "the connection's answer isn't well-formed JSON-RPC");
  const parse = (text: string) => {
    let m: Record<string, any>;
    try { m = JSON.parse(text); } catch { throw bad(); }
    if (!m || typeof m !== "object" || Array.isArray(m)) throw bad();
    return fn(m) === false ? undefined : JSON.stringify(m);
  };
  if (!sse) return parse(body) ?? (() => { throw bad(); })();
  const kept: string[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line === "" || line.startsWith(":") || /^(event|id|retry)(:|$)/.test(line)) continue;
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m) throw bad();
    if (!m[1]!.trim()) continue;
    const out = parse(m[1]!);
    if (out !== undefined) kept.push(`event: message\ndata: ${out}\n\n`);
  }
  return kept.join("");
}

/**
 * The tools a caller may use on a connection, and the tools it lists. An agent: its granted tools the manifest lists. A job:
 * its jobcaps' tools (declared in the manifests, compile-checked), never one the connection tags write or destructive.
 */
export function toolsFor(who: Identity, connection: string, conn: Connection | undefined): { listed: Set<string>; allowed: Set<string> } {
  const tagged = conn ? [...conn.tools.read, ...conn.tools.write, ...conn.tools.destructive] : [];
  if (who.kind === "job") {
    const writes = new Set(conn ? [...conn.tools.write, ...conn.tools.destructive] : []);
    const reads = new Set((who.tools[connection] ?? []).filter((t) => !writes.has(t)));
    return { listed: new Set([...tagged, ...reads]), allowed: reads };
  }
  const listed = new Set(tagged);
  return { listed, allowed: new Set((who.tools[connection] ?? []).filter((t) => listed.has(t))) };
}

/** An untrusted tools/call answer as the agent may see it: every string in it fenced, anything it can't fence dropped. */
export function fenceAnswer(m: Record<string, any>, source: string): void {
  if (m.result && typeof m.result === "object") {
    const r = m.result;
    r.content = (Array.isArray(r.content) ? r.content : []).flatMap((c: { type?: string; text?: unknown; resource?: { text?: unknown } }) => {
      if (c?.type === "text") return [{ type: "text", text: fence(String(c.text ?? ""), source) }];
      if (c?.type === "resource" && typeof c.resource?.text === "string") return [{ type: "text", text: fence(c.resource.text, source) }];
      return c?.type === "image" ? [c] : []; // audio, blobs and links carry nothing an agent reads as text here
    });
    for (const k of Object.keys(r)) if (k !== "content" && k !== "isError") delete r[k]; // structuredContent, _meta and the rest
  }
  if (m.error && typeof m.error === "object") {
    m.error = { code: typeof m.error.code === "number" ? m.error.code : -32603, message: fence(String(m.error.message ?? ""), source),
      ...(m.error.data !== undefined ? { data: fence(typeof m.error.data === "string" ? m.error.data : JSON.stringify(m.error.data), source) } : {}) };
  }
}

export function createProxy({ whoami, connections, asserter, resolver, secret, log = () => {} }: {
  whoami: Whoami; connections: () => Record<string, Connection>; asserter: Asserter; resolver: Resolver; secret: (name: string) => string; log?: Log;
}) {
  return async function proxy(req: IncomingMessage, res: ServerResponse, connection: string, { jobs = false }: { jobs?: boolean } = {}): Promise<void> {
    const t0 = Date.now();
    const conn = Object.hasOwn(connections(), connection) ? connections()[connection] : undefined;
    if (!conn && !jobs) throw fail(404, "not_found", `no connection ${connection}`);
    let who: Identity;
    try {
      who = await whoami(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim());
    } catch (e) {
      log("proxy", { connection, outcome: (e as { code?: string }).code ?? "denied_unknown_caller", ms: Date.now() - t0 });
      throw fail(e instanceof NoGrants ? 403 : 401, "unauthorized", (e as Error).message);
    }
    // The job listener (loopback 8201, the jail's one port) takes job tokens only; the backplane takes the others.
    if ((who.kind === "job") !== jobs) throw fail(401, "unauthorized", jobs ? "a job's own token is required here" : "a job's token works only on its own listener");
    const cap = jobs ? who.caps?.[connection]?.[0] : undefined;
    if (jobs && !cap) throw fail(401, "unauthorized", `this job has no jobcap on ${connection}`);
    // Where the call goes: an agent's to the module's endpoint with its service key; a job's to its jobcap's read endpoint
    // with the read secret (1a), never the service key.
    const target = cap ? { url: cap.url, secret: cap.bearer_secret, timeout: Math.max(...who.caps![connection]!.map((c) => c.tool_timeout_s ?? 0), 120) } : { url: conn!.url, secret: conn!.auth_secret, timeout: conn!.tool_timeout_s ?? 300 };
    const untrusted = conn?.returns !== "trusted";
    const source = (t?: string) => `${connection}.${t ?? ""}`;
    if (req.method !== "POST" && req.method !== "DELETE") { res.writeHead(405, { allow: "POST, DELETE" }).end(); return; }
    const raw = await readAll(req, MAX_BODY);
    const { listed, allowed } = toolsFor(who, connection, conn);
    let method = req.method, tool: string | undefined, body = Buffer.alloc(0), reqId: unknown = null;
    // ms: the kernel's own time before the call goes on (identity, checks, signing); total: with the module's answer.
    let forwarded: number | undefined;
    const outcome = (o: string) => log("proxy", { connection, ...(tool ? { tool } : {}), method, agent: who.key || who.module || null, ms: (forwarded ?? Date.now()) - t0, total: Date.now() - t0, outcome: o });
    if (req.method === "POST") {
      let msg: { method?: unknown; id?: unknown; params?: Record<string, unknown> };
      try { msg = JSON.parse(raw.toString("utf8")); } catch { throw fail(400, "bad_request", "the body must be one JSON-RPC message"); }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw fail(400, "bad_request", "the body must be one JSON-RPC message (no batches)");
      method = typeof msg.method === "string" ? msg.method : "";
      const id = msg.id ?? null;
      reqId = id;
      const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : undefined;
      const refuse = (code: number, message: string) => {
        outcome(message);
        if (!("id" in msg)) { res.writeHead(403, { "content-type": "text/plain" }).end(message); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
      };
      if (!FORWARDED.has(method)) return refuse(-32601, "method-refused");
      let fwd: Record<string, unknown> | undefined = params;
      if (method === "tools/call") {
        tool = typeof params?.name === "string" ? params.name : "";
        if (!listed.has(tool)) return refuse(-32602, "tool-unlisted");
        if (!allowed.has(tool)) return refuse(-32602, "no-grant");
        fwd = { name: tool, ...(params?.arguments !== undefined ? { arguments: params.arguments } : {}), ...(params?._meta !== undefined ? { _meta: params._meta } : {}) };
      } else if (method === "tools/list") fwd = typeof params?.cursor === "string" ? { cursor: params.cursor } : undefined;
      body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...("id" in msg ? { id } : {}), method, ...(fwd ? { params: fwd } : {}) }));
    }
    const headers: Record<string, string> = { "content-length": String(body.length) };
    for (const h of PASS) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
    const key = secret(target.secret);
    if (!key) throw fail(503, "no_service_key", `${connection}'s ${cap ? "read" : "service"} key is missing`);
    headers.authorization = `Bearer ${key}`;
    let jti: string | undefined;
    if (tool && !cap) {
      const signed = asserter.signCaller({ agent: who.agent ?? "", key: who.key ?? "", name: who.name ?? "", roles: who.roles, ...(who.task ? { task: who.task } : {}), ...(who.run ? { run: who.run } : {}), tool: `${connection}.${tool}`, aud: conn!.module, kind: who.kind });
      jti = signed.jti;
      headers["x-aidenhq-caller"] = signed.jwt;
      asserter.begin(jti, { credential: who.credential, aud: conn!.module, kind: who.kind, ...(who.run ? { run: who.run } : {}) }, target.timeout + 30);
    }
    const to = await resolver.resolve(target.url).catch((e: Error) => { throw fail(502, "bad_upstream", e.message); });
    headers.host = new URL(target.url).host;
    const timeoutMs = (target.timeout + 30) * 1000;
    try {
      forwarded = Date.now();
      await new Promise<void>((resolve, reject) => {
        const out = http.request({ host: to.host, port: to.port, path: to.path, method: req.method, headers, timeout: timeoutMs }, async (ur) => {
          try {
            const status = ur.statusCode ?? 502;
            const hdrs = Object.fromEntries(Object.entries(ur.headers).filter(([k]) => !HOP.has(k)));
            const fenced = method === "tools/call" && untrusted;
            if (fenced && status >= 300) {
              // An untrusted connection's failure: its body reaches the agent only fenced, as a JSON-RPC error.
              const text = (await readAll(ur, MAX_ANSWER).catch(() => Buffer.alloc(0))).toString("utf8").slice(0, 4000);
              const err = JSON.stringify({ jsonrpc: "2.0", id: reqId, error: { code: -32603, message: fence(`${connection} answered ${status}: ${text}`, source(tool)) } });
              res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(err) }).end(err);
              return resolve();
            }
            const rewrite = status < 300 && (method === "tools/list" || fenced);
            if (!rewrite) {
              res.writeHead(status, { ...hdrs, ...(ur.headers["content-length"] ? { "content-length": ur.headers["content-length"] } : {}) });
              ur.pipe(res);
              ur.on("end", resolve);
              ur.on("error", reject);
              return;
            }
            const sse = String(ur.headers["content-type"] ?? "").includes("text/event-stream");
            const text = (await readAll(ur, MAX_ANSWER)).toString("utf8");
            let answer: string;
            try {
              answer = mapMessages(text, sse, (m) => {
              if (method === "tools/list" && Array.isArray(m.result?.tools)) m.result.tools = m.result.tools.filter((t: { name?: unknown }) => allowed.has(String(t?.name)));
              if (!fenced) return true;
              if (m.id !== reqId || "method" in m) return false; // notifications and server requests: only the answer passes
              fenceAnswer(m, source(tool));
            });
            } catch (e) {
              // Fail closed: an answer the kernel can't read strictly reaches the caller as an error naming no upstream text.
              const err = JSON.stringify({ jsonrpc: "2.0", id: reqId, error: { code: -32603, message: `${connection}: ${(e as Error).message}` } });
              res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(err) }).end(err);
              return resolve();
            }
            res.writeHead(status, { ...hdrs, "content-length": Buffer.byteLength(answer) }).end(answer);
            resolve();
          } catch (e) { reject(e); }
        });
        out.on("timeout", () => out.destroy(fail(504, "timeout", `${connection} didn't answer in time`)));
        out.on("error", (e) => { resolver.forget(target.url); reject((e as { status?: number }).status ? e : fail(502, "bad_upstream", `${connection} is unreachable (${e.message})`)); });
        out.end(body);
      });
      outcome("ok");
    } catch (e) {
      outcome(String((e as { type?: string }).type ?? "error"));
      throw e;
    } finally {
      if (jti) asserter.end(jti);
    }
  };
}

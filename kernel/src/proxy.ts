// POST /c/<connection>/mcp: every agent tool call (spec §3.2). Resolve the caller from its own bearer (whoami), refuse a
// tool the connection's manifest doesn't list (tool-unlisted) or the caller isn't granted (no-grant), then forward a
// message rebuilt from the checked fields only, with the module's service key and, on a tools/call, a signed caller
// assertion that is in flight until the module's answer ends. tools/list comes back filtered to the granted, listed tools;
// a result from a connection that returns untrusted text comes back fenced. The caller's own credential never leaves here.
// Every tools/call answer is read before it goes back: a module's needs_owner answer (sdk/src/vendor/needs.ts) goes to the
// connection state (connection-state.ts), which routes it, and the agent gets the kernel's own words instead; a trusted
// connection's other answers go back byte for byte.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fence } from "../sdk/src/fence.ts";
import { readNeed, servedSignedIn, SIGNED_IN, type Need } from "../sdk/src/vendor/needs.ts";
import type { ConnectionState } from "./connection-state.ts";
import type { Asserter } from "./assert.ts";
import { laneCaller, NoGrants, type Connection, type Grant, type Identity, type Whoami } from "./identity.ts";
import type { Resolver } from "./net.ts";
import type { Rec, Requester } from "./records.ts";
import { CONN_TOOL, type Writes } from "./writes.ts";

type Log = (msg: string, fields?: Record<string, unknown>) => void;
// A 10 MB task file as base64 (~13.4 MB), inside its tools/call JSON (tasks-mcp task_file_upload).
const MAX_BODY = 14 * 1024 * 1024 + 64 * 1024;
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
 * The tools a caller may use on a connection, and the tools it lists: its granted tools the manifest lists. A tool the
 * connection tags `named` is a read the `read` shorthand never reaches: it is listed only to a caller whose grant (a jobcap's
 * tool list included) names it, so to everyone else the manifest does not hold it.
 */
export function toolsFor(who: Identity, connection: string, conn: Connection | undefined): { listed: Set<string>; allowed: Set<string> } {
  const granted = new Set(who.tools[connection] ?? []);
  const named = new Set(conn?.tools.named ?? []);
  const tagged = conn ? [...conn.tools.read, ...conn.tools.write, ...conn.tools.destructive].filter((t) => !named.has(t) || granted.has(t)) : [];
  const listed = new Set(tagged);
  return { listed, allowed: new Set([...granted].filter((t) => listed.has(t))) };
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

/** What a write tool call answers when its record isn't done at once: the record, and who decides it. */
export function pendingText(r: Rec): string {
  return `${JSON.stringify({ approval: r.id, tier: r.tier, state: r.state })}\nFiled for approval (${r.kind}): ${r.tier === 1 ? "the AI reviewer decides" : "the AI reviewer, then the owner, decide"}. It runs once approved, and the outcome lands on your task. Don't say it is done until then.`;
}

/** The account a served answer named (SIGNED_IN), if it named one. */
const servedAccount = (r: unknown) => {
  const v = (r as { _meta?: Record<string, unknown> } | null)?._meta?.[SIGNED_IN];
  return typeof v === "string" && v ? v : undefined;
};

export function createProxy({ whoami, grants = () => ({}), connections, asserter, resolver, secret, writes, needs = () => undefined, log = () => {} }: {
  whoami: Whoami; connections: () => Record<string, Connection>; asserter: Asserter; resolver: Resolver; secret: (name: string) => string; writes?: Writes;
  /** The grants table's agents: whom the fast chat lane may speak for (identity.ts laneCaller). */
  grants?: () => Record<string, Grant>;
  /** The connection state (late-bound: main.ts builds it after the proxy): needs_owner answers, and a success that clears one. */
  needs?: () => Pick<ConnectionState, "hit" | "ok" | "down"> | undefined;
  log?: Log;
}) {
  /**
   * One tools/call sent once to a connection's module as `q` (no session): an approved conn.tool record's stored call, or the
   * host's health probe. A requester that is an agent's run acts at /v1/cp/agent/* as that agent, with its own key and the run it
   * asked from, while this one call is in flight, as its live call did; any other requester has no control-plane identity.
   */
  async function callAs(q: Requester, connection: string, tool: string, args: unknown, task?: string): Promise<{ ok: boolean; text: string; objects?: unknown }> {
    const conn = connections()[connection];
    if (!conn) throw new Error(`no connection ${connection}`);
    const signed = asserter.signCaller({ agent: q.agent, key: q.key, name: q.name, roles: q.roles, ...(task ? { task } : {}), tool: `${connection}.${tool}`, aud: conn.module, kind: q.kind });
    // The module acts at /v1/cp/agent as the requester (cp.ts: a kernel job's agent on its task, with the kernel-held agent key).
    asserter.begin(signed.jti, { credential: "", aud: conn.module, kind: q.kind }, conn.tool_timeout_s ?? 300);
    try {
      const to = await resolver.resolve(conn.url);
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }));
      const { status, sse, text } = await new Promise<{ status: number; sse: boolean; text: string }>((resolve, reject) => {
        const out = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: ((conn.tool_timeout_s ?? 300) + 30) * 1000, headers: { host: new URL(conn.url).host, authorization: `Bearer ${secret(conn.auth_secret)}`, "x-aidenhq-caller": signed.jwt, accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": body.length } }, async (ur) => {
          try { resolve({ status: ur.statusCode ?? 502, sse: String(ur.headers["content-type"] ?? "").includes("text/event-stream"), text: (await readAll(ur, MAX_ANSWER)).toString("utf8") }); } catch (e) { reject(e); }
        });
        out.on("timeout", () => out.destroy(new Error(`${connection} didn't answer in time`)));
        out.on("error", reject);
        out.end(body);
      });
      if (status >= 300) return { ok: false, text: `${connection} answered ${status}: ${text.slice(0, 2000)}` };
      let ok = true, objects: unknown, need: Need | undefined, success = false, account: string | undefined;
      const answer = mapMessages(text, sse, (m) => {
        if (m.error || m.result?.isError) ok = false;
        objects ??= m.result?.structuredContent?._aidenhq?.objects;
        if (m.id === 1 && !("method" in m)) { need = readNeed(m.result); success = !need && !m.error && servedSignedIn(m.result); account = success ? servedAccount(m.result) : undefined; }
      });
      // The health probe's and a replayed record's call reach the connection state like a live call: a need is recorded, a signed-in success clears it.
      const state = needs();
      try {
        if (state && need) await state.hit({ kind: "module", module: conn.module, roles: [], tools: {}, credential: "" }, connection, need);
        else if (state && success && state.down(connection, account)) state.ok(connection, { account, fullOnly: true });
      } catch (e) { log("connection state not updated", { connection, err: (e as Error).message }); }
      return { ok, text: answer, ...(objects !== undefined ? { objects } : {}) };
    } finally {
      asserter.end(signed.jti);
    }
  }
  const replay = (r: Rec) => {
    const a = r.args as { connection: string; tool: string; arguments: unknown };
    // The job's own task (the requester's), never the record's: a card filed on another task must not act as that task.
    return callAs(r.requester, a.connection, a.tool, a.arguments, r.requester.task);
  };

  const proxy = async function proxy(req: IncomingMessage, res: ServerResponse, connection: string): Promise<void> {
    const t0 = Date.now();
    const conn = Object.hasOwn(connections(), connection) ? connections()[connection] : undefined;
    if (!conn) throw fail(404, "not_found", `no connection ${connection}`);
    let who: Identity;
    const callerToken = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    try {
      who = await whoami(callerToken);
      const lane = req.headers["x-aidenhq-lane-agent"];
      if (lane !== undefined) who = laneCaller(who, String(lane), grants());
    } catch (e) {
      log("proxy", { connection, outcome: (e as { code?: string }).code ?? "denied_unknown_caller", ms: Date.now() - t0 });
      throw fail(e instanceof NoGrants ? 403 : 401, "unauthorized", (e as Error).message);
    }
    const timeout = conn.tool_timeout_s ?? 300;
    const untrusted = conn.returns !== "trusted";
    const source = (t?: string) => `${connection}.${t ?? ""}`;
    if (req.method !== "POST" && req.method !== "DELETE") { res.writeHead(405, { allow: "POST, DELETE" }).end(); return; }
    const raw = await readAll(req, MAX_BODY);
    const { listed, allowed } = toolsFor(who, connection, conn);
    let method = req.method, tool: string | undefined, body = Buffer.alloc(0), reqId: unknown = null, rec: Rec | undefined;
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
        // Step 4: every write is a record. A tool mapped to a kind goes to its executor's lifecycle (Tier 0 answered inline
        // with the outcome); any other write or destructive tool is conn.tool, forwarded below at Tier 0.
        const routed = writes ? writes.kindOf(connection, tool) : undefined;
        if (routed) {
          const reply = (text: string, isError = false) => {
            outcome(isError ? "write-refused" : "ok");
            if (!("id" in msg)) return void res.writeHead(isError ? 422 : 202).end();
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } }));
          };
          const own = (text: string) => (untrusted ? fence(text, source(tool)) : text);
          try {
            if (routed !== CONN_TOOL) {
              let r = await writes!.request(who, { kind: routed, args: params?.arguments ?? {} });
              if (r.state === "claimed") r = await writes!.wait(r.id, timeout * 1000);
              if (r.tier === 0) return reply(r.outcome ? own(r.outcome.text) : `${pendingText(r)}\n(still running past the tool timeout)`, r.outcome ? !r.outcome.ok : false);
              return reply(pendingText(r));
            }
            // The task the call says it is for, if any (MCP `_meta.task`): writes.ts binds the record to it only when this job
            // may write there anyway, and refuses it otherwise. Absent, the record is on the job's own task, as before. A
            // `task` that is not a task id is refused, never ignored: the caller meant its record to say something else.
            const named = params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? (params._meta as { task?: unknown }).task : undefined;
            if (named !== undefined && !(typeof named === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(named))) return refuse(-32602, "_meta.task must be a task id");
            rec = await writes!.fileTool(who, connection, tool, params?.arguments ?? {}, who.task ?? "", named as string | undefined);
            // A carded record (a repeat of an earlier call) is never forwarded here: the kernel replays it once, approved.
            if (rec.outcome) return reply(own(rec.outcome.text), !rec.outcome.ok);
            if (rec.state !== "claimed" || rec.tier > 0) return reply(pendingText(rec));
          } catch (e) {
            const err = e as Error & { status?: number };
            if (!err.status || err.status >= 500) throw e;
            return reply(own(err.message), true);
          }
        }
        fwd = { name: tool, ...(params?.arguments !== undefined ? { arguments: params.arguments } : {}), ...(params?._meta !== undefined ? { _meta: params._meta } : {}) };
      } else if (method === "tools/list") fwd = typeof params?.cursor === "string" ? { cursor: params.cursor } : undefined;
      body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...("id" in msg ? { id } : {}), method, ...(fwd ? { params: fwd } : {}) }));
    }
    // A conn.tool record's outcome: the module's answer as it came (capped), once.
    let okAnswer = false;
    let objects: unknown;
    const done = (ok: boolean, text: string) => { if (rec) writes!.outcome(rec.id, ok, text.slice(0, 4000), objects); rec = undefined; };
    const headers: Record<string, string> = { "content-length": String(body.length) };
    for (const h of PASS) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
    const key = secret(conn.auth_secret);
    if (!key) { done(false, "the service key is missing"); throw fail(503, "no_service_key", `${connection}'s service key is missing`); }
    headers.authorization = `Bearer ${key}`;
    const to = await resolver.resolve(conn.url).catch((e: Error) => { done(false, e.message); throw fail(502, "bad_upstream", e.message); });
    let jti: string | undefined;
    if (tool) {
      const signed = asserter.signCaller({ agent: who.agent ?? "", key: who.key ?? "", name: who.name ?? "", roles: who.roles, ...(who.task ? { task: who.task } : {}), ...(who.run ? { run: who.run } : {}), tool: `${connection}.${tool}`, aud: conn.module, kind: who.kind });
      jti = signed.jti;
      headers["x-aidenhq-caller"] = signed.jwt;
      asserter.begin(jti, { credential: who.credential, ...(who.job ? { bearer: callerToken, job: who.job } : {}), aud: conn.module, kind: who.kind, ...(who.run ? { run: who.run } : {}) }, timeout + 30);
    }
    headers.host = new URL(conn.url).host;
    const timeoutMs = (timeout + 30) * 1000;
    try {
      forwarded = Date.now();
      await new Promise<void>((resolve, reject) => {
        const out = http.request({ host: to.host, port: to.port, path: to.path, method: req.method, headers, timeout: timeoutMs }, async (ur) => {
          try {
            const status = ur.statusCode ?? 502;
            const hdrs = Object.fromEntries(Object.entries(ur.headers).filter(([k]) => !HOP.has(k)));
            const fenced = method === "tools/call" && untrusted;
            if (rec && status >= 300) done(false, `${connection} answered ${status}`);
            if (fenced && status >= 300) {
              // An untrusted connection's failure: its body reaches the agent only fenced, as a JSON-RPC error.
              const text = (await readAll(ur, MAX_ANSWER).catch(() => Buffer.alloc(0))).toString("utf8").slice(0, 4000);
              const err = JSON.stringify({ jsonrpc: "2.0", id: reqId, error: { code: -32603, message: fence(`${connection} answered ${status}: ${text}`, source(tool)) } });
              res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(err) }).end(err);
              return resolve();
            }
            const call = method === "tools/call";
            const rewrite = status < 300 && (method === "tools/list" || call || !!rec);
            if (!rewrite) {
              res.writeHead(status, { ...hdrs, ...(ur.headers["content-length"] ? { "content-length": ur.headers["content-length"] } : {}) });
              ur.pipe(res);
              ur.on("end", resolve);
              ur.on("error", reject);
              return;
            }
            const sse = String(ur.headers["content-type"] ?? "").includes("text/event-stream");
            const raw = await readAll(ur, MAX_ANSWER);
            const text = raw.toString("utf8");
            // A trusted connection's answer (no record) is only read here: it goes back as it came unless it is a need.
            const asIs = call && !fenced && !rec;
            let need: Need | undefined, success = false, account: string | undefined;
            let answer: string | undefined;
            try {
              answer = mapMessages(text, sse, (m) => {
              // Read before fencing strips structuredContent: the module's own answer, never upstream text inside it.
              if (call && m.id === reqId && !("method" in m)) { need = readNeed(m.result); success = !need && !m.error && servedSignedIn(m.result); account = success ? servedAccount(m.result) : undefined; }
              if (method === "tools/list" && Array.isArray(m.result?.tools)) m.result.tools = m.result.tools.filter((t: { name?: unknown }) => allowed.has(String(t?.name)));
              if (rec && m.id === reqId && !("method" in m)) { okAnswer = !m.error && m.result?.isError !== true; objects = m.result?.structuredContent?._aidenhq?.objects; }
              if (!fenced) return true;
              if (m.id !== reqId || "method" in m) return false; // notifications and server requests: only the answer passes
              fenceAnswer(m, source(tool));
            });
            } catch (e) {
              // A trusted answer was never parsed before: one the kernel can't read still goes back as it came.
              if (asIs) {
                res.writeHead(status, { ...hdrs, "content-length": String(raw.length) }).end(raw);
                return resolve();
              }
              // Fail closed: an answer the kernel can't read strictly reaches the caller as an error naming no upstream text.
              done(false, `${connection}'s answer isn't well-formed JSON-RPC`);
              const err = JSON.stringify({ jsonrpc: "2.0", id: reqId, error: { code: -32603, message: `${connection}: ${(e as Error).message}` } });
              res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(err) }).end(err);
              return resolve();
            }
            const state = call ? needs() : undefined;
            if (need && state) {
              // Only the owner can fix it: the connection state routes it, and the agent reads the kernel's words, unfenced.
              const said = await state.hit(who, connection, need).catch((e: Error) => { log("connection need not routed", { connection, err: e.message }); return `${connection} isn't connected: only the owner can fix it. Don't retry.`; });
              done(false, said);
              const out = JSON.stringify({ jsonrpc: "2.0", id: reqId, result: { content: [{ type: "text", text: said }], isError: true } });
              res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(out) }).end(out);
              return resolve();
            }
            if (rec) done(okAnswer, text);
            // A call the connection's sign-in served (its answer says so: needs.ts SIGNED_IN) proves the module connected: a full
            // need it had clears, and the tasks waiting on it wake. A tool that works signed out proves nothing.
            try { if (success && state?.down(connection, account)) state.ok(connection, { account, fullOnly: true }); } catch (e) { log("connection state not cleared", { connection, err: (e as Error).message }); }
            if (asIs) res.writeHead(status, { ...hdrs, "content-length": String(raw.length) }).end(raw);
            else res.writeHead(status, { ...hdrs, "content-length": Buffer.byteLength(answer!) }).end(answer);
            resolve();
          } catch (e) { reject(e); }
        });
        out.on("timeout", () => out.destroy(fail(504, "timeout", `${connection} didn't answer in time`)));
        out.on("error", (e) => { resolver.forget(conn.url); reject((e as { status?: number }).status ? e : fail(502, "bad_upstream", `${connection} is unreachable (${e.message})`)); });
        out.end(body);
      });
      outcome("ok");
    } catch (e) {
      done(false, (e as Error).message);
      outcome(String((e as { type?: string }).type ?? "error"));
      throw e;
    } finally {
      if (jti) asserter.end(jti);
    }
  };
  return Object.assign(proxy, { replay, callAs });
}

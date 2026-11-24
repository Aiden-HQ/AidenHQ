// A vendor's MCP server, passed through whole (owner, 2026-11-18: "every connection exposes the full upstream MCP"). Every
// upstream tool is listed and callable here; which ones an agent reaches is the kernel's: it lists and forwards only the
// tools the module's manifest tags (read, write, destructive, named) and the caller's grant names, files every write as a
// record its tier decides, and refuses everything else (tool-unlisted, no-grant). So a tool the vendor adds reaches nobody
// until a module change tags it. What stays here is what the kernel can't do:
//   /mcp       the kernel's calls for agents (its service key), each tools/call carrying its signed caller assertion;
//   /mcp/read  the kernel's calls for runner jobs (the read key): only tools the module's manifest tags read (`reads`, the
//              READ_TOOLS its module.yaml sets from those tags) that the upstream also marks read-only (or the connection's
//              read rule says are reads), so the jobs' token never reaches a write;
//   /auth/*    the board's sign-in (state, the scopes the owner may pick, start, finish, or a device code), with the board's own key,
//              and /auth/check: one live read upstream (a tools list), answering { ok: true } or { ok: false, message, fix? };
//   /healthz   whether it is connected.
// A connection adds only its real logic as hooks (a pinned argument, a site id, a deny rule) and its own routes (a write
// kind's executor). Not signed in: it still starts, lists the tools it saw last as stand-ins, and every call says how to
// connect (never a crash loop, never a silently empty tool list): a needs_owner answer (needs.ts), which the kernel routes to
// the owner or the digest.
//
// First-party modules hold byte-identical copies (scripts/sync-shared.ts: edit this one and run it); third-party modules import
// @aidenhq/sdk/vendor/proxy (the MCP SDK, zod and pino are theirs: peer dependencies).
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { z } from "zod";
import { needsOwner, signedIn } from "./needs.js";
import { AuthError, SignInError, type Auth } from "./oauth.js";

/** A connection's own logic, where it has any. */
export interface Hooks {
  /** After each connect (Jira: find the configured site); a throw fails the connect. */
  connected?(client: Client, tools: Tool[]): Promise<void>;
  /** The tools as agents see them (a pinned argument dropped from the schema, a lead line in a description). */
  tools?(tools: Tool[]): Tool[];
  /**
   * The arguments sent upstream for one call of a tool the upstream lists (`tool`: its schema); a throw refuses the call.
   * A pinned argument overrides whatever the caller sent.
   */
  args?(name: string, args: Record<string, unknown>, tool: Tool): Record<string, unknown>;
  /** Tools never listed or called (a real security rule; most connections have none). */
  deny?: RegExp;
  /** A tool's answer as it goes back (ClickHouse: cut to a size; Primer: the digest fenced as untrusted). */
  result?(result: CallToolResult, name: string): CallToolResult;
  /** Whether the upstream says a tool only reads. Default: it marks it readOnlyHint. */
  isRead?(tool: Tool): boolean;
  /** A problem that makes the connection unusable though signed in (Jira: the site isn't reachable). */
  health?(): string | undefined;
  /** More of the sign-in's state for the board (GitHub: scopes, per-org problems, the rate limit), merged into /auth/status. */
  status?(): Record<string, unknown>;
}

export interface ProxyOptions {
  /** The vendor's name in messages ("Glean"). */
  name: string;
  /** Unset: not configured yet (Connect on the board, or its setup flow, saves the value it needs). */
  upstream: URL | undefined;
  auth: Auth;
  log: Logger;
  /** The kernel's bearer for /mcp (the connection's service key). */
  serviceKey?: string;
  /** The read endpoint's bearer (jobs reach it only through the kernel); unset: no /mcp/read. */
  readKey?: string;
  /** The tools the module's manifest tags read: /mcp/read serves only these (and only those the upstream marks read-only). */
  reads?: string[];
  /** The board's bearer for /auth/*. */
  authKey?: string;
  /** Checks the kernel's caller assertion on a tools/call to /mcp; throws to refuse. */
  caller(req: IncomingMessage): Promise<unknown>;
  /** The MCP server's instructions to agents. */
  instructions: string;
  /** How long one tool call may take (ClickHouse's queries run up to two minutes); default: the MCP SDK's 60 seconds. */
  callTimeoutMs?: number;
  /** Remembers the tool list here (tools.json), for stand-ins while not connected. */
  stateDir?: string;
  hooks?: Hooks;
  /** More routes on the same port (a write kind's executor); true when it answered. */
  routes?(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export type VendorProxy = HttpServer & {
  /** One tool call from this service's own code (a warehouse sync, an executor), through the same sign-in and hooks. */
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
};

// The upstream refused the token: refresh once and retry. A refresh that failed (AuthError) already marked what it meant
// (refused: expired; the vendor's 5xx: not), so it is never retried here.
// HubSpot answers an expired token with a bare 401 (no text), so the transport error's status counts too.
const isAuthFailure = (err: unknown) => !(err instanceof AuthError) && ((err as { code?: unknown })?.code === 401 || /401|unauthori[sz]ed|unauthenticated|invalid_token|not_authenticated/i.test(String(err)));
const refusal = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
// Reads run unattended in Codex as read-only, closed-world tools. Every other tool is a write the kernel files as a record and
// its tier decides before anything runs; these hints only keep the harness from stopping to ask a person who isn't there.
const READ_HINTS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE_HINTS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function createVendorProxy(o: ProxyOptions): VendorProxy {
  const { log, auth, hooks = {} } = o;
  const isRead = hooks.isRead ?? ((t: Tool) => t.annotations?.readOnlyHint === true);
  const reads = new Set(o.reads ?? []);
  // The read endpoint's rule: tagged read in the manifest, and a read by the upstream's word too. Either alone isn't enough.
  const servesRead = (t: Tool) => reads.has(t.name) && isRead(t);
  const denied = (name: string) => Boolean(hooks.deny?.test(name));
  const cacheFile = o.stateDir ? join(o.stateDir, "tools.json") : undefined;
  // One session is shared by every concurrent call, so a session replaced after an auth failure is retired, not closed: a call
  // already running on it (another agent's tool call) would fail with a connection-closed error. It closes when its last call ends.
  type Upstream = { client: Client; tools: Tool[]; at: number; active: number; retired: boolean };
  let upstream: Upstream | undefined;
  // A reset (a new sign-in, the periodic reconnect) invalidates every connect already in flight: such a connect is stale and must
  // not become the cached session, or calls would run under the account the owner just replaced.
  let generation = 0;
  // Concurrent calls share one connect rather than each opening a session; connects run one at a time so a stale connect's
  // connected hook (Jira: the site's cloudId) can't land after the newer session's and overwrite it.
  let pending: { gen: number; p: Promise<Upstream> } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let resetting: { refresh: boolean; p: Promise<void> } | undefined;
  // A new sign-in (a different account or grant), not a refresh of the same one. A call that started under the previous sign-in is
  // never replayed on the new one: its arguments and its results belong to the owner who sent it, not the account that replaced it.
  let signIn = 0;

  const notConnected = () => (!o.upstream ? `${o.name} isn't connected yet: the owner presses Connect on the board (Settings, Connections).` : auth.status().state === "expired" ? `${o.name}'s sign-in stopped working: the owner reconnects it on the board.` : `${o.name} isn't connected: the owner signs in from the board.`);

  /** The connect started before a reset, whose session belongs to the account or token that reset replaced. */
  class StaleConnect extends Error {}

  async function open(gen: number): Promise<Upstream> {
    if (!o.upstream) throw new AuthError(notConnected());
    const client = new Client({ name: `aidenhq-${o.name.toLowerCase()}-proxy`, version: "0.2.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(o.upstream, { requestInit: { headers: await auth.headers() } }));
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      await hooks.connected?.(client, tools);
      // A reset ran while this connect did (the owner signed in again, or the session was replaced): its session is the one to
      // keep, so this one closes and the caller retries on that one.
      if (gen !== generation) throw new StaleConnect();
      // The session this one replaces (a racing reconnect's) is retired, never left open.
      if (upstream) retire(upstream);
      upstream = { client, tools, at: Date.now(), active: 0, retired: false };
    } catch (err) {
      // Whatever stopped this connect (a refused handshake, a failing tools list, a hook, or a reset), its client never becomes
      // the cached session: close it here, or its event stream stays open with nothing able to reach it.
      void client.close().catch(() => undefined);
      // A connect a newer sign-in or reset superseded says nothing about the account saved now: its failure is stale, so the
      // caller takes the current session instead of refreshing (or marking expired) against the grant that replaced it.
      if (gen !== generation) throw new StaleConnect();
      throw err;
    }
    auth.mark("ok");
    const names = upstream.tools.map((t) => t.name).filter((n) => !denied(n));
    // The kernel lists only what the module tags; a name here it doesn't tag reaches nobody until a module change does.
    log.info({ upstream_tools: upstream.tools.length, tools: names }, `connected to ${o.name}`);
    if (cacheFile) try { writeFileSync(cacheFile, JSON.stringify(names)); } catch { /* read-only state: no stand-ins */ }
    return upstream;
  }

  function connect(fresh = false): Promise<Upstream> {
    // A connect already running for this generation is the one to wait on: starting a second would have the two replace each
    // other, and every caller waiting on them would lose its session in turn. A sign-in (`fresh`) skips the queue instead: the
    // connect ahead of it may be stalled on the account it just replaced, and the board waits only 20 seconds for the sign-in.
    if (pending && pending.gen === generation) return pending.p;
    const gen = generation;
    const entry = { gen, p: (fresh ? open(gen) : queue.then(() => open(gen))) };
    queue = entry.p.catch(() => undefined);
    pending = entry;
    const done = () => { if (pending === entry) pending = undefined; };
    void entry.p.then(done, done);
    return entry.p;
  }

  /** A replaced session closes once its in-flight calls end; until then they keep answering on it. */
  function retire(old: Upstream): void {
    old.retired = true;
    if (old.active === 0) void old.client.close().catch(() => undefined);
  }

  /**
   * Replaces the session. Concurrent callers share one reset rather than each invalidating the other's connect, but only when the
   * pending one already does everything they need: a refresh never joins a session-only reset (it would swallow the grant), and a
   * new sign-in (`force`) never joins at all, since a connect started before it belongs to the account it replaced.
   */
  function reset(refresh: boolean, force = false): Promise<void> {
    if (!force && resetting && (resetting.refresh || !refresh)) return resetting.p;
    const entry: { refresh: boolean; p: Promise<void> } = { refresh, p: Promise.resolve() };
    if (force) signIn += 1;
    entry.p = (async () => {
      const old = upstream;
      generation += 1;
      upstream = undefined;
      if (old) retire(old);
      if (refresh) await auth.refresh();
      // A newer reset took over while this one ran: it owns the session now, so there is nothing left to connect here.
      await connect(force).catch((err) => {
        // A sign-in that still could not connect is a real failure for the board; a stale one is the newer reset's business.
        if (!(err instanceof StaleConnect)) throw err;
      });
    })().finally(() => { if (resetting === entry) resetting = undefined; });
    resetting = entry;
    return entry.p;
  }

  /** The current session, or a fresh one; a connect a reset invalidated is retried on the session that reset opened. */
  async function acquire(): Promise<Upstream> {
    // A reset in flight is replacing the token (a refresh) or the account (a sign-in): a handshake started now would go out with
    // the old one and come back 401 after the refresh succeeded, so wait for it and use the session it opened.
    if (resetting) await resetting.p.catch(() => undefined);
    if (upstream) return upstream;
    try {
      return await connect();
    } catch (err) {
      if (!(err instanceof StaleConnect)) throw err;
      return upstream ?? (await connect());
    }
  }

  /** Runs one call on a session, counted so a retired session isn't closed under it. */
  async function on<T>(u: Upstream, fn: (u: Upstream) => Promise<T>): Promise<T> {
    u.active += 1;
    try {
      return await fn(u);
    } finally {
      u.active -= 1;
      if (u.retired && u.active === 0) void u.client.close().catch(() => undefined);
    }
  }

  /** One attempt on the current session; a 401 from a session another call already replaced is retried on the current one. */
  async function run<T>(fn: (u: Upstream) => Promise<T>): Promise<T> {
    const under = signIn;
    const u = await acquire();
    try {
      return await on(u, fn);
    } catch (err) {
      if (!auth.signedIn() || !isAuthFailure(err) || u === upstream) throw err;
      // A different account signed in while this call ran: its arguments and results belong to the owner who sent it, so it fails
      // here rather than being replayed (and answered, private data included) under the account that replaced the sign-in.
      if (signIn !== under) throw err;
      // The session that failed is no longer the current one (another call replaced it, or the token was refreshed): its 401
      // belongs to the token it was opened with, so retry on the current session and decide nothing about this one.
      return await on(await acquire(), fn);
    }
  }

  async function withUpstream<T>(fn: (u: Upstream) => Promise<T>): Promise<T> {
    const under = signIn;
    // Reconnect every 30 minutes or after an auth failure (inside the try: a token revoked early fails connect() too).
    try {
      if (!upstream || Date.now() - upstream.at > 30 * 60_000) await reset(false);
      return await run(fn);
    } catch (err) {
      if (!auth.signedIn() || !isAuthFailure(err)) throw err;
      // A different account signed in while this call ran: never refresh or replay it under the new sign-in (see `run`).
      if (signIn !== under) throw err;
      // The vendor's REST side still answers this token: its MCP endpoint's 401 is that endpoint's own error, not a sign-in to refresh or reconnect.
      // A new session with the current token (the cached one's headers are fixed at connect time); no refresh grant is used.
      if (auth.refused && !(await auth.refused())) {
        await reset(false);
        return await run(fn);
      }
      log.warn(`${o.name} rejected the token; refreshing and retrying once`);
      try {
        await reset(true);
      } catch (err) {
        // The refresh produced a grant the vendor's MCP endpoint still refuses (the handshake 401s): that is a refused sign-in, not
        // a transient error. A sign-in that replaced this one meanwhile owns the decision, so only the current sign-in is marked.
        if (signIn === under && (isAuthFailure(err) || err instanceof AuthError) && (await auth.refused?.() ?? true)) auth.mark("expired", `${o.name} rejected a freshly refreshed token`);
        throw err;
      }
      const r = await acquire();
      try {
        return await on(r, fn);
      } catch (again) {
        // A late 401 from a session another call replaced while this retry ran decides nothing about the sign-in saved now.
        if (r === upstream && isAuthFailure(again) && (await auth.refused?.() ?? true)) auth.mark("expired", `${o.name} rejected a freshly refreshed token`);
        throw again;
      }
    }
  }

  /** The tools as listed: deny applied, the connection's view, and the harness hints. */
  function shown(tools: Tool[], readOnly: boolean): Tool[] {
    const kept = tools.filter((t) => !denied(t.name) && (!readOnly || servesRead(t)));
    return (hooks.tools ? hooks.tools(kept) : kept).map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), ...(isRead(t) ? READ_HINTS : WRITE_HINTS) } }));
  }

  /** The names seen last, each answering how to connect: agents keep their tools while the sign-in is fixed. */
  function standIns(): Tool[] {
    const names = cacheFile && existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, "utf8")) as string[]) : [];
    return names.map((name) => ({ name, description: notConnected(), inputSchema: { type: "object" as const } }));
  }

  async function call(name: string, args: Record<string, unknown>, readOnly = false): Promise<CallToolResult> {
    if (denied(name)) throw new Error(`${name} is not available through AidenHQ`);
    return withUpstream(async (u) => {
      const tool = u.tools.find((t) => t.name === name);
      // Only what the upstream lists: its schema is what the hooks pin arguments against.
      if (!tool) throw new Error(`${o.name} doesn't offer ${name}`);
      // Checked on the session that dispatches this attempt: a retry after a reconnect must not reach a tool the new session
      // no longer marks read-only.
      if (readOnly && !servesRead(tool)) {
        log.warn({ tool: name }, "refused a write on the read endpoint");
        return refusal(`Tool ${name} is not a read: the read endpoint serves reads only.`);
      }
      const sent = hooks.args ? hooks.args(name, args, tool) : args;
      const result = (await u.client.callTool({ name, arguments: sent }, undefined, o.callTimeoutMs ? { timeout: o.callTimeoutMs } : undefined)) as CallToolResult;
      return hooks.result ? hooks.result(result, name) : result;
    });
  }

  function buildServer(readOnly: boolean): Server {
    const server = new Server({ name: o.name.toLowerCase(), version: "0.2.0" }, { capabilities: { tools: {} }, instructions: o.instructions });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!o.upstream || !auth.signedIn()) return { tools: readOnly ? [] : standIns() };
      try {
        return { tools: await withUpstream(async (u) => shown(u.tools, readOnly)) };
      } catch (err) {
        log.error({ err: String(err).slice(0, 300) }, `listing ${o.name} tools failed`);
        return { tools: readOnly ? [] : standIns() };
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      if (denied(name)) {
        log.warn({ tool: name }, "refused a denied tool");
        return refusal(`Tool ${name} is not available through AidenHQ.`);
      }
      // Only the owner can fix these: the kernel routes the need (needs.ts), never this text, to whoever should hear it.
      const need = () => needsOwner({ cause: auth.status().state === "expired" ? "expired" : "not_connected", detail: notConnected() });
      if (!o.upstream || !auth.signedIn()) return need();
      try {
        // Upstream answered through the owner's sign-in: a success says so, and clears a down state in the kernel (needs.ts).
        const result = await call(name, req.params.arguments ?? {}, readOnly);
        return result.isError ? result : signedIn(result);
      } catch (err) {
        log.warn({ tool: name, err: String(err).slice(0, 300) }, `${o.name} tool failed`);
        // A refused sign-in (marked expired) needs the owner; a vendor 5xx on refresh leaves it unknown and stays a plain error.
        if (auth.status().state === "expired") return need();
        return refusal(`${o.name} error: ${String((err as Error).message).slice(0, 300)}`);
      }
    });
    return server;
  }

  const bearer = (req: IncomingMessage, token: string | undefined): boolean => {
    if (!token) return false;
    const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  };

  async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) throw new Error("request body too large");
      chunks.push(c as Buffer);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  }

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  /** One live, read-only call upstream (its tool list): works, or what is wrong and the one thing to do about it. */
  async function checkConnection(): Promise<{ ok: true } | { ok: false; message: string; fix?: string }> {
    if (!o.upstream || !auth.signedIn()) return { ok: false, message: notConnected(), fix: "Connect" };
    try {
      await withUpstream((u) => u.client.listTools());
      return { ok: true };
    } catch (err) {
      const signIn = auth.status().state === "expired" || ((err instanceof AuthError || isAuthFailure(err)) && (await auth.refused?.() ?? true));
      return signIn ? { ok: false, message: `${o.name} no longer accepts the sign-in.`, fix: "Reconnect" } : { ok: false, message: `${o.name} didn't answer: ${String((err as Error).message).slice(0, 200)}` };
    }
  }

  /** The board's sign-in endpoints: state, the scopes on offer, and starting or finishing a sign-in (never a token). */
  async function handleAuth(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!bearer(req, o.authKey)) return sendJson(res, 401, { error: "unauthorized" });
    if (path === "/auth/status" && req.method === "GET") {
      await auth.check?.().catch(() => {});
      return sendJson(res, 200, { configured: Boolean(o.upstream), ...auth.status(), ...(hooks.status?.() ?? {}) });
    }
    if (path === "/auth/check" && req.method === "GET") return sendJson(res, 200, await checkConnection());
    const flow = auth.signIn;
    if (!flow) return sendJson(res, 400, { error: `${o.name} needs no sign-in` });
    if (!o.upstream) return sendJson(res, 400, { error: notConnected() });
    try {
      // A device sign-in: start (the code for the board to show), its state while this service polls, cancel.
      if (path === "/auth/device" || path === "/auth/device/cancel") {
        const d = auth.device;
        if (!d) return sendJson(res, 404, { error: `${o.name} signs in by redirect` });
        if (req.method === "GET" && path === "/auth/device") return sendJson(res, 200, d.state());
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        if (path === "/auth/device/cancel") return (d.cancel(), sendJson(res, 200, { ok: true }));
        const started = await d.start(() => {
          log.info({ scope: auth.status().scope }, `signed in to ${o.name}`);
          void reset(false, true).catch((err) => log.warn({ err: String(err).slice(0, 300) }, "connecting after sign-in failed"));
        });
        return sendJson(res, 200, started);
      }
      if (path === "/auth/scopes" && req.method === "GET") return sendJson(res, 200, await flow.scopes());
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      if (path === "/auth/start") {
        const { redirect_uri, scopes } = z.object({ redirect_uri: z.string().max(200), scopes: z.array(z.string().max(200)).max(200).optional() }).parse(await readJson(req));
        return sendJson(res, 200, await flow.start(redirect_uri, scopes));
      }
      if (path === "/auth/finish") {
        const { state, code } = z.object({ state: z.string().max(200), code: z.string().max(4096) }).parse(await readJson(req));
        await flow.finish(state, code);
        await reset(false, true).catch((err) => log.warn({ err: String(err).slice(0, 300) }, "connecting after sign-in failed"));
        log.info({ scope: auth.status().scope }, `signed in to ${o.name}`);
        return sendJson(res, 200, { ok: true });
      }
    } catch (err) {
      if (err instanceof SignInError || err instanceof z.ZodError) return sendJson(res, 400, { error: err instanceof SignInError ? err.message : "bad request" });
      throw err;
    }
    return sendJson(res, 404, { error: "not found" });
  }

  const http = createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return void res.writeHead(400).end(); }
    try {
      if (url.pathname === "/healthz") {
        const s = auth.status();
        // Without a sign-in (a local server) the only question is whether it answers; a failed ping drops the client.
        if (s.state === "none" && o.upstream) {
          const down = await withUpstream((u) => u.client.ping({ timeout: 3000 })).then(() => undefined, (err: Error) => { const old = upstream; upstream = undefined; if (old) retire(old); return `${o.name} didn't answer: ${String(err.message).slice(0, 150)}`; });
          return sendJson(res, down ? 503 : 200, { ok: !down, state: s.state, ...(down ? { detail: down } : {}) });
        }
        const why = !o.upstream ? `${o.name} isn't set up` : s.state === "missing" ? `${o.name} not connected (Connect on the board)` : s.state === "expired" ? `${o.name} sign-in expired: ${s.detail ?? ""} (Reconnect on the board)` : hooks.health?.();
        return sendJson(res, why ? 503 : 200, { ok: !why, state: s.state, ...(why ? { detail: why } : {}) });
      }
      if (url.pathname.startsWith("/auth/")) return await handleAuth(req, res, url.pathname);
      if (o.routes && (await o.routes(req, res))) return;
      const readOnly = url.pathname === "/mcp/read";
      if (url.pathname !== "/mcp" && !(readOnly && o.readKey)) return void res.writeHead(404).end();
      if (!bearer(req, readOnly ? o.readKey : o.serviceKey)) return void res.writeHead(401).end();
      if (req.method !== "POST") return void res.writeHead(405).end();
      const body = await readJson(req, 8 * 1024 * 1024);
      const msgs = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: unknown }[];
      if (!readOnly && msgs.some((m) => m?.method === "tools/call")) {
        try {
          await o.caller(req);
        } catch (err) {
          const reason = (err as Error).message;
          log.warn({ reason }, "tool call refused");
          const refused = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: refusal(`Refused: ${reason}.`) });
          return sendJson(res, 200, Array.isArray(body) ? msgs.map(refused) : refused(msgs[0]!));
        }
      }
      const server = buildServer(readOnly);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error({ err: (err as Error).message, path: url.pathname }, "request failed");
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  return Object.assign(http, { call });
}

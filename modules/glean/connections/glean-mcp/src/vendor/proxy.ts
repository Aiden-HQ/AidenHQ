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
  let upstream: { client: Client; tools: Tool[]; at: number } | undefined;

  const notConnected = () => (!o.upstream ? `${o.name} isn't connected yet: the owner presses Connect on the board (Settings, Connections).` : auth.status().state === "expired" ? `${o.name}'s sign-in stopped working: the owner reconnects it on the board.` : `${o.name} isn't connected: the owner signs in from the board.`);

  async function connect(): Promise<NonNullable<typeof upstream>> {
    if (!o.upstream) throw new AuthError(notConnected());
    const client = new Client({ name: `aidenhq-${o.name.toLowerCase()}-proxy`, version: "0.2.0" });
    await client.connect(new StreamableHTTPClientTransport(o.upstream, { requestInit: { headers: await auth.headers() } }));
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    await hooks.connected?.(client, tools);
    upstream = { client, tools, at: Date.now() };
    auth.mark("ok");
    const names = tools.map((t) => t.name).filter((n) => !denied(n));
    // The kernel lists only what the module tags; a name here it doesn't tag reaches nobody until a module change does.
    log.info({ upstream_tools: tools.length, tools: names }, `connected to ${o.name}`);
    if (cacheFile) try { writeFileSync(cacheFile, JSON.stringify(names)); } catch { /* read-only state: no stand-ins */ }
    return upstream;
  }

  async function reset(refresh: boolean): Promise<void> {
    const old = upstream;
    upstream = undefined;
    await old?.client.close().catch(() => undefined);
    if (refresh) await auth.refresh();
    await connect();
  }

  async function withUpstream<T>(fn: (u: NonNullable<typeof upstream>) => Promise<T>): Promise<T> {
    // Reconnect every 30 minutes or after an auth failure (inside the try: a token revoked early fails connect() too).
    try {
      if (!upstream || Date.now() - upstream.at > 30 * 60_000) await reset(false);
      return await fn(upstream ?? (await connect()));
    } catch (err) {
      if (!auth.signedIn() || !isAuthFailure(err)) throw err;
      log.warn(`${o.name} rejected the token; refreshing and retrying once`);
      try {
        await reset(true);
        return await fn(upstream ?? (await connect()));
      } catch (again) {
        if (isAuthFailure(again)) auth.mark("expired", `${o.name} rejected a freshly refreshed token`);
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

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (denied(name)) throw new Error(`${name} is not available through AidenHQ`);
    return withUpstream(async (u) => {
      const tool = u.tools.find((t) => t.name === name);
      // Only what the upstream lists: its schema is what the hooks pin arguments against.
      if (!tool) throw new Error(`${o.name} doesn't offer ${name}`);
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
        if (readOnly) {
          const tool = (await withUpstream(async (u) => u.tools)).find((t) => t.name === name);
          if (!tool || !servesRead(tool)) {
            log.warn({ tool: name }, "refused a write on the read endpoint");
            return refusal(`Tool ${name} is not a read: the read endpoint serves reads only.`);
          }
        }
        // Upstream answered through the owner's sign-in: a success says so, and clears a down state in the kernel (needs.ts).
        const result = await call(name, req.params.arguments ?? {});
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
      const signIn = err instanceof AuthError || isAuthFailure(err) || auth.status().state === "expired";
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
          void reset(false).catch((err) => log.warn({ err: String(err).slice(0, 300) }, "connecting after sign-in failed"));
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
        await reset(false).catch((err) => log.warn({ err: String(err).slice(0, 300) }, "connecting after sign-in failed"));
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
          const down = await withUpstream((u) => u.client.ping({ timeout: 3000 })).then(() => undefined, (err: Error) => { upstream = undefined; return `${o.name} didn't answer: ${String(err.message).slice(0, 150)}`; });
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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createApp, healthChecks } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./mcp/tools.js";
import { createLogger } from "./util/log.js";
import { kernelJwks, verifyCaller, type Caller } from "./aidenhq-sdk/caller.js";
import { SourceStore } from "./source-store.js";
import { startMeetingsSync } from "./warehouse.js";

const cfg = loadConfig(process.env.OPS_MCP_CONFIG ?? "/config/system.yaml");
const log = createLogger(cfg.logging.level);
const app = createApp(cfg, log);
// Who is calling: the kernel's signed assertion (the kernel enforces grants).
const jwks = kernelJwks();
async function authorize(req: IncomingMessage, body: unknown): Promise<{ ok: true; caller?: Caller } | { ok: false; body: unknown }> {
  const msgs = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: unknown }[];
  if (!msgs.some((m) => m?.method === "tools/call")) return { ok: true };
  try {
    return { ok: true, caller: await verifyCaller(req, jwks, process.env.AIDENHQ_MODULE ?? "meetings") };
  } catch (err) {
    const reason = (err as Error).message;
    log.warn({ reason }, "tool call refused");
    const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason}.` }] } });
    return { ok: false, body: Array.isArray(body) ? msgs.map(refusal) : refusal(msgs[0]!) };
  }
}

// The kernel's bearer (ops_service_key) required on /mcp.
const tokenFile = process.env.OPS_MCP_TOKEN_FILE;
const token = tokenFile && existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : undefined;

function authorized(req: IncomingMessage): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const presented = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const http = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return void res.writeHead(400).end(); }
  try {
    if (url.pathname === "/healthz" && req.method === "GET") {
      const h = await healthChecks(app);
      return send(res, h.ok ? 200 : 503, h);
    }
    if (url.pathname === "/mcp") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      const body = await readBody(req);
      const auth = await authorize(req, body);
      if (!auth.ok) return send(res, 200, auth.body);
      // Stateless mode: a fresh server and transport per request.
      const server = buildServer({ meetings: app.meetings, vault: app.vault, knowledge: app.knowledge, voice: app.voice, log });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof SyntaxError && !res.headersSent) return send(res, 400, { error: "invalid JSON body" });
    log.error({ err: err instanceof Error ? err.message : String(err), path: url.pathname }, "request failed");
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  }
});

http.listen(cfg.server.port, cfg.server.host, () => log.info({ port: cfg.server.port }, "ops-mcp listening"));

// src_meetings (shared sources): published meeting notes into the warehouse. Off until its password file is there.
const warehouse = SourceStore.fromEnv("meetings");
if (warehouse) startMeetingsSync(warehouse, { db: app.db, vault: app.vault }, log);
else log.warn("warehouse not configured; src_meetings is off");

// Apply the user's replies on review tasks within a minute, without waiting for a scan.
if (app.paperclip) {
  setInterval(() => {
    app.meetings.syncReviews().then(
      async (n) => {
        if (!n) return;
        log.info({ applied: n }, "applied review replies");
        // Only an agent run may close the review tasks in Paperclip: start one now.
        await app.paperclip!.runRoutine(cfg.paperclip.meeting_scan_routine).catch((err) => log.warn({ err: String(err) }, "could not start the meeting scan"));
      },
      (err) => log.warn({ err: String(err) }, "review sync failed"),
    );
  }, 60_000).unref();
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.info({ sig }, "shutting down");
    http.close(() => {
      app.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

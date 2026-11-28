// telegram-live: the user's own Telegram account, the only TDLib client of it. It serves the board's QR sign-in (/auth/*),
// keeps src_telegram current and sends routines' events (ingest.ts, backfill.ts), serves the agent tools (/mcp) and runs the
// telegram.send executor. Not signed in, or not configured, it still starts and stays idle (modules/AGENTS.md).
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { AuthInputError, createAuth, type Line } from "./auth.js";
import { startBackfill } from "./backfill.js";
import { createIngest, markAgentSend, type Ingest, type Settings } from "./ingest.js";
import { createKernel } from "./kernel.js";
import { buildServer } from "./mcp.js";
import { sender } from "./send.js";
import { createSummon } from "./summon.js";
import { openStore } from "./store.js";
import { openTd, TdError } from "./td.js";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.js";
import { serveExecutor } from "./aidenhq-sdk/executor.js";
import { SourceStore } from "./source-store.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "telegram-live" }, redact: ["authorization", "*.authorization", "password", "*.password", "value", "*.value"] });
// Secrets come from NAME_FILE (a compose secret) or NAME, read when needed: the board writes provided ones while this runs.
const env = (name: string): string => {
  const file = process.env[`${name}_FILE`];
  try {
    return (file ? readFileSync(file, "utf8") : (process.env[name] ?? "")).trim();
  } catch {
    return "";
  }
};
const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const kernelUrl = (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/$/, "");
const dataDir = process.env.TELEGRAM_DATA_DIR ?? "/data";
const port = Number(process.env.PORT ?? 8090);
const serviceKey = env("MCP_BEARER_TOKEN");
const authToken = env("AUTH_TOKEN");
if (!serviceKey) log.warn("MCP_BEARER_TOKEN not set: tools and the executor answer 401");

const settings: Settings = {
  muted: process.env.TELEGRAM_MUTED === "all" ? "all" : "tagged",
  exclude: new Set((process.env.TELEGRAM_EXCLUDE_CHATS ?? "").split(",").map((s) => s.trim()).filter((s) => /^-?\d{1,20}$/.test(s)).map(Number)),
  backfillDays: Number(process.env.TELEGRAM_BACKFILL_DAYS) > 0 ? Number(process.env.TELEGRAM_BACKFILL_DAYS) : 30,
};

mkdirSync(dataDir, { recursive: true });
const store = openStore(`${dataDir}/telegram-live.sqlite`);
const kernel = createKernel({ url: kernelUrl, token: env("MODULE_TOKEN"), log });
const credentials = () => {
  const apiId = Number(env("API_ID"));
  const apiHash = env("API_HASH");
  const key = env("TDLIB_KEY");
  return Number.isInteger(apiId) && apiId > 0 && apiHash && key ? { apiId, apiHash, key } : undefined;
};
const auth = createAuth({
  configured: () => credentials() !== undefined,
  open: () => {
    const c = credentials()!;
    return openTd({ apiId: c.apiId, apiHash: c.apiHash, key: c.key, dir: `${dataDir}/tdlib`, version });
  },
  store, dataDir, kernel, log,
});
if (!credentials()) log.info("not configured: waiting for api_id and api_hash (the board's Telegram Connect)");

let ingest: Ingest | undefined;
let backfill: ReturnType<typeof startBackfill> | undefined;
auth.onReady((td) => {
  if (ingest) return;
  log.info("signed in");
  // Taken synchronously on Ready, before TDLib's next update: no message update is missed, and every chat with a checkpoint
  // waits for the start reconcile below.
  ingest = createIngest({ td, store, me: auth.me, settings, kernel, log });
  const live = ingest;
  td.onUpdate((u) => void live.handle(u));
  live.startDrains({ warehouse: SourceStore.fromEnv("telegram"), kernel });
  void live.reconcile().catch((err) => log.warn({ err: String(err).slice(0, 300) }, "start reconcile failed"));
  const run = () => {
    backfill = startBackfill({ td, store, ingest: live, days: settings.backfillDays, log });
    backfill.done.catch((err) => {
      log.warn({ err: String((err as Error)?.message ?? err).slice(0, 300) }, "backfill stopped; resuming in a minute");
      setTimeout(run, 60_000).unref();
    });
  };
  run();
});
auth.setProgress((): Line | undefined => {
  const p = backfill?.progress();
  if (!p || !p.chats_total) return undefined;
  return { label: "History", value: `${p.chats_done} of ${p.chats_total} chats${p.oldest ? `, back to ${p.oldest.slice(0, 10)}` : ""}`, state: p.waiting ? "warn" : "ok" };
});

// telegram.send's executor, made on first use (the kernel calls it with the service key).
let executor: ReturnType<typeof serveExecutor> | undefined;
let send: ReturnType<typeof sender> | undefined;
const senderOnce = () => (send ??= sender({ td: () => auth.td(), store, onAgentSend: (c, t, w) => markAgentSend(store, c, t, w) }));
const executorFor = () => (executor ??= serveExecutor(senderOnce(), { key: serviceKey, kernelUrl, log: (msg, f) => log.warn(f ?? {}, msg) }));
// The summon contract's three calls (module.yaml summon:), made by the kernel with the same service key.
const summon = createSummon({ td: () => auth.td(), store, me: auth.me, settings, run: (rec, o) => senderOnce().run(rec, o) });
const jwks = kernelJwks();

const bearer = (req: IncomingMessage, token: string) => {
  const a = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const b = Buffer.from(token);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};
const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new AuthInputError("request too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

/** The board's sign-in routes (bearer telegram_auth_token): status, check, the QR device flow, its secret step, disconnect. */
async function authRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!bearer(req, authToken)) return json(res, 401, { error: "unauthorized" });
  const route = `${req.method} ${path}`;
  try {
    switch (route) {
      case "GET /auth/status":
        return json(res, 200, auth.status());
      case "GET /auth/check": {
        const s = auth.status();
        return json(res, 200, s.state === "ok" ? { ok: true } : { ok: false, message: s.detail ?? "Telegram isn't signed in.", fix: s.configured ? "Connect" : "Paste the api_id and api_hash" });
      }
      case "POST /auth/device":
        return json(res, 200, await auth.deviceStart());
      case "GET /auth/device":
        return json(res, 200, auth.deviceState());
      case "POST /auth/device/cancel":
        auth.cancel();
        return json(res, 200, { ok: true });
      case "POST /auth/device/secret": {
        const b = await body(req);
        if (typeof b?.value !== "string" || b.value.length < 1 || b.value.length > 256) return json(res, 400, { error: "send { value }" });
        await auth.deviceSecret(b.value);
        return json(res, 200, { ok: true });
      }
      case "POST /auth/disconnect":
        await auth.disconnect();
        return json(res, 200, { ok: true });
      default:
        return json(res, 404, { error: "not found" });
    }
  } catch (err) {
    // Never the request (a password): only the words made for the owner.
    if (err instanceof AuthInputError || err instanceof TdError) return json(res, 400, { error: err.message });
    log.error({ route, err: String((err as Error)?.message ?? err).slice(0, 200) }, "sign-in route failed");
    return json(res, 500, { error: "telegram-live couldn't do that; try again" });
  }
}

const http = createServer(async (req, res) => {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return void res.writeHead(400).end();
  }
  if (url.pathname === "/healthz") {
    const s = auth.status();
    return json(res, 200, { ok: true, state: s.state, ...(s.state === "expired" && s.detail ? { detail: s.detail } : {}) });
  }
  if (url.pathname.startsWith("/auth/")) return authRoute(req, res, url.pathname);
  if (url.pathname.startsWith("/aidenhq/v1/executor/")) {
    try {
      if (await executorFor()(req, res)) return;
    } catch (err) {
      log.error({ err: String((err as Error)?.message ?? err).slice(0, 200) }, "executor failed");
      if (!res.headersSent) return json(res, 500, { error: "executor failed" });
      return;
    }
  }
  if (url.pathname.startsWith("/summon/")) {
    if (!bearer(req, serviceKey)) return void res.writeHead(401).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    try {
      const r = await summon.handle(url.pathname.slice("/summon/".length), await body(req));
      return json(res, r.status, r.body);
    } catch (err) {
      return json(res, err instanceof AuthInputError || err instanceof SyntaxError ? 400 : 500, { error: "bad request" });
    }
  }
  if (url.pathname !== "/mcp") return void res.writeHead(404).end();
  if (!bearer(req, serviceKey)) return void res.writeHead(401).end();
  if (req.method !== "POST") return void res.writeHead(405).end();
  try {
    const b = await body(req);
    // Every tools/call needs the kernel's assertion of who is calling; a refusal is a tool result the agent can read.
    const msgs = (Array.isArray(b) ? b : [b]) as { id?: unknown; method?: unknown }[];
    let caller: Awaited<ReturnType<typeof verifyCaller>> | undefined;
    if (msgs.some((m) => m?.method === "tools/call")) {
      try {
        caller = await verifyCaller(req, jwks, process.env.AIDENHQ_MODULE ?? "telegram");
      } catch (err) {
        const reason = (err as Error).message;
        log.warn({ reason }, "tool call refused");
        const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason}` }] } });
        return json(res, 200, Array.isArray(b) ? msgs.map(refusal) : refusal(msgs[0]!));
      }
    }
    const server = buildServer({ td: auth.td(), store, me: auth.me, ...(caller ? { caller: { key: caller.key } } : {}) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, b);
  } catch (err) {
    log.error({ err: String((err as Error)?.message ?? err).slice(0, 200) }, "request failed");
    if (!res.headersSent) res.writeHead(500).end();
  }
});

http.listen(port, "0.0.0.0", () => log.info({ port }, "telegram-live listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    ingest?.stop();
    backfill?.stop();
    http.close();
    // TDLib flushes its database on close: wait for authorizationStateClosed, but never past compose's stop timeout.
    void Promise.race([auth.close(), new Promise((r) => setTimeout(r, 8_000))]).finally(() => process.exit(0));
  });

// slack-live: the instance's Slack app. The ONE Socket Mode consumer for its app token (two consumers split the events):
// live events sent to the kernel's event router (routines' events), every event teed to src_slack with a
// gap sync, and the owner's own messages in their command channel sent to the kernel as owner chat. It is a transport of the
// owner's router (owner-channel): the kernel sends it one owner message at a time as a Slack DM (POST /transport/send,
// send.ts). slack_post is the write kind slack.post (post.ts, the executor). No control-plane key.
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { binder, mention, slashCommand } from "./bind.js";
import { buildServer } from "./mcp.js";
import { memoryWriter } from "./memory.js";
import { poster } from "./post.js";
import { startSocket } from "./socket.js";
import { createPairing, handlePairingDm } from "./pair.js";
import { openStore } from "./store.js";
import { postMessage, transportSend, type SlackConfig } from "./send.js";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.js";
import { serveExecutor } from "./aidenhq-sdk/executor.js";
import { SourceStore } from "./source-store.js";
import { slackTee, startGapSync } from "./sources.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "slack-live" }, redact: ["authorization", "*.authorization", "token", "*.token"] });
const jwks = kernelJwks();
const kernelUrl = (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/$/, "");
// Secrets come from NAME_FILE (a compose secret) or NAME.
const env = (name: string): string => {
  const file = process.env[`${name}_FILE`];
  return (file ? readFileSync(file, "utf8") : (process.env[name] ?? "")).trim();
};

const port = Number(process.env.PORT ?? 8089);
const inboundToken = env("MCP_BEARER_TOKEN");
if (!inboundToken) throw new Error("MCP_BEARER_TOKEN(_FILE) is required");
// `token`: the channel routes (/v1/channel/*) take only the module's own token; everything else, the connection's key.
const kernel = async (path: string, body: unknown, token = inboundToken) => {
  const res = await fetch(`${kernelUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json() as Promise<any>;
};
const kernelGet = async (path: string) => {
  const res = await fetch(`${kernelUrl}${path}`, { headers: { authorization: `Bearer ${inboundToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json() as Promise<any>;
};
const store = openStore(process.env.SLACK_LIVE_DB ?? "/data/slack-live.sqlite");
// The paired owner (the board mints the code, the owner DMs it) is the owner, and that DM is the command channel.
const pairing = createPairing(store.db);
const pairToken = env("PAIR_TOKEN");
const cfg: SlackConfig = { botToken: env("SLACK_BOT_TOKEN"), ownerId: pairing.owner()?.user ?? "", boardUrl: env("BOARD_LAN_URL") };
// The kernel's bearer on /transport/send: this module's own token.
const channelToken = env("CHANNEL_TOKEN");
// slack.post's executor (executor@1): the kernel calls it with the service key; execute only for an approved record.
const post = poster(store, { botToken: cfg.botToken, allowed: new Set((process.env.SLACK_POST_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) });
// slack.bind (bind.ts) shares the executor: the kind says which one.
const bind = binder(store, { get ownerId() { return cfg.ownerId; }, agents: async () => (await kernelGet("/v1/agents")).agents ?? {} });
const memory = memoryWriter(store);
const by = (kind: string) => (kind.endsWith(".bind") ? bind : kind.endsWith(".memory") ? memory : post);
const executor = serveExecutor({ plan: (r) => by(r.kind).plan(r), execute: (r) => by(r.kind).execute(r) }, { key: inboundToken, kernelUrl, log: (msg, f) => log.warn(f ?? {}, msg) });

function authorized(req: IncomingMessage): boolean {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(inboundToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const appToken = env("SLACK_APP_TOKEN");
// Whether Slack is set up (the board's Settings shows it): booleans only, never a token.
const health = JSON.stringify({ ok: true, channels: { slack: Boolean(appToken && cfg.botToken) } });

const http = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return void res.writeHead(400).end(); }
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(health);
  if (url.pathname === "/pair") {
    // The board's pairing endpoint: only with the pair token (a signed-in admin with an authenticator reaches it there).
    const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(pairToken);
    if (!pairToken || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return void res.writeHead(401).end();
    const json = (body: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST") return json({ code: pairing.mint() });
    if (req.method === "GET") return json({ paired: pairing.paired(), ...(pairing.pairedAt() ? { paired_at: pairing.pairedAt() } : {}) });
    return void res.writeHead(405).end();
  }
  if (await executor(req, res)) return;
  if (url.pathname === "/transport/send") {
    const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(channelToken);
    if (!channelToken || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return void res.writeHead(401).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const m = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (typeof m.text !== "string" || !m.text) return void res.writeHead(400).end();
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await transportSend(cfg, m)));
    } catch (err) {
      log.error({ err: (err as Error).message }, "transport send failed");
      return void res.writeHead(500).end();
    }
  }
  if (url.pathname !== "/mcp") return void res.writeHead(404).end();
  if (!authorized(req)) return void res.writeHead(401).end();
  if (req.method !== "POST") return void res.writeHead(405).end();
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    // Every tools/call needs the kernel's assertion of who is calling; a refusal is a tool result the agent can read.
    const msgs = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: unknown }[];
    let caller: Awaited<ReturnType<typeof verifyCaller>> | undefined;
    if (msgs.some((m) => m?.method === "tools/call")) {
      try {
        caller = await verifyCaller(req, jwks, process.env.AIDENHQ_MODULE ?? "slack");
      } catch (err) {
        const reason = (err as Error).message;
        log.warn({ reason }, "tool call refused");
        const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason}` }] } });
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? msgs.map(refusal) : refusal(msgs[0]!)));
      }
    }
    const server = buildServer(store, cfg, caller && { key: caller.key });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log.error({ err: (err as Error).message }, "request failed");
    if (!res.headersSent) res.writeHead(500).end();
  }
});

http.listen(port, "0.0.0.0", () => log.info({ port }, "slack-live listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));

// The owner's own messages in their command channel: chat with Aiden, posted by the kernel as the owner, stamped [slack].
const chat = { owner: pairing.owner, deliver: async (text: string) => void (await kernel("/v1/channel/owner-message", { sender: "owner", text }, channelToken)) };
const pair = (body: unknown) =>
  handlePairingDm(pairing, body, (channel, text) => postMessage(cfg, { channel, text }), (o) => void (cfg.ownerId = o.user));

// src_slack (shared sources): every event teed to the warehouse, and a gap sync with the owner's user token. Off until the
// warehouse password (WAREHOUSE_PASSWORD_FILE) is there; the gap sync also needs SLACK_USER_TOKEN.
const sources = SourceStore.fromEnv("slack");
const tee = sources ? slackTee(sources, log) : undefined;
const userToken = env("SLACK_USER_TOKEN");
if (sources && userToken) startGapSync(sources, userToken, log, channelToken ? (e) => forward(e) : undefined);
else log.warn(sources ? "SLACK_USER_TOKEN not set; src_slack gets live events only (no gap sync)" : "warehouse not configured; src_slack is off");

// Channel binding: the owner's /aiden commands (a kernel record each) and @mentions in bound channels (a task each).
const slackApi = (method: string, body: unknown) => fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${cfg.botToken}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
const binding = cfg.botToken ? {
  command: (b: any) => slashCommand(b, { store, ownerId: cfg.ownerId, // read at the call: pairing sets it after start
    file: async (args) => {
    const res = await fetch(`${kernelUrl}/v1/writes`, { method: "POST", headers: { authorization: `Bearer ${inboundToken}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "slack.bind", args }), signal: AbortSignal.timeout(20_000) });
    const r = (await res.json().catch(() => ({}))) as { state?: string; error?: { message?: string } | string };
    if (!res.ok) throw new Error(String(typeof r.error === "object" ? r.error?.message : r.error ?? res.status));
    return { state: String(r.state) };
  } }),
  mention: (ev: any) => mention(ev, { store, thread: (b) => kernel("/v1/channel/thread", b, channelToken), react: async (channel, timestamp, name) => void (await slackApi("reactions.add", { channel, timestamp, name })) }),
} : undefined;

// Routines' events: each kept event to the kernel's event router with this module's own token (role kernel.events). Any 2xx is
// taken (queued, skipped or dropped); a 429 or 5xx throws so Slack redelivers; any other refusal is logged and passed.
const forward = async (e: unknown) => {
  const res = await fetch(`${kernelUrl}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${channelToken}`, "content-type": "application/json" }, body: JSON.stringify(e), signal: AbortSignal.timeout(15_000) });
  if (res.status === 429 || res.status >= 500) throw new Error(`POST /v1/events -> ${res.status}`);
  if (!res.ok) log.warn({ status: res.status }, "the kernel refused an event; passed");
};

if (appToken) void startSocket({ appToken, store, chat, pair, ...(binding ? { bind: binding } : {}), ...(tee ? { tee } : {}), ...(channelToken ? { forward } : {}), log });
else log.warn("SLACK_APP_TOKEN not set; not listening to Slack");

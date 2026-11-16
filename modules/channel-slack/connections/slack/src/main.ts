// channel-slack: the instance's Slack app. The ONE Socket Mode consumer for its app token (two consumers split the events):
// live events buffered for triage (slack_pending_events) with a debounced webhook poke, every event teed to src_slack with a
// gap sync, and the owner's own messages in their command channel sent to the kernel as owner chat. notify_owner here is a
// Slack DM to the owner; slack_post is the write kind channel-slack.post (post.ts, the executor). No control-plane key.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { buildServer } from "./mcp.js";
import { poster } from "./post.js";
import { startSocket } from "./socket.js";
import { openStore } from "./store.js";
import { type NotifyConfig } from "./urgent.js";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.js";
import { serveExecutor } from "./aidenhq-sdk/executor.js";
import { SourceStore } from "./source-store.js";
import { slackTee, startGapSync } from "./sources.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "channel-slack" }, redact: ["authorization", "*.authorization", "token", "*.token"] });
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
const kernel = async (path: string, body: unknown) => {
  const res = await fetch(`${kernelUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${inboundToken}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json() as Promise<any>;
};
const store = openStore(process.env.SLACK_LIVE_DB ?? "/data/slack-live.sqlite");
const cfg: NotifyConfig = {
  botToken: env("SLACK_BOT_TOKEN"),
  ownerId: env("OWNER_SLACK_USER_ID"),
  cooldownMs: Number(process.env.URGENT_COOLDOWN_MIN ?? 60) * 60_000,
  brake: (task, agent, decision) => kernel("/v1/brake/notify", { task, agent, ...(decision ? { decision: true } : {}) }),
};
const ignored = new Set((process.env.IGNORE_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
// channel-slack.post's executor (executor@1): the kernel calls it with the service key; execute only for an approved record.
const executor = serveExecutor(poster(store, { botToken: cfg.botToken, allowed: new Set((process.env.SLACK_POST_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) }), { key: inboundToken, kernelUrl, log: (msg, f) => log.warn(f ?? {}, msg) });

// One triage run per minute at most, with every event that arrived in it: the first event after a quiet minute fires at
// once, and the rest wait for the minute to end (one run per Slack event was 67 runs a day, 50 of them finding nothing;
// a 30-minute window was too slow). An urgent event in a busy minute waits up to the window. Signed like scripts/trigger-meeting-scan.sh.
const TRIAGE_WINDOW_MS = 60_000;
const webhookUrl = env("TRIAGE_WEBHOOK_URL");
const webhookSecret = env("TRIAGE_WEBHOOK_SECRET");
let lastPoke = 0;
let pokeTimer: NodeJS.Timeout | undefined;
function poke(): void {
  if (!webhookUrl || !webhookSecret || pokeTimer) return;
  pokeTimer = setTimeout(async () => {
    pokeTimer = undefined;
    lastPoke = Date.now();
    const ts = String(Math.floor(lastPoke / 1000));
    const body = '{"event":"slack_events_pending"}';
    const sig = createHmac("sha256", webhookSecret).update(`${ts}.${body}`).digest("hex");
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (![202, 409].includes(res.status)) log.warn({ status: res.status }, "triage webhook failed");
    } catch (err) {
      log.warn({ err: String(err) }, "triage webhook failed");
    }
  }, Math.max(0, lastPoke + TRIAGE_WINDOW_MS - Date.now()));
}

function authorized(req: IncomingMessage): boolean {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(inboundToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const appToken = env("SLACK_APP_TOKEN");
// Whether Slack is set up (the board's Settings shows it): booleans only, never a token.
const health = JSON.stringify({ ok: true, channels: { slack: Boolean(appToken && cfg.botToken) } });

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(health);
  if (await executor(req, res)) return;
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
        caller = await verifyCaller(req, jwks, process.env.AIDENHQ_MODULE ?? "channel-slack");
      } catch (err) {
        const reason = (err as Error).message;
        log.warn({ reason }, "tool call refused");
        const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason}` }] } });
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? msgs.map(refusal) : refusal(msgs[0]!)));
      }
    }
    // An agent in trial ("draft, don't do") reaches the owner and nothing that points elsewhere (the kernel's role mark).
    const server = buildServer(store, cfg, caller && { id: caller.agent, name: caller.name, key: caller.key }, Boolean(caller?.roles.includes("kernel.trial")));
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

http.listen(port, "0.0.0.0", () => log.info({ port }, "channel-slack listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));

// The owner's own messages in their command channel: chat with Aiden, posted by the kernel as the owner, stamped [slack].
const commandChannel = process.env.OWNER_COMMAND_CHANNEL ?? "";
const chat = commandChannel && cfg.ownerId ? { ownerId: cfg.ownerId, channel: commandChannel, deliver: async (text: string) => void (await kernel("/v1/channel/owner-message", { sender: "owner", text })) } : undefined;

// src_slack (shared sources): every event teed to the warehouse, and a gap sync with the owner's user token. Off until the
// warehouse password (WAREHOUSE_PASSWORD_FILE) is there; the gap sync also needs SLACK_USER_TOKEN.
const sources = SourceStore.fromEnv("slack");
const tee = sources ? slackTee(sources, log) : undefined;
const userToken = env("SLACK_USER_TOKEN");
if (sources && userToken) startGapSync(sources, userToken, log);
else log.warn(sources ? "SLACK_USER_TOKEN not set; src_slack gets live events only (no gap sync)" : "warehouse not configured; src_slack is off");

if (appToken) void startSocket({ appToken, store, ignored, onKept: poke, ...(chat ? { chat } : {}), ...(tee ? { tee } : {}), log });
else log.warn("SLACK_APP_TOKEN not set; not listening to Slack");

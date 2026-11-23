// chat-lane: the fast chat lane (lane/lane.ts). Agents with a `chat:` block answer their chat (one task each, written on the
// board or through their own Telegram bots) in seconds with a light model, calling tools through the kernel as themselves;
// wake_at, wake_list and chat_send (MCP, behind the kernel's proxy). Its chats live only in those tasks: the kernel writes
// each turn there (POST /v1/channel/exchange, role kernel.lane), the owner's words as the owner and the replies as the agent;
// a wake on a task goes into the kernel's wake inbox (POST /v1/wakes), and it reads tasks through the kernel.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { buildServer } from "./mcp.js";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.js";
import { kernelClient } from "./aidenhq-sdk/kernel-client.js";
import { laneConfig } from "./lane/config.js";
import { makeLane } from "./lane/lane.js";
import { kernelChat } from "./lane/chat.js";
import { followOwnerChat, startLaneTelegram, startScan, startWakes, telegramSend } from "./lane/serve.js";
import { openLaneStore } from "./lane/store.js";
import { makeTools } from "./lane/tools.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "chat-lane" }, redact: ["authorization", "*.authorization", "token", "*.token"] });
const jwks = kernelJwks();
const kernelUrl = (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/$/, "");
const env = (name: string): string => {
  const file = process.env[`${name}_FILE`];
  return (file ? readFileSync(file, "utf8") : (process.env[name] ?? "")).trim();
};

const port = Number(process.env.PORT ?? 8089);
const inboundToken = env("MCP_BEARER_TOKEN");
if (!inboundToken) throw new Error("MCP_BEARER_TOKEN(_FILE) is required");
const kernel = kernelClient(kernelUrl, inboundToken, { timeoutMs: 20_000 }).call;
// The agent's memory, once per turn, bounded: a slow or failed read never holds a turn up.
const memoryRead = kernelClient(kernelUrl, inboundToken, { timeoutMs: 2_000 }).call;

const store = openLaneStore(process.env.LANE_DB ?? "/data/lane.sqlite");
const agents = laneConfig(process.env.LANE_CONFIG_FILE, (msg) => log.warn(msg));
// Only the owner's chat reaches a lane agent's bot: the chat channel-telegram paired.
const ownerChat = followOwnerChat({ telegramUrl: process.env.TELEGRAM_URL ?? "http://telegram:8089", getKv: (k) => store.getKv(k), setKv: (k, v) => store.setKv(k, v), log });
const lane = makeLane({
  store,
  chat: kernelChat(kernel),
  agents,
  tools: makeTools(inboundToken),
  memory: async (agent) => {
    try { return String((await memoryRead("GET", `/v1/memory/${encodeURIComponent(agent.key)}`)).view ?? ""); } catch (e) {
      log.warn({ agent: agent.key, err: (e as Error).message }, "lane memory read failed");
      return "memory unavailable this turn";
    }
  },
  gatewayUrl: process.env.AIDENHQ_GATEWAY_URL ?? "http://10.231.0.1:8201",
  laneSecret: env("GATEWAY_LANE_SECRET"),
  timezone: process.env.OWNER_TIMEZONE || "UTC",
  ownerName: process.env.OWNER_NAME || "the owner",
  telegram: async (agent, text) => {
    const chat = ownerChat.current();
    if (chat && agent.telegramToken) await telegramSend(agent.telegramToken, chat, text);
  },
  log,
});
// Whether a task has finished (the kernel's read of the control plane), cached a minute: a wake cap check asks about every task it holds.
const closedTasks = new Map<string, { at: number; closed: boolean }>();
const taskIsClosed = async (task: string): Promise<boolean> => {
  const hit = closedTasks.get(task);
  if (hit && Date.now() - hit.at < 60_000) return hit.closed;
  const issue = await kernel("GET", `/v1/cp/read/api/issues/${encodeURIComponent(task)}`);
  const closed = issue?.status === "done" || issue?.status === "cancelled";
  if (closedTasks.size >= 500) closedTasks.clear();
  closedTasks.set(task, { at: Date.now(), closed });
  return closed;
};
const laneTools = { store, lane, agents, timezone: process.env.OWNER_TIMEZONE || "UTC", taskIsClosed };

function authorized(req: IncomingMessage): boolean {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(inboundToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const http = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return void res.writeHead(400).end(); }
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname !== "/mcp") return void res.writeHead(404).end();
  if (!authorized(req)) return void res.writeHead(401).end();
  if (req.method !== "POST") return void res.writeHead(405).end();
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const msgs = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: unknown }[];
    let caller: Awaited<ReturnType<typeof verifyCaller>> | undefined;
    if (msgs.some((m) => m?.method === "tools/call")) {
      try {
        caller = await verifyCaller(req, jwks, process.env.AIDENHQ_MODULE ?? "chat-lane");
      } catch (err) {
        const reason = (err as Error).message;
        log.warn({ reason }, "tool call refused");
        const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason}` }] } });
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? msgs.map(refusal) : refusal(msgs[0]!)));
      }
    }
    const server = buildServer(laneTools, caller && { id: caller.agent, name: caller.name, key: caller.key });
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

http.listen(port, "0.0.0.0", () => log.info({ port }, "chat-lane listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));

startScan({ lane, agents, log });
startLaneTelegram({ lane, agents, ownerChatId: ownerChat.current, getKv: (k) => store.getKv(k), setKv: (k, v) => store.setKv(k, v), log });
startWakes({
  store,
  lane,
  agents,
  taskIsClosed,
  wakeTask: async (id, task, note) => void (await kernel("POST", "/v1/wakes", { task, cause: note, id: `lane-${id}` })),
  log,
});

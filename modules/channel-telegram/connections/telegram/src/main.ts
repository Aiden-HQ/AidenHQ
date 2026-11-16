// channel-telegram: the owner's Telegram (spec §3.3.4 channel@1). The owner's chat comes in through the bot (long polling) and
// goes to the kernel as owner messages; approval cards come from the kernel with this channel's single-use decision tokens;
// notify_owner (MCP, behind the kernel's proxy) reaches the owner here and on their board chat. This service holds only the
// bot token and its own service key: no control-plane key, no decide key.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { sendBatch, sendNotices, sendOutcomes, syncCards, type DecideSetting } from "./approvals.js";
import { makeChat, startTelegramPoll } from "./chat.js";
import { quickCommand } from "./commands.js";
import { kernelClient } from "./kernel.js";
import { buildServer } from "./mcp.js";
import { openStore } from "./store.js";
import { buttonsMarkup } from "./telegram.js";
import { ownerViaOf, taskForNotify } from "./threads.js";
import { editTelegram, makePostReply, notifyOwner, postTelegram, type NotifyConfig } from "./urgent.js";
import { transcribe } from "./voice.js";
import { startWatch } from "./watch.js";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "channel-telegram" }, redact: ["authorization", "*.authorization", "token", "*.token"] });
const jwks = kernelJwks();
const kernelUrl = process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
// Secrets come from NAME_FILE (a compose secret) or NAME.
const env = (name: string): string => {
  const file = process.env[`${name}_FILE`];
  return (file ? readFileSync(file, "utf8") : (process.env[name] ?? "")).trim();
};

const port = Number(process.env.PORT ?? 8089);
const inboundToken = env("MCP_BEARER_TOKEN");
if (!inboundToken) throw new Error("MCP_BEARER_TOKEN(_FILE) is required");
const kernel = kernelClient(kernelUrl, inboundToken);
const store = openStore(process.env.TELEGRAM_DB ?? "/data/telegram.sqlite");
const decideSetting = (["all", "standard", "none"].includes(process.env.TELEGRAM_DECIDE ?? "") ? process.env.TELEGRAM_DECIDE : "all") as DecideSetting;
const batchOn = process.env.TELEGRAM_BATCH !== "off";
const cfg: NotifyConfig & { telegramToken: string; telegramChatId: string } = {
  cooldownMs: Number(process.env.URGENT_COOLDOWN_MIN ?? 60) * 60_000,
  telegramToken: env("TELEGRAM_NOTIFY_BOT_TOKEN"),
  telegramChatId: env("TELEGRAM_OWNER_CHAT_ID"),
  taskUrl: env("TELEGRAM_TASK_URL"),
  muteFyi: process.env.TELEGRAM_FYI === "mute",
  // The agent's reply on its chat, posted through the kernel as that agent.
  postReply: makePostReply({ kernelUrl, serviceKey: inboundToken, warn: (msg, status) => log.warn({ status }, msg) }),
  brake: (task, agent, decision) => kernel.brake({ task, agent, ...(decision ? { decision: true as const } : {}) }),
};
// notify_owner(task): the task's agent heads the message (looked up through the kernel, never taken from the text).
const chat = makeChat({ telegramToken: cfg.telegramToken, telegramChatId: cfg.telegramChatId }, store, kernel, log);
cfg.resolveTask = async (identifier) => {
  const issue = await kernel.read(`/api/issues/${encodeURIComponent(identifier)}`);
  const company = await chat.company();
  const [agents, live] = await Promise.all([kernel.read(`/api/companies/${company}/agents`), kernel.read(`/api/companies/${company}/live-runs`)]);
  const found = taskForNotify({ id: String(issue.id), assigneeAgentId: issue.assigneeAgentId ?? null }, live, agents);
  if (!found) return undefined;
  const commentsOf = async (id: string) => {
    const comments = await kernel.read(`/api/issues/${encodeURIComponent(id)}/comments`).catch(() => []);
    const list = (Array.isArray(comments) ? comments : (comments?.comments ?? [])) as { body: string; authorType?: string; createdAt: string }[];
    return [...list].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  };
  const parentId = issue.parentId ? String(issue.parentId) : undefined;
  const parentIssue = parentId ? await kernel.read(`/api/issues/${encodeURIComponent(parentId)}`).catch(() => null) : null;
  const parent = parentIssue ? { issue: parentIssue, comments: await commentsOf(parentId!) } : undefined;
  return { ...found, ownerVia: ownerViaOf(issue, await commentsOf(String(issue.id)), parent) };
};

function authorized(req: IncomingMessage): boolean {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(inboundToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

// Whether Telegram and voice are set up (the board's Settings shows them): booleans only, never a token.
const health = JSON.stringify({ ok: true, channels: { telegram: Boolean(cfg.telegramToken && cfg.telegramChatId), voice: Boolean(process.env.WHISPER_URL) } });

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(health);
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
        caller = await verifyCaller(req, jwks, process.env.AIDENHQ_MODULE ?? "channel-telegram");
      } catch (err) {
        const reason = (err as Error).message;
        log.warn({ reason }, "tool call refused");
        const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason}` }] } });
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? msgs.map(refusal) : refusal(msgs[0]!)));
      }
    }
    // An agent in trial ("draft, don't do") reaches the owner only (the kernel's role mark).
    const server = buildServer(store, cfg, caller && { id: caller.agent, name: caller.name, key: caller.key, assertion: String(req.headers["x-aidenhq-caller"]) }, Boolean(caller?.roles.includes("kernel.trial")));
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

http.listen(port, "0.0.0.0", () => log.info({ port }, "channel-telegram listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));

if (!cfg.telegramToken || !cfg.telegramChatId) log.warn("TELEGRAM_NOTIFY_BOT_TOKEN/TELEGRAM_OWNER_CHAT_ID not set; the Telegram chat is off (notify_owner still reaches the board chat)");
else {
  const withButtons = async (text: string, markup: unknown) => {
    const out: { id?: number } = {};
    return (await postTelegram(cfg, text, markup, undefined, undefined, undefined, out)) && (out.id ?? true);
  };
  // Cards: pending cards and their tokens from the kernel (fresh tokens for all of them once, at start), the list for
  // Approve all, and each card's outcome; and the kernel's one-shot notices (reset links, digest, owner lines).
  let resync = true;
  const cards = async () => {
    try {
      const r = await syncCards(kernel, store, withButtons, decideSetting, resync);
      resync = false;
      if (batchOn) await sendBatch(r.cards, store, withButtons, (id, text) => editTelegram(cfg, id, text)).catch((err) => log.warn({ err: String(err) }, "approval batch list failed"));
      await sendOutcomes(r.finished, store, (id, text) => editTelegram(cfg, id, text));
    } catch (err) {
      log.warn({ err: String(err) }, "approval cards failed");
    }
    await sendNotices(kernel, (text) => postTelegram(cfg, text)).catch((err) => log.warn({ err: String(err) }, "owner notices failed"));
  };
  void cards();
  setInterval(cards, 20_000).unref();
  const whisperUrl = process.env.WHISPER_URL ?? "";
  void startTelegramPoll({ telegramToken: cfg.telegramToken, telegramChatId: cfg.telegramChatId }, store, chat, log, {
    command: async (text) => (text.startsWith("/") ? quickCommand(text, (_m, p) => kernel.read(p), await chat.company()) : null),
    ...(whisperUrl ? { transcribe: (fileId: string) => transcribe(cfg.telegramToken, whisperUrl, fileId) } : {}),
    reply: (r) => postTelegram(cfg, r.text, buttonsMarkup(store, r.actions ?? [])),
    stop: chat.stop,
    approvals: { kernel, setting: decideSetting },
  });
  startWatch((p) => kernel.read(p), { store, notify: async (text) => (await notifyOwner(store, cfg, { text, priority: "normal", channel: "telegram" })).sent }, log);
}

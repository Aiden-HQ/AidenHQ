// channel-telegram: the owner's Telegram (spec §3.3.4 channel@1). The owner's chat comes in through the bot (long polling) and
// goes to the kernel as owner messages; approval cards come from the kernel with this channel's single-use decision tokens;
// notify_owner (MCP, behind the kernel's proxy) reaches the owner here and on their board chat. This service holds only the
// bot token and its own service key: no control-plane key, no decide key.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { sendBatch, sendNotices, sendOutcomes, syncCards, type DecideSetting } from "./approvals.js";
import { makeChat, startTelegramPoll } from "./chat.js";
import { quickCommand } from "./commands.js";
import { kernelClient } from "./kernel.js";
import { buildServer } from "./mcp.js";
import { openStore } from "./store.js";
import { botUsername, createPairing, handleStart, seedOwnerChat } from "./pair.js";
import { buttonsMarkup } from "./telegram.js";
import { ownerViaOf, taskForNotify } from "./threads.js";
import { flushDigest } from "./attention.js";
import { editTelegram, makePostReply, notifyOwner, postTelegram, type NotifyConfig } from "./urgent.js";
import { transcribe, voiceOn } from "./voice.js";
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
// The owner chat is this service's own state, set by pairing (pair.ts); an id from the host's .env is taken once (upgrade).
seedOwnerChat(store, env("TELEGRAM_OWNER_CHAT_ID"), (msg) => log.info(msg));
const pairing = createPairing(store);
const pairToken = env("PAIR_TOKEN");
const decideSetting = (["all", "standard", "none"].includes(process.env.TELEGRAM_DECIDE ?? "") ? process.env.TELEGRAM_DECIDE : "all") as DecideSetting;
const cfg: NotifyConfig & { telegramToken: string; telegramChatId: string } = {
  cooldownMs: Number(process.env.URGENT_COOLDOWN_MIN ?? 60) * 60_000,
  telegramToken: env("TELEGRAM_NOTIFY_BOT_TOKEN"),
  get telegramChatId() {
    return store.ownerChat() ?? "";
  },
  taskUrl: env("TELEGRAM_TASK_URL"),
  muteFyi: process.env.TELEGRAM_FYI === "mute",
  // The agent's reply on its chat, posted through the kernel as that agent.
  postReply: makePostReply({ kernelUrl, serviceKey: inboundToken, warn: (msg, status) => log.warn({ status }, msg) }),
  brake: (task, agent, decision) => kernel.brake({ task, agent, ...(decision ? { decision: true as const } : {}) }),
  toSlack: (text) => kernel.file("channel-slack", text),
  attention: {
    mode: process.env.NOTIFY_ATTENTION === "enforce" ? "enforce" : "observe",
    blocked: (process.env.NOTIFY_BLOCKED ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    dailyCap: Number(process.env.NOTIFY_DAILY_CAP ?? 40),
    digestHours: (process.env.NOTIFY_DIGEST_HOURS ?? "").split(",").filter((x) => x.trim()).map(Number).filter((x) => x >= 0 && x < 24),
    timezone: process.env.OWNER_TIMEZONE || "UTC",
    warn: (o, msg) => log.warn(o, msg),
  },
};
// notify_owner(task): the task's agent heads the message (looked up through the kernel, never taken from the text).
const chat = makeChat(cfg, store, kernel, log);
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

function authorized(req: IncomingMessage, token = inboundToken): boolean {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return expected.length > 0 && presented.length === expected.length && timingSafeEqual(presented, expected);
}

// Whether Telegram and voice are set up (the board's Settings shows them): booleans only, never a token.
// Voice is the optional voice module: on when its Whisper service resolves, checked once a minute.
let voice = false;
const checkVoice = async () => { voice = await voiceOn(process.env.WHISPER_URL ?? ""); };
void checkVoice();
setInterval(() => void checkVoice(), 60_000).unref();
const health = () => JSON.stringify({ ok: true, channels: { telegram: Boolean(cfg.telegramToken && cfg.telegramChatId), voice } });
const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

// The board's pairing (its flow's pair_url): POST mints a code and its t.me link, with the board's pair token as bearer;
// GET says whether a chat is paired and when it last was (no secret in it, like /healthz).
async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") return json(res, 200, { paired: pairing.paired(), paired_at: pairing.pairedAt() });
  if (req.method !== "POST") return void res.writeHead(405).end();
  if (!authorized(req, pairToken)) return void res.writeHead(401).end();
  if (!cfg.telegramToken) return json(res, 409, { error: "Save the bot token first." });
  try {
    const username = await botUsername(cfg.telegramToken);
    const code = pairing.mint();
    return json(res, 200, { code, link: `https://t.me/${username}?start=${code}` });
  } catch (err) {
    return json(res, 502, { error: (err as Error).message });
  }
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(health());
  if (url.pathname === "/pair") return void (await pair(req, res));
  // The paired chat's id for chat-lane (its lane bots answer only that chat). Not a secret: Telegram, not the sender, says
  // which chat an update comes from, so knowing the id lets nobody speak as the owner.
  if (url.pathname === "/owner-chat" && req.method === "GET") return json(res, 200, { chat_id: store.ownerChat() ?? null });
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
    const server = buildServer(store, cfg, caller && { id: caller.agent, name: caller.name, key: caller.key, roles: caller.roles, assertion: String(req.headers["x-aidenhq-caller"]) }, Boolean(caller?.roles.includes("kernel.trial")));
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

if (!cfg.telegramToken) log.warn("TELEGRAM_NOTIFY_BOT_TOKEN not set; the Telegram chat is off (notify_owner still reaches the board chat)");
else {
  if (!cfg.telegramChatId) log.warn("no Telegram chat is paired yet: pair one from the board");
  const withButtons = async (text: string, markup: unknown) => {
    const out: { id?: number } = {};
    return (await postTelegram(cfg, text, markup, undefined, undefined, undefined, out)) && (out.id ?? true);
  };
  // Cards: pending cards and their tokens from the kernel (fresh tokens for all of them once, at start), the list for
  // Approve all, and each card's outcome; and the kernel's one-shot notices (reset links, digest, owner lines).
  let resync = true;
  const cards = async () => {
    if (!cfg.telegramChatId) return; // nothing is taken from the kernel until a chat is paired (reset links wait for it)
    try {
      const r = await syncCards(kernel, store, withButtons, decideSetting, resync);
      resync = false;
      await sendBatch(r.cards, store, withButtons, (id, text) => editTelegram(cfg, id, text)).catch((err) => log.warn({ err: String(err) }, "approval batch list failed"));
      await sendOutcomes(r.finished, store, (id, text) => editTelegram(cfg, id, text), r.ended);
    } catch (err) {
      log.warn({ err: String(err) }, "approval cards failed");
    }
    await sendNotices(kernel, (text) => postTelegram(cfg, text)).catch((err) => log.warn({ err: String(err) }, "owner notices failed"));
    // Slack DMs that failed, handed back by channel-slack: sent here instead.
    for (const m of await kernel.drain().catch(() => [])) await postTelegram(cfg, m.text);
  };
  void cards();
  setInterval(cards, 20_000).unref();
  const whisperUrl = process.env.WHISPER_URL ?? "";
  // A plain message to one chat (pairing's answers, which may go to a chat that isn't the owner's).
  const sendTo = (chatId: string, text: string) =>
    fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(15_000) });
  void startTelegramPoll(cfg, store, chat, log, {
    start: (u) => handleStart(u, pairing, store, sendTo),
    command: async (text) => (text.startsWith("/") ? quickCommand(text, (_m, p) => kernel.read(p), await chat.company()) : null),
    // null: the voice module is off (the owner is told how to turn it on).
    transcribe: async (fileId: string) => ((await voiceOn(whisperUrl)) ? transcribe(cfg.telegramToken, whisperUrl, fileId) : null),
    reply: (r) => postTelegram(cfg, r.text, buttonsMarkup(store, r.actions ?? [])),
    stop: chat.stop,
    approvals: { kernel, setting: decideSetting },
  });
  // The digest of routine crew messages: one message per slot, sent to the owner's Slack DM (else Telegram).
  const digest = () => void flushDigest(store, cfg.attention!, async (text) => ((await cfg.toSlack?.(text).catch(() => false)) ?? false) || postTelegram(cfg, text, undefined, store), Date.now()).catch(() => undefined);
  setInterval(digest, 5 * 60_000).unref();
  startWatch((p) => kernel.read(p), { store, notify: async (text) => (await notifyOwner(store, cfg, { text, priority: "normal", channel: "telegram" })).sent }, log);
}

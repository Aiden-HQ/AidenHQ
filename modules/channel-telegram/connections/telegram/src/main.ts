// channel-telegram: the owner's Telegram (spec §3.3.4 channel@1). The owner's chat comes in through the bot (long polling) and
// goes to the kernel as owner messages; approval cards come from the kernel with this channel's single-use decision tokens;
// and it is a transport of the owner's router (owner-channel): the kernel sends it one owner message at a time
// (POST /transport/send, send.ts). This service holds only the bot token and its own kernel token: no control-plane key,
// no decide key.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import pino from "pino";
import { applyButtons, sendBatch, sendOutcomes, syncCards } from "./approvals.js";
import { makeChat, startTelegramPoll } from "./chat.js";
import { quickCommand } from "./commands.js";
import { kernelClient } from "./kernel.js";
import { openStore } from "./store.js";
import { CODE_TTL_MS, botUsername, createPairing, handleStart, seedOwnerChat } from "./pair.js";
import { buttonsMarkup } from "./telegram.js";
import { editTelegram, postTelegram, transportSend, type TgConfig } from "./send.js";
import { transcribe, voiceOn } from "./voice.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "channel-telegram" }, redact: ["authorization", "*.authorization", "token", "*.token"] });
const kernelUrl = process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
// Secrets come from NAME_FILE (a compose secret) or NAME.
const env = (name: string): string => {
  const file = process.env[`${name}_FILE`];
  return (file ? readFileSync(file, "utf8") : (process.env[name] ?? "")).trim();
};

const port = Number(process.env.PORT ?? 8089);
// Its own token at the kernel, and the kernel's bearer on /transport/send.
const inboundToken = env("CHANNEL_TOKEN");
if (!inboundToken) throw new Error("CHANNEL_TOKEN(_FILE) is required");
const kernel = kernelClient(kernelUrl, inboundToken);
const store = openStore(process.env.TELEGRAM_DB ?? "/data/telegram.sqlite");
// The owner chat is this service's own state, set by pairing (pair.ts); an id from the host's .env is taken once (upgrade).
seedOwnerChat(store, env("TELEGRAM_OWNER_CHAT_ID"), (msg) => log.info(msg));
const pairing = createPairing(store);
const pairToken = env("PAIR_TOKEN");
const cfg: TgConfig & { telegramToken: string; telegramChatId: string } = {
  telegramToken: env("TELEGRAM_NOTIFY_BOT_TOKEN"),
  get telegramChatId() {
    return store.ownerChat() ?? "";
  },
  taskUrl: env("TELEGRAM_TASK_URL"),
  boardUrl: env("BOARD_LAN_URL"),
};
const chat = makeChat(cfg, store, kernel, log);

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
    // expires_in (seconds) is this service's own code lifetime, so the board times its screen by the live value, not a copy.
    return json(res, 200, { code, link: `https://t.me/${username}?start=${code}`, expires_in: CODE_TTL_MS / 1000 });
  } catch (err) {
    return json(res, 502, { error: (err as Error).message });
  }
}

const http = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return void res.writeHead(400).end(); }
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(health());
  if (url.pathname === "/pair") return void (await pair(req, res));
  // The paired chat's id for chat-lane (its lane bots answer only that chat). Not a secret: Telegram, not the sender, says
  // which chat an update comes from, so knowing the id lets nobody speak as the owner.
  if (url.pathname === "/owner-chat" && req.method === "GET") return json(res, 200, { chat_id: store.ownerChat() ?? null });
  if (url.pathname !== "/transport/send") return void res.writeHead(404).end();
  if (!authorized(req)) return void res.writeHead(401).end();
  if (req.method !== "POST") return void res.writeHead(405).end();
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const m = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof m.text !== "string" || !m.text) return json(res, 400, { error: "send {kind, text, head?, actions?, asks?}" });
    return json(res, 200, await transportSend(cfg, store, m));
  } catch (err) {
    log.error({ err: (err as Error).message }, "transport send failed");
    if (!res.headersSent) res.writeHead(500).end();
  }
});

http.listen(port, "0.0.0.0", () => log.info({ port }, "channel-telegram listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));

if (!cfg.telegramToken) log.warn("TELEGRAM_NOTIFY_BOT_TOKEN not set; the Telegram chat is off (owner messages go to the board and other channels)");
else {
  if (!cfg.telegramChatId) log.info("no Telegram chat is paired yet: a private message is answered with how to pair");
  const withButtons = async (text: string, markup: unknown) => {
    const out: { id?: number } = {};
    return (await postTelegram(cfg, text, markup, undefined, undefined, undefined, out)) && (out.id ?? true);
  };
  // Cards: pending cards and their tokens from the kernel (fresh tokens for all of them once, at start), the list for
  // Approve all, and each card's outcome.
  let resync = true;
  const cards = async () => {
    if (!cfg.telegramChatId) return; // nothing is taken from the kernel until a chat is paired
    try {
      const r = await syncCards(kernel, store, withButtons, resync);
      resync = false;
      await sendBatch(r.cards, store, withButtons, (id, text) => editTelegram(cfg, id, text)).catch((err) => log.warn({ err: String(err) }, "approval batch list failed"));
      await sendOutcomes(r.finished, store, (id, text) => editTelegram(cfg, id, text), r.ended);
    } catch (err) {
      log.warn({ err: String(err) }, "approval cards failed");
    }
  };
  void cards();
  setInterval(cards, 20_000).unref();
  const whisperUrl = process.env.WHISPER_URL ?? "";
  // A plain message to one chat (pairing's answers, which may go to a chat that isn't the owner's).
  const sendTo = (chatId: string, text: string) =>
    fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(15_000) });
  void startTelegramPoll(cfg, store, chat, log, {
    start: (u) => handleStart(u, pairing, store, sendTo, log),
    command: async (text) => {
      if (!text.startsWith("/")) return null;
      const r = await quickCommand(text, (_m, p) => kernel.read(p), await chat.company(), kernel.openTasks);
      return r?.applyTo ? { ...r, markup: await applyButtons(kernel, store, r.applyTo).catch(() => undefined) } : r;
    },
    // null: the voice module is off (the owner is told how to turn it on).
    transcribe: async (fileId: string) => ((await voiceOn(whisperUrl)) ? transcribe(cfg.telegramToken, whisperUrl, fileId) : null),
    reply: (r) => postTelegram(cfg, r.text, r.markup ?? buttonsMarkup(store, r.actions ?? [])),
    stop: chat.stop,
    approvals: { kernel },
  });
}

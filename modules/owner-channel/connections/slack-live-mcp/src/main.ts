// slack-live-mcp: Socket Mode listener -> SQLite buffer, a debounced triage webhook poke, and two MCP
// tools (slack_pending_events, notify_owner). Relays Slack events and sends urgent DMs.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { boardClient, sendBatch, sendCards, sendOutcomes, sendResetLinks } from "./approvals.js";
import { boardSuccessor, makeChat, startTelegramPoll, type ChatConfig } from "./chat.js";
import { quickCommand } from "./commands.js";
import { isOwnerComment, taskForNotify, ownerViaOf } from "./threads.js";
import { buttonsMarkup } from "./telegram.js";
import { transcribe } from "./voice.js";
import { buildServer, trialGuard, trialOf } from "./mcp.js";
import { startSocket } from "./socket.js";
import { openStore } from "./store.js";
import { makePostReply, notifyOwner, postTelegram, editTelegram, type NotifyConfig } from "./urgent.js";
import { startWatch } from "./watch.js";
import { makeAuthorize } from "./agent-auth.js";
import { SourceStore } from "./source-store.js";
import { slackTee, startGapSync } from "./sources.js";
import { laneConfig } from "./lane/config.js";
import { makeLane } from "./lane/lane.js";
import { laneRoutes, startLaneTelegram, startWakes, telegramSend } from "./lane/serve.js";
import { openLaneStore } from "./lane/store.js";
import { makeTools } from "./lane/tools.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "slack-live-mcp" }, redact: ["authorization", "*.authorization", "token", "*.token"] });
// Who is calling, and may it use this tool: the run key against the grants table.
const authorize = makeAuthorize({ log });
// Secrets come from NAME_FILE (a compose secret) or NAME.
const env = (name: string): string => {
  const file = process.env[`${name}_FILE`];
  return (file ? readFileSync(file, "utf8") : (process.env[name] ?? "")).trim();
};

const port = Number(process.env.PORT ?? 8089);
const inboundToken = env("MCP_BEARER_TOKEN");
if (!inboundToken) throw new Error("MCP_BEARER_TOKEN(_FILE) is required");
const store = openStore(process.env.SLACK_LIVE_DB ?? "/data/slack-live.sqlite");
const cfg = { botToken: env("SLACK_BOT_TOKEN"), ownerId: env("OWNER_SLACK_USER_ID"), cooldownMs: Number(process.env.URGENT_COOLDOWN_MIN ?? 60) * 60_000, telegramToken: env("TELEGRAM_NOTIFY_BOT_TOKEN"), telegramChatId: env("TELEGRAM_OWNER_CHAT_ID"), taskUrl: env("TELEGRAM_TASK_URL"), resolveTask: undefined as NotifyConfig["resolveTask"], postReply: undefined as NotifyConfig["postReply"], ownerLastAt: undefined as NotifyConfig["ownerLastAt"], brakeOn: undefined as NotifyConfig["brakeOn"], muteFyi: process.env.TELEGRAM_FYI === "mute" };
const postCfg = { botToken: cfg.botToken, allowed: new Set((process.env.SLACK_POST_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) };
const ignored = new Set((process.env.IGNORE_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

// The fast chat lane (lane/lane.ts): agents with a `chat:` block, from the setup-written lane config.
const laneStore = openLaneStore(process.env.LANE_DB ?? "/data/lane.sqlite");
const laneAgents = laneConfig(process.env.LANE_CONFIG_FILE, (msg) => log.warn(msg));
const lane = makeLane({
  store: laneStore,
  agents: laneAgents,
  tools: makeTools(),
  gatewayUrl: process.env.AIDENHQ_GATEWAY_URL ?? "http://10.231.0.1:8201",
  laneSecret: env("GATEWAY_LANE_SECRET"),
  timezone: process.env.OWNER_TIMEZONE || "UTC",
  ownerName: process.env.OWNER_NAME || "the owner",
  deliver: async (agent, conversation, text) => {
    const chat = /^telegram:(-?\d+)$/.exec(conversation)?.[1];
    if (chat && agent.telegramToken) await telegramSend(agent.telegramToken, chat, text);
  },
  log,
});
const laneTools = { store: laneStore, lane, agents: laneAgents, timezone: process.env.OWNER_TIMEZONE || "UTC" };
const routeLane = laneRoutes({ lane, store: laneStore, agents: laneAgents, token: env("BOARD_INTERNAL_TOKEN"), log });

// At most one triage webhook per 60 s; signed like scripts/trigger-meeting-scan.sh.
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
  }, Math.max(0, lastPoke + 60_000 - Date.now()));
}

function authorized(req: IncomingMessage): boolean {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(inboundToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

// Which owner channels are set up (the board's Settings shows them): booleans only, never a token.
const health = JSON.stringify({ ok: true, channels: { telegram: Boolean(cfg.telegramToken && cfg.telegramChatId), slack: Boolean(env("SLACK_APP_TOKEN") && cfg.botToken), voice: Boolean(process.env.WHISPER_URL) } });

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(health);
  if (await routeLane(req, res, url)) return;
  if (url.pathname !== "/mcp") return void res.writeHead(404).end();
  if (!authorized(req)) return void res.writeHead(401).end();
  if (req.method !== "POST") return void res.writeHead(405).end();
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const auth = await authorize(req, body);
    if (!auth.ok) return void res.writeHead(auth.status, { "content-type": "application/json" }).end(JSON.stringify(auth.body));
    // The caller (agent-auth's whoami) and its key: notify_owner(task) posts the reply on the chat as that agent.
    const key = String(req.headers["x-agent-key"] ?? "");
    // An agent in trial ("draft, don't do") reaches the owner and its own chats only (the grants table's mark, exactly true).
    // The mark is read per call and an unreadable table refuses the guarded tools, never the non-trial behaviour.
    const callerId = auth.caller?.id;
    const guard = trialGuard(callerId ? () => trialOf(process.env.AIDENHQ_GRANTS_FILE, callerId) : undefined);
    if (guard.refusal) log.warn({ reason: guard.refusal }, "trial mark unreadable; guarded tools refuse");
    const server = buildServer(store, cfg, auth.caller && key ? { id: auth.caller.id, name: auth.caller.name, key } : undefined, postCfg, laneTools, guard);
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

http.listen(port, "0.0.0.0", () => log.info({ port }, "slack-live-mcp listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));

const appToken = env("SLACK_APP_TOKEN");

// Inbound chat bridge: only when the board key is mounted.
const boardUrl = process.env.BOARD_INTERNAL_URL ?? "";
const boardToken = env("BOARD_INTERNAL_TOKEN");
const decideKey = env("OWNER_DECIDE_KEY");
const chatCfg: ChatConfig = { paperclipUrl: process.env.PAPERCLIP_URL ?? "", boardKey: env("PAPERCLIP_BOARD_KEY"), companyId: process.env.PAPERCLIP_COMPANY_ID ?? "", telegramToken: cfg.telegramToken, telegramChatId: cfg.telegramChatId, ...(boardUrl && boardToken && decideKey.length >= 32 ? { successor: boardSuccessor(boardUrl, boardToken, decideKey) } : {}) };
const deliver = chatCfg.boardKey && chatCfg.paperclipUrl ? makeChat(chatCfg, store, log) : undefined;
// notify_owner(task): the task's agent heads the message (looked up here, never taken from the text).
if (deliver) {
  cfg.resolveTask = async (identifier) => {
    const issue = await deliver.api("GET", `/api/issues/${encodeURIComponent(identifier)}`);
    const company = await deliver.company();
    const [agents, live] = await Promise.all([deliver.api("GET", `/api/companies/${company}/agents`), deliver.api("GET", `/api/companies/${company}/live-runs`)]);
    const found = taskForNotify({ id: String(issue.id), assigneeAgentId: issue.assigneeAgentId ?? null }, live, agents);
    if (!found) return undefined;
    const commentsOf = async (id: string) => {
      const comments = await deliver.api("GET", `/api/issues/${encodeURIComponent(id)}/comments`).catch(() => []);
      const list = (Array.isArray(comments) ? comments : (comments?.comments ?? [])) as { body: string; authorType?: string; createdAt: string }[];
      return [...list].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    };
    const parentId = issue.parentId ? String(issue.parentId) : undefined;
    const parentIssue = parentId ? await deliver.api("GET", `/api/issues/${encodeURIComponent(parentId)}`).catch(() => null) : null;
    const parent = parentIssue ? { issue: parentIssue, comments: await commentsOf(parentId!) } : undefined;
    return { ...found, ownerVia: ownerViaOf(issue, await commentsOf(String(issue.id)), parent) };
  };
  // The loop brake: when the owner last wrote on the task (their own words, never the runner's or a notice).
  cfg.ownerLastAt = async (identifier) => {
    const comments = await deliver.api("GET", `/api/issues/${encodeURIComponent(identifier)}/comments?order=desc&limit=100`);
    const list = (Array.isArray(comments) ? comments : (comments?.comments ?? [])) as { body: string; authorType?: string; authorAgentId?: string; createdAt: string }[];
    const at = list.filter(isOwnerComment).map((c) => Date.parse(c.createdAt)).filter(Number.isFinite);
    return at.length ? Math.max(...at) : undefined;
  };
}
cfg.brakeOn = () => {
  try {
    return JSON.parse(readFileSync(process.env.AIDENHQ_GRANTS_FILE ?? "", "utf8"))?.loop_brake !== "off";
  } catch {
    return true;
  }
};
// The agent's reply on its chat, posted with its own key (never the board key, which writes as the owner).
// From a computer (a launcher run token), the launcher posts it with that run's own Paperclip credential.
if (chatCfg.paperclipUrl)
  cfg.postReply = makePostReply({ paperclipUrl: chatCfg.paperclipUrl, launcherUrl: process.env.AIDENHQ_LAUNCHER_URL ?? "", warn: (msg, status) => log.warn({ status }, msg) });
// Approval cards: pending records become Telegram cards; taps and exact typed replies decide them with the decide key.
const board = boardUrl && boardToken && decideKey.length >= 32 ? boardClient(boardUrl, boardToken, decideKey) : undefined;
if (!board) log.warn("BOARD_INTERNAL_URL/BOARD_INTERNAL_TOKEN/OWNER_DECIDE_KEY not set; approvals from Telegram are off (tap them on the board)");
if (board && cfg.telegramToken && cfg.telegramChatId) {
  const withButtons = async (text: string, markup: unknown) => {
    const out: { id?: number } = {};
    return (await postTelegram(cfg, text, markup, undefined, undefined, undefined, out)) && (out.id ?? true);
  };
  const cards = () =>
    Promise.all([
      // Then, when 2 or more wait and one is new, a list of them with Approve all / Reject all (batch approvals).
      sendCards(board, store, withButtons)
        .catch((err) => log.warn({ err: String(err) }, "approval cards failed"))
        .then(() => sendBatch(board, store, withButtons, (id, text) => editTelegram(cfg, id, text)))
        .catch((err) => log.warn({ err: String(err) }, "approval batch list failed")),
      sendResetLinks(board, (text) => postTelegram(cfg, text)).catch((err) => log.warn({ err: String(err) }, "reset links failed")),
      // The daily approvals digest: the board hands it over once, from 21:00 in the owner's timezone.
      board.digest().then(async (text) => void (text ? await postTelegram(cfg, text) : undefined)).catch((err) => log.warn({ err: String(err) }, "approvals digest failed")),
      // Graded tasks the grader escalated (graded done): one line each, handed over once by the board.
      board.escalations().then(async (lines) => { for (const l of lines) await postTelegram(cfg, l); }).catch((err) => log.warn({ err: String(err) }, "owner notices failed")),
      sendOutcomes(board, store, (text) => postTelegram(cfg, text), (id, text) => editTelegram(cfg, id, text)).catch((err) => log.warn({ err: String(err) }, "approval outcomes failed")),
    ]);
  void cards();
  setInterval(cards, 20_000).unref();
}
startLaneTelegram({ lane, agents: laneAgents, ownerChatId: cfg.telegramChatId, getKv: (k) => store.getKv(k) ?? undefined, setKv: (k, v) => store.setKv(k, v), log });
// A wake on a task is a labelled notice there (posted with the board key, marked so it never counts as the owner's words).
startWakes({
  store: laneStore,
  lane,
  agents: laneAgents,
  noticeOnTask: async (task, text) => {
    if (!deliver) throw new Error("no Paperclip board key here");
    await deliver.api("POST", `/api/issues/${encodeURIComponent(task)}/comments`, { body: `${text}\n\n<!-- aidenhq-wake -->` });
  },
  log,
});
if (!deliver) log.warn("PAPERCLIP_BOARD_KEY/PAPERCLIP_URL not set; inbound chat disabled");
else if (cfg.telegramToken && cfg.telegramChatId) {
  const whisperUrl = process.env.WHISPER_URL ?? "";
  void startTelegramPoll(chatCfg, store, deliver, log, {
    command: async (text) => (text.startsWith("/") ? quickCommand(text, deliver.api, await deliver.company()) : null),
    ...(whisperUrl ? { transcribe: (fileId: string) => transcribe(cfg.telegramToken!, whisperUrl, fileId) } : {}),
    reply: (r) => postTelegram(cfg, r.text, buttonsMarkup(store, r.actions ?? [])),
    stop: deliver.stop,
    ...(board ? { approvals: board } : {}),
  });
}
if (chatCfg.boardKey && chatCfg.paperclipUrl) startWatch(chatCfg, { companyId: chatCfg.companyId || undefined, store, notify: async (text) => (await notifyOwner(store, cfg, { text, priority: "normal", channel: "both" })).sent }, log);
const commandChannel = process.env.OWNER_COMMAND_CHANNEL ?? "";
const chat = deliver && commandChannel && cfg.ownerId ? { ownerId: cfg.ownerId, channel: commandChannel, deliver } : undefined;

// src_slack (shared sources): every event teed to the warehouse, and a gap sync with the owner's user token. Off until the
// warehouse password (WAREHOUSE_PASSWORD_FILE) is there; the gap sync also needs SLACK_USER_TOKEN.
const sources = SourceStore.fromEnv("slack");
const tee = sources ? slackTee(sources, log) : undefined;
const userToken = env("SLACK_USER_TOKEN");
if (sources && userToken) startGapSync(sources, userToken, log);
else log.warn(sources ? "SLACK_USER_TOKEN not set; src_slack gets live events only (no gap sync)" : "warehouse not configured; src_slack is off");

if (appToken) void startSocket({ appToken, store, ignored, onKept: poke, ...(chat ? { chat } : {}), ...(tee ? { tee } : {}), log });
else log.warn("SLACK_APP_TOKEN not set; not listening to Slack");

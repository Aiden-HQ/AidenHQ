// Inbound chat bridge: the owner's Telegram (getUpdates long polling) and Slack self-DM messages become
// comments on one rolling "Chat with <owner>" Paperclip issue per day (owner's timezone), assigned to the Chief of
// Staff. Comments use the board key, so they are authored as the owner; forwarded text is fenced as data.
// Owner name, timezone and company come from the instance settings (OWNER_NAME, OWNER_TIMEZONE, OWNER_COMPANY).
export const OWNER = {
  name: process.env.OWNER_NAME || "the owner",
  timezone: process.env.OWNER_TIMEZONE || "UTC",
  company: process.env.OWNER_COMPANY || "work",
};
import type { Logger } from "pino";
import type { Store } from "./store.js";
import { COMMANDS, type QuickReply } from "./commands.js";
import { approvalPress, decideByReply, decideCard, decideList, decidedText, parseReply, type DecideSetting } from "./approvals.js";
import type { Kernel } from "./kernel.js";
import { KernelError } from "./aidenhq-sdk/kernel-client.js";
import { fromAnswerCallback, fromTelegramCallback, type AnswerPress } from "./telegram.js";
import { chatAgentOf, routeOwnerMessage, type AgentLite } from "./threads.js";
import { markOwnerMessage } from "./send.js";

export interface ChatConfig {
  telegramToken: string;
  telegramChatId: string;
}
export interface ChatMessage {
  source: "telegram" | "slack";
  text: string;
  forward?: { from: string; date: string };
  voice?: boolean; // transcribed from a voice note: words may be misheard
  replyTo?: string; // Telegram: the id of the message this one replies to
  task?: string; // delivered to exactly this task (an answer bound to its wait), whatever replyTo maps to
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

// Telegram update -> ChatMessage; null unless it is a text/caption message from the owner chat.
export function fromTelegram(update: unknown, ownerChatId: string): ChatMessage | null {
  const msg = rec(rec(update).message);
  const text = str(msg.text) || str(msg.caption);
  if (!ownerChatId || String(rec(msg.chat).id) !== ownerChatId || !text) return null;
  const f = rec(msg.forward_origin);
  const replyTo = rec(msg.reply_to_message).message_id;
  if (!f.type) return { source: "telegram", text, ...(replyTo ? { replyTo: String(replyTo) } : {}) };
  const u = rec(f.sender_user);
  const from =
    [u.first_name, u.last_name].filter(Boolean).join(" ") + (u.username ? ` (@${u.username})` : "") ||
    str(f.sender_user_name) || str(rec(f.chat).title) || str(rec(f.sender_chat).title) || "unknown";
  return { source: "telegram", text, forward: { from, date: f.date ? new Date(f.date * 1000).toISOString() : "unknown" } };
}

/** How often one unpaired chat is told how to pair again: enough to help a stranger, not enough to spam one. */
export const UNPAIRED_NOTICE_MS = 10 * 60_000;
/** How many pairing notices may be in flight at once. */
export const UNPAIRED_NOTICE_MAX_INFLIGHT = 4;
/** How many pairing notices the bot sends in any one minute, however fast the sends answer. */
export const UNPAIRED_NOTICE_MAX_PER_MINUTE = 6;
/** The window the aggregate budget counts over. */
export const UNPAIRED_NOTICE_WINDOW_MS = 60_000;
export const UNPAIRED_NOTICE = "This bot isn't paired with AidenHQ yet. Open the board, then Settings, then the Telegram setup step, and tap its pairing link.";

/** One poll's pairing notices: which chats were told when, how many sends are still out, and when the recent ones went. */
export interface UnpairedLimiter {
  sent: Map<string, number>;
  inflight: number;
  recent: number[];
}

/**
 * When the bot isn't paired, a private text message is answered once with how to pair it (and logged); nothing on this path
 * reaches the kernel. Returns whether this update was such a message, and sends at most one notice per chat per
 * UNPAIRED_NOTICE_MS, so a stranger writing over and over isn't answered each time. At most UNPAIRED_NOTICE_MAX_INFLIGHT
 * notices are out at once, and at most UNPAIRED_NOTICE_MAX_PER_MINUTE in any UNPAIRED_NOTICE_WINDOW_MS; beyond either they
 * are dropped, so a burst of chats can't use up Telegram's bot-wide send quota just as the owner pairs. `limiter` is held
 * for the whole poll: a fresh one per update would let every update through.
 */
export async function answerUnpaired(
  update: unknown,
  send: (chatId: string, text: string) => Promise<unknown>,
  log: { info: (fields: { chatId: string }, message: string) => void },
  limiter: UnpairedLimiter = { sent: new Map<string, number>(), inflight: 0, recent: [] },
  now = Date.now(),
): Promise<boolean> {
  const msg = rec(rec(update).message);
  const chat = rec(msg.chat);
  const text = str(msg.text) || str(msg.caption);
  if (!text || chat.type !== "private" || (typeof chat.id !== "number" && typeof chat.id !== "string")) return false;
  const chatId = String(chat.id);
  const { sent } = limiter;
  const last = sent.get(chatId);
  if (last !== undefined && now - last < UNPAIRED_NOTICE_MS) return false;
  if (limiter.inflight >= UNPAIRED_NOTICE_MAX_INFLIGHT) return false;
  // The aggregate budget: slots turning over fast still can't exceed a fixed rate for the whole bot.
  limiter.recent = limiter.recent.filter((at) => now - at < UNPAIRED_NOTICE_WINDOW_MS);
  if (limiter.recent.length >= UNPAIRED_NOTICE_MAX_PER_MINUTE) return false;
  // Forget chats whose window has passed, so a stranger writing once from many chats can't grow the map forever.
  for (const [id, at] of sent) if (now - at >= UNPAIRED_NOTICE_MS) sent.delete(id);
  sent.set(chatId, now);
  limiter.recent.push(now);
  limiter.inflight++;
  log.info({ chatId }, "unpaired chat messaged the bot; told how to pair");
  // Released however the send ends, or a failed one would hold a slot for good.
  try {
    await send(chatId, UNPAIRED_NOTICE).catch(() => undefined);
  } finally {
    limiter.inflight--;
  }
  return true;
}

/** The message a voice note replies to, so it is routed like typed text. */
export function voiceReplyTo(update: unknown): string | undefined {
  const id = rec(rec(rec(update).message).reply_to_message).message_id;
  return id ? String(id) : undefined;
}

/** The file id of a voice note recorded in the owner chat; null for anything else (an attached audio file may be someone else's voice). */
export function voiceFileId(update: unknown, ownerChatId: string): string | null {
  const msg = rec(rec(update).message);
  if (!ownerChatId || String(rec(msg.chat).id) !== ownerChatId || msg.forward_origin) return null;
  return str(rec(msg.voice).file_id) || null;
}

/**
 * Delivers the owner's messages through the kernel (POST /v1/channel/owner-message), which posts them to the control plane as
 * the owner, stamped as this channel's: a reply continues that agent's chat, @name starts a new chat with that agent,
 * anything else goes to Aiden's daily chat (the kernel finds or makes it). Throws on failure so the caller can retry.
 */
export function makeChat(cfg: ChatConfig, store: Store, kernel: Pick<Kernel, "ownerMessage" | "read" | "stop">, log: Logger) {
  let company: string | undefined;
  const companyId = async (): Promise<string> => {
    if (company) return company;
    const c = ((await kernel.read("/api/companies")) as any[]).find((x) => x.status !== "archived" && x.name === OWNER.company)?.id;
    if (!c) throw new Error(`company ${OWNER.company} not found`);
    return (company = String(c));
  };
  let agentCache: { at: number; list: AgentLite[] } | undefined;
  const agents = async (): Promise<AgentLite[]> => {
    if (agentCache && Date.now() - agentCache.at < 300_000) return agentCache.list;
    return (agentCache = { at: Date.now(), list: await kernel.read(`/api/companies/${await companyId()}/agents`) }).list;
  };
  const deliver = async (m: ChatMessage): Promise<void> => {
    const route = m.task ? ({ kind: "reply", issueId: m.task } as const) : m.source === "telegram" && !m.forward ? routeOwnerMessage(m.text, m.replyTo ? { chatId: cfg.telegramChatId, messageId: m.replyTo } : undefined, store, await agents()) : ({ kind: "aiden" } as const);
    const body = { sender: "owner", text: m.text, ...(m.voice ? { voice: true as const } : {}), ...(m.forward ? { forward: m.forward } : {}) };
    if (route.kind === "reply") {
      // The chat's recorded agent takes it back if nobody holds it now (the kernel reassigns only an unassigned chat).
      const issue = await kernel.read(`/api/issues/${encodeURIComponent(route.issueId)}`).catch(() => null);
      const agent = issue && !issue.assigneeAgentId ? chatAgentOf(issue.description) : undefined;
      await kernel.ownerMessage({ ...body, task: route.issueId, ...(agent ? { agent } : {}) });
    } else if (route.kind === "new") {
      const r = await kernel.ownerMessage({ ...body, agent: route.agentId, ...(route.note ? { note: route.note } : {}) });
      log.info({ issue: r.task?.identifier }, "new chat from the owner");
    } else await kernel.ownerMessage(body);
    markOwnerMessage(store);
  };
  /** Stop: cancels the runs of the chat a message belongs to. Returns what to tell the owner. */
  const stop = async (replyTo: string | undefined): Promise<string> => {
    const issueId = replyTo ? store.threadOf("telegram", cfg.telegramChatId, replyTo) : undefined;
    if (!issueId) return "Reply /stop to the message of the chat you want to stop.";
    const r = await kernel.stop(issueId);
    return r.stopped ? "Stopped." : "Nothing was running in that chat.";
  };
  return Object.assign(deliver, { stop, company: companyId });
}

/** The answer to a voice note while the voice module is off. */
export const VOICE_OFF = "Voice notes are off. To turn them on, install Voice notes from the board's Modules page (or ask Aiden). Until then, please type it.";

/** What the Telegram poll can do besides delivering text: quick commands and voice notes. */
export interface TelegramExtras {
  command: (text: string) => Promise<QuickReply | null>;
  /** The note's text; null when voice notes are off (the voice module isn't installed). */
  transcribe?: (fileId: string) => Promise<string | null>;
  reply: (r: QuickReply) => Promise<unknown>;
  stop?: (replyTo: string | undefined) => Promise<string>;
  /** Approval cards' buttons and exact typed replies, decided with the tokens the kernel sent this channel. */
  approvals?: { kernel: Pick<Kernel, "decide" | "cards" | "claimAnswer" | "releaseAnswer">; setting: DecideSetting };
  /** `/start <code>` from any chat (pair.ts): true when the update was a pairing attempt, handled there. */
  start?: (update: unknown) => Promise<boolean>;
}

/**
 * A press on an answer button: claimed at the kernel first. "sent": delivered to the claimed task. "stale": the question is no
 * longer the open one (nothing delivered, the button retires). "taken": another answer holds the claim now (nothing delivered,
 * the button comes back: that answer may still fail). A claim or delivery that fails gives the claim and the button back and
 * rethrows, so the update is retried.
 */
export async function pressAnswer(a: AnswerPress, kernel: Pick<Kernel, "claimAnswer" | "releaseAnswer">, store: Store, deliver: (m: ChatMessage) => Promise<void>): Promise<"sent" | "stale" | "taken"> {
  const undo = () => store.setKv(`ans:${a.data}`, a.stored);
  const claimed = await kernel.claimAnswer(a.task, a.since).catch((err) => (undo(), Promise.reject(err)));
  if (claimed === "taken") undo();
  if (claimed !== "ok") return claimed;
  await deliver({ ...a.message, task: a.task }).catch(async (err) => { await kernel.releaseAnswer(a.task, a.since).catch(() => {}); undo(); throw err; });
  return "sent";
}

export async function startTelegramPoll(cfg: ChatConfig, store: Store, deliver: (m: ChatMessage) => Promise<void>, log: Logger, extras?: TelegramExtras): Promise<void> {
  const base = `https://api.telegram.org/bot${cfg.telegramToken}`;
  const tg = (method: string, body: unknown) =>
    fetch(`${base}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  log.info("telegram polling started");
  // One rate limiter for the whole poll: a fresh map per update would let every update through.
  const unpaired = { sent: new Map<string, number>(), inflight: 0, recent: [] as number[] };
  // The "/" menu in Telegram.
  if (extras) await tg("setMyCommands", { commands: COMMANDS });
  for (;;) {
    let handling: number | undefined;
    try {
      const offset = Number(store.getKv("tg_offset") ?? 0);
      const q = new URLSearchParams({ timeout: "30", offset: String(offset), allowed_updates: '["message","callback_query"]' });
      const res = await fetch(`${base}/getUpdates?${q}`, { signal: AbortSignal.timeout(45_000) });
      const data = (await res.json()) as { ok?: boolean; result?: { update_id: number }[] };
      if (!data.ok) throw new Error(`getUpdates ${res.status}`);
      for (const u of data.result ?? []) {
        handling = u.update_id;
        if (await extras?.start?.(u)) {
          store.setKv("tg_offset", String(u.update_id + 1));
          continue;
        }
        // Unpaired: a private chat is told how to pair (rate-limited and capped in flight), and nothing goes to the kernel.
        // Not awaited: a slow send to a stranger must not hold up the owner's own pairing or chat.
        if (!cfg.telegramChatId) void answerUnpaired(u, (chat_id, text) => tg("sendMessage", { chat_id, text }), log, unpaired);
        const m = fromTelegram(u, cfg.telegramChatId);
        const stopping = m && !m.forward && m.text.trim() === "/stop" && extras?.stop ? await extras.stop(m.replyTo) : null;
        // An exact typed reply decides the one card held for that task (typed here, never a voice note or a forward).
        const reply = m && !m.forward && extras?.approvals ? parseReply(m.text) : undefined;
        const unreachable = (err: Error) => ({ ok: false as const, reason: `couldn't reach the kernel (${err.message.slice(0, 100)}); try again, or decide it on the board` });
        const decided = reply ? { text: decidedText(await decideByReply(extras!.approvals!.kernel, store, reply.task, reply.decision, "owner", extras!.approvals!.setting).catch(unreachable), reply.decision) } : null;
        const quick = stopping ? { text: stopping } : decided ? decided : m && !m.forward && extras ? await extras.command(m.text) : null;
        if (quick) await extras!.reply(quick);
        else if (m) await deliver(m);
        const voice = extras && voiceFileId(u, cfg.telegramChatId);
        if (voice) {
          const heard = extras.transcribe ? await extras.transcribe(voice).catch((err) => (log.warn({ err: String(err) }, "transcription failed"), "")) : null;
          if (heard === null) await extras.reply({ text: VOICE_OFF });
          else if (!heard) await extras.reply({ text: "I couldn't make out that voice note. Please type it." });
          else {
            // Echoed first, so a misheard word is visible before anyone acts on it.
            await extras.reply({ text: `🎙 Heard: "${heard}"` });
            const replyTo = voiceReplyTo(u);
            await deliver({ source: "telegram", text: heard, voice: true, ...(replyTo ? { replyTo } : {}) });
          }
        }
        // A card's Approve or Reject (or a list's): each card decided with its own token; the buttons become the outcome.
        const card = extras?.approvals ? approvalPress(u, cfg.telegramChatId, store) : null;
        if (card) {
          const k = extras!.approvals!.kernel;
          const one = card.ids.length === 1;
          const r = one ? await decideCard(k, store, card.ids[0]!, card.decision, "owner").catch(unreachable) : undefined;
          const listText = one ? undefined : await decideList(k, store, card.ids, card.decision, "owner").catch((err: Error) => unreachable(err).reason);
          const failedToReach = r && !r.ok && /couldn't reach/.test(r.reason);
          if (failedToReach) store.setKv(`appr:${card.cb}`, JSON.stringify({ ids: card.ids, decision: card.decision })); // the button works again
          const label = one ? (r!.ok ? (r!.state === "rejected" ? "✗ Rejected" : "✓ Approved") : "⚠ Not decided") : card.decision === "approve" ? "✓ Approve all pressed" : "✗ Reject all pressed";
          if (!failedToReach) await tg("editMessageReplyMarkup", { chat_id: card.chatId, message_id: card.messageId, reply_markup: { inline_keyboard: [[{ text: label, callback_data: "done" }]] } });
          if (!one) store.setKv("batch:msg", "");
          await extras!.reply({ text: one ? decidedText(r!, card.decision) : String(listText) });
        }
        const press = card ? null : fromTelegramCallback(u, cfg.telegramChatId, store);
        if (press) {
          // Used up only once delivered: on failure the button comes back and the update is retried.
          await deliver(press.message).catch((err) => { store.setKv(`btn:${(u as any).callback_query.data}`, press.label); throw err; });
          // Confirm, and swap the buttons for the choice, so it can't be pressed twice.
          await tg("editMessageReplyMarkup", { chat_id: press.chatId, message_id: press.messageId, reply_markup: { inline_keyboard: [[{ text: `✓ ${press.label}`, callback_data: "done" }]] } });
        }
        // An answer to a task's open question (claimed first, see pressAnswer).
        const answer = card || press || !extras?.approvals ? null : fromAnswerCallback(u, cfg.telegramChatId, store);
        let said = press ? `Sent: ${press.label}` : undefined;
        if (answer) {
          const claimed = await pressAnswer(answer, extras!.approvals!.kernel, store, deliver);
          if (claimed !== "taken") await tg("editMessageReplyMarkup", { chat_id: answer.chatId, message_id: answer.messageId, reply_markup: { inline_keyboard: [[{ text: claimed === "sent" ? `✓ ${answer.label}` : "Already answered", callback_data: "done" }]] } });
          said = claimed === "sent" ? `Sent: ${answer.label}` : claimed === "stale" ? "Already answered, or the question changed." : "Another answer is being sent; try again in a moment.";
        }
        // A push test's inert button (send.ts `inert`): acknowledged, nothing else.
        if ((u as { callback_query?: { data?: string } }).callback_query?.data === "test") said = "Test received";
        const cbId = (u as { callback_query?: { id?: string } }).callback_query?.id;
        if (cbId) await tg("answerCallbackQuery", { callback_query_id: cbId, ...(said ? { text: said } : {}) });
        store.setKv("tg_offset", String(u.update_id + 1));
      }
    } catch (err) {
      // An update the kernel refuses for good (a deleted chat task, a removed agent) is skipped, or it blocks every later message.
      if (handling !== undefined && err instanceof KernelError && [400, 404, 422].includes(err.status)) {
        store.setKv("tg_offset", String(handling + 1));
        log.warn({ err: String(err).replace(cfg.telegramToken, "***"), update: handling }, "telegram update refused by the kernel; skipped");
        await extras?.reply({ text: "⚠ That message couldn't be delivered: the kernel refused it (its chat or agent may be gone). Send it again as a new message." }).catch(() => {});
        continue;
      }
      log.warn({ err: String(err).replace(cfg.telegramToken, "***") }, "telegram poll failed; retrying");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

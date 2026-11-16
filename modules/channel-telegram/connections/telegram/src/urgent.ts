import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { buttonsMarkup, escape, toTelegramHtml } from "./telegram.js";
import { stripPlaceholder } from "./mrkdwn.js";

export interface NotifyArgs {
  text: string;
  priority: "urgent" | "normal";
  permalink?: string | undefined;
  channel_id?: string | undefined;
  thread_ts?: string | undefined;
  ts?: string | undefined;
  received_at?: number | undefined;
  channel?: "telegram" | "slack" | "both" | "board" | undefined;
  actions?: string[] | undefined; // Telegram one-tap buttons; a press sends the label as the owner's message
  questions?: Question[] | undefined; // multiple choice: the board shows a form; Telegram/Slack get them spelled out
  escalate?: string | undefined; // urgent: why the thread got worse since its last page; re-pages through the cooldown
  task?: string | undefined; // the chat (task identifier) this message belongs to: its agent's name heads it; replies continue it
  kind?: NotifyKind | undefined; // decision: needs the owner (never braked); done: a finished result (the default); fyi: may be muted on Telegram
}
/** What a normal message is for: `decision` needs the owner (messages with questions are decisions), `done` a result, `fyi` news. */
export type NotifyKind = "decision" | "done" | "fyi";
export interface NotifyConfig {
  cooldownMs: number;
  telegramToken?: string;
  telegramChatId?: string;
  taskUrl?: string; // e.g. https://host/WOR/issues/{id}: task IDs in Telegram messages link here
  /** The task's id and its agent's name, from the control plane via the kernel (never from the message text). */
  resolveTask?: (identifier: string) => Promise<{ issueId: string; agentId?: string; agentName: string; ownerVia?: "board" | "telegram" | "slack" | undefined } | undefined>;
  /** Posts the reply on the chat as the calling agent (through the kernel, on this call's assertion), so the board shows what it said. */
  postReply?: (issueId: string, body: string, assertion: string) => Promise<boolean>;
  /** The kernel's loop brake (POST /v1/brake/notify): whether one more message about this task may go now. */
  brake?: (task: string, agent: string, decision: boolean) => Promise<{ allow: boolean; note?: string }>;
  /** The channel-telegram setting `telegram_fyi: mute`: `fyi` messages skip Telegram (they still land on the chat). */
  muteFyi?: boolean;
  /**
   * A normal message's Slack DM: filed in the kernel's outbox for channel-slack, which sends it (and hands a failed one back
   * here). False when channel-slack isn't installed: Telegram sends it instead.
   */
  toSlack?: (text: string) => Promise<boolean>;
}
export type NotifyResult = { sent: boolean; reason?: "cooldown" | "error" | "duplicate" | "limit" | "muted"; onChat?: boolean; note?: string };

/** Who called notify_owner: the agent, its key, and the kernel's assertion of this call (the reply is posted on it). */
export interface NotifyCaller {
  id: string;
  name?: string;
  key: string;
  assertion: string;
}

/** Posts an agent's reply on its chat through the kernel, as the agent whose call (assertion) this is. */
export function makePostReply(o: { kernelUrl: string; serviceKey: string; fetch?: typeof fetch; warn?: (msg: string, status?: number) => void }) {
  const f = o.fetch ?? fetch;
  return async (issueId: string, body: string, assertion: string): Promise<boolean> => {
    const res = await f(new URL(`/v1/cp/agent/api/issues/${encodeURIComponent(issueId)}/comments`, o.kernelUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${o.serviceKey}`, "x-aidenhq-caller": assertion, "content-type": "application/json" },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(40_000),
    }).catch(() => null);
    if (!res?.ok) o.warn?.("couldn't post the reply on its chat", res?.status);
    return Boolean(res?.ok);
  };
}

/** Marks an agent's comment as its visible reply to the owner (the board shows it as a message, not a run note). */
export const REPLY_MARKER = "<!-- aidenhq-reply -->";
/**
 * The comment that mirrors a notify_owner(task) message onto its chat: the text, the reply marker and, when the
 * message offers buttons, their labels (the board shows them as one-tap answers). Labels can't close the HTML comment.
 */
export function replyBody(text: string, actions: string[] = [], questions: Question[] = []): string {
  const safe = (x: string) => x.replace(/--+/g, "—").replace(/[<>]/g, "");
  const labels = actions.map(safe);
  const qs = questions.map((q) => ({ question: safe(q.question), options: q.options.map(safe), ...(q.multi ? { multi: true } : {}) }));
  return `${text}\n\n${REPLY_MARKER}${labels.length ? `\n<!-- aidenhq-actions:${JSON.stringify(labels)} -->` : ""}${qs.length ? `\n<!-- aidenhq-questions:${JSON.stringify(qs)} -->` : ""}`;
}

/** A multiple-choice question: the recommended option first; the owner may always answer in their own words instead. */
export type Question = { question: string; options: string[]; multi?: boolean | undefined };

/** The questions as text, for channels without a form (Telegram, Slack). */
export function spellOut(questions: Question[] = []): string {
  if (!questions.length) return "";
  const letter = (i: number) => String.fromCharCode(65 + i);
  const blocks = questions.map((q, n) => [`**${n + 1}. ${q.question}**${q.multi ? " (pick any)" : ""}`, ...q.options.map((o, i) => `- ${letter(i)}) ${o}${i === 0 ? " (recommended)" : ""}`)].join("\n"));
  return `\n\n${blocks.join("\n\n")}\n\nReply like "1A, 2B", or in your own words.`;
}

const DUPLICATE_MS = 10 * 60_000;

// A reply sent soon after another, with no new message from the owner in between (two wakes answering the same question,
// "working on it" then "done"), replaces the earlier Telegram message instead of stacking a second one. It goes as a
// new message (an edit wouldn't notify them) and the earlier one is deleted.
const EDIT_WINDOW_MS = 2 * 60_000;
/** Called for every message from the owner (any channel): the next reply is a new message again. */
export function markOwnerMessage(store: Store, now = Date.now()): void {
  store.setKv("owner:last_in", String(now));
}

// Telegram: escaped HTML with a small formatting subset (telegram.ts), optional one-tap buttons. If Telegram rejects
// the HTML, the same text goes again as plain text.
export async function postTelegram(cfg: NotifyConfig, text: string, markup?: unknown, store?: Store, now = Date.now(), chat?: { identifier: string; issueId: string; agentName: string }, out?: { id?: number }, asks = false): Promise<boolean> {
  if (!cfg.telegramToken || !cfg.telegramChatId) return false;
  const prev = store ? (JSON.parse(store.getKv("tg:last_out") || "null") as { at: number; id: number; buttons?: boolean; task?: string } | null) : null;
  // A message with buttons or questions is an open choice: never deleted. Only a message from the same chat is replaced.
  const replace = prev && !prev.buttons && prev.task === chat?.identifier && now - prev.at < EDIT_WINDOW_MS && prev.at > Number(store!.getKv("owner:last_in") ?? 0);
  const head = chat ? { html: `<b>${escape(chat.agentName)}</b> · ${escape(chat.identifier)}\n`, plain: `${chat.agentName} · ${chat.identifier}\n` } : { html: "", plain: "" };
  const call = (method: string, body: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${cfg.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, ...body }),
    }).catch(() => null);
  const send = (body: Record<string, unknown>) => call("sendMessage", { disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}), ...body });
  let res = await send({ text: head.html + toTelegramHtml(text.slice(0, 3500), cfg.taskUrl), parse_mode: "HTML" });
  if (!res?.ok) res = await send({ text: head.plain + text.slice(0, 4000) });
  if (!res?.ok) return false;
  if (replace) await call("deleteMessage", { message_id: prev!.id });
  const id = Number(((await res.json().catch(() => ({}))) as any)?.result?.message_id);
  // The window runs from the first message of a burst, so a steady stream still lands as separate messages.
  if (out && Number.isFinite(id)) out.id = id;
  if (store && Number.isFinite(id)) {
    store.setKv("tg:last_out", JSON.stringify({ at: replace ? prev!.at : now, id, buttons: Boolean(markup) || asks, ...(chat ? { task: chat.identifier } : {}) }));
    if (chat) store.setThread("telegram", cfg.telegramChatId, String(id), chat.issueId);
  }
  return true;
}

/** Replaces a sent message's text and drops its buttons (an approval card showing its outcome). */
export async function editTelegram(cfg: NotifyConfig, messageId: number, text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, message_id: messageId, text: toTelegramHtml(text.slice(0, 3500), cfg.taskUrl), parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }),
  }).catch(() => null);
  return Boolean(res?.ok);
}

/**
 * notify_owner on Telegram: one message (normal or urgent) to the owner chat, and with `task` the reply on its chat (the
 * board). The kernel's loop brake caps messages about one task between the owner's own words; a decision always goes.
 */
export async function notifyOwner(store: Store, cfg: NotifyConfig, a: NotifyArgs, now = Date.now(), caller?: NotifyCaller): Promise<NotifyResult> {
  try {
    a = { ...a, text: stripPlaceholder(a.text) };
    if (!a.text && !a.questions?.length) return { sent: false, reason: "error" };
    if (a.priority === "normal") {
      // The same message twice in a few minutes (a duplicate wake) reaches the owner once.
      const dupKey = `notify:${createHash("sha256").update(`${a.channel ?? "both"}\n${a.task ?? ""}\n${a.text}\n${JSON.stringify(a.questions ?? [])}`).digest("hex").slice(0, 32)}`;
      const last = Number(store.getKv(dupKey) ?? 0);
      if (last && now - last < DUPLICATE_MS) return { sent: true, reason: "duplicate" };
      const kind: NotifyKind = a.questions?.length ? "decision" : (a.kind ?? "done");
      // The loop brake (the kernel's count): fails open when the kernel doesn't answer.
      if (a.task && cfg.brake) {
        const b = await cfg.brake(a.task, caller?.id ?? "", kind === "decision").catch(() => ({ allow: true, note: undefined }));
        if (!b.allow) return { sent: false, reason: "limit", note: b.note ?? `Limit reached on ${a.task} since the owner last wrote there (or since UTC midnight). Nothing was sent; batch it into your next update, after they reply or tomorrow.` };
      }
      const found = a.task && cfg.resolveTask ? await cfg.resolveTask(a.task).catch(() => undefined) : undefined;
      // The owner is typing in this chat on the board: the reply stays there (the board notifies them), no pings elsewhere.
      const where = found?.ownerVia === "board" ? "board" : (a.channel ?? "both");
      const markup = where === "board" ? undefined : buttonsMarkup(store, a.actions ?? []);
      const chat = found && a.task ? { identifier: a.task, issueId: found.issueId, agentName: found.agentName } : undefined;
      const link = a.permalink && /^https:\/\//.test(a.permalink) ? a.permalink : undefined;
      const spelled = spellOut(a.questions);
      // The reply also lands on its chat, as the agent's own comment: only the chat's agent, running on it now, may.
      const mirror = found && caller && found.agentId === caller.id && cfg.postReply;
      const onChatP = mirror ? cfg.postReply!(found.issueId, replyBody(a.text, a.actions, a.questions), caller.assertion).catch(() => false) : Promise.resolve(false);
      // Muted fyi: no Telegram ping (buttons are an open choice, never muted).
      const muted = kind === "fyi" && cfg.muteFyi === true && !a.actions?.length;
      // One channel: the Slack DM (the owner's default for normal messages), or Telegram when Slack isn't installed, the
      // message asks for Telegram, or the DM fails (channel-slack hands it back through the outbox).
      const slack = (where === "both" || where === "slack") && cfg.toSlack ? await cfg.toSlack(`${chat ? `*${chat.agentName}* · ${chat.identifier}\n` : ""}${a.text}${spelled}${link ? `\n${link}` : ""}`).catch(() => false) : false;
      const tg = where === "board" || muted || slack ? false : await postTelegram(cfg, a.text + spelled + (link ? `\n${link}` : ""), markup, store, now, chat, undefined, Boolean(a.questions?.length));
      const onChat = await onChatP;
      // A web-only owner has no Telegram: the reply on the chat counts as sent.
      if (slack || tg || onChat) store.setKv(dupKey, String(now));
      const on = onChat ? { onChat } : {};
      if (!slack && !tg && !onChat && muted) return { sent: false, reason: "muted", note: "The owner muted fyi messages on Telegram, so nothing was sent. That is expected: don't resend it; put it in your next result instead." };
      return slack || tg || onChat ? { sent: true, ...on } : { sent: false, reason: "error", ...on };
    }
    const threadKey = a.thread_ts ?? a.ts;
    const track = a.channel_id && threadKey ? { channel: a.channel_id, key: threadKey } : null;
    if (track && cfg.cooldownMs > 0) {
      const last = store.lastUrgent(track.channel, track.key);
      if (last !== null && now - last < cfg.cooldownMs && !a.escalate) return { sent: false, reason: "cooldown" };
    }
    const link = a.permalink && /^https:\/\//.test(a.permalink) ? a.permalink : undefined;
    if (!(await postTelegram(cfg, `🚨 Needs you now\n${a.text}${link ? `\n${link}` : ""}`))) return { sent: false, reason: "error" };
    if (track) store.recordUrgent(track.channel, track.key, now);
    return { sent: true };
  } catch {
    return { sent: false, reason: "error" };
  }
}

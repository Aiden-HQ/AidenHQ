// channel-telegram as a transport of the owner's router (owner-channel): POST /transport/send is one message to the owner's
// Telegram, rendered here (escaped HTML with a small formatting subset, telegram.ts) with its one-tap buttons; a message about
// a chat is headed with its agent and remembered, so the owner's Telegram reply continues that chat.
import type { Store } from "./store.js";
import { answerMarkup, buttonsMarkup, escape, toTelegramHtml } from "./telegram.js";

export interface TgConfig {
  telegramToken?: string;
  telegramChatId?: string;
  taskUrl?: string; // e.g. https://host/WOR/issues/{id}: task IDs in Telegram messages link here
  boardUrl?: string; // the board's https address (BOARD_LAN_URL): in-app `#/route` links resolve against it
}
/** What owner-channel sends (its Message): the text as the agent wrote it, and the chat it belongs to. */
export type Message = { kind: string; text: string; head?: { agent: string; task: string; issue: string }; actions?: string[]; asks?: boolean; answer?: { options: string[]; since: string } };

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
export async function postTelegram(cfg: TgConfig, text: string, markup?: unknown, store?: Store, now = Date.now(), chat?: { identifier: string; issueId: string; agentName: string }, out?: { id?: number }, asks = false): Promise<boolean> {
  if (!cfg.telegramToken || !cfg.telegramChatId) return false;
  const prev = store ? (JSON.parse(store.getKv("tg:last_out") || "null") as { at: number; id: number; buttons?: boolean; task?: string } | null) : null;
  // A message with buttons or questions is an open choice: never deleted. Only a reply in the same chat replaces one (two
  // notices or alerts never do).
  const replace = chat && prev && !prev.buttons && prev.task === chat.identifier && now - prev.at < EDIT_WINDOW_MS && prev.at > Number(store!.getKv("owner:last_in") ?? 0);
  const head = chat ? { html: `<b>${escape(chat.agentName)}</b> · ${escape(chat.identifier)}\n`, plain: `${chat.agentName} · ${chat.identifier}\n` } : { html: "", plain: "" };
  const call = (method: string, body: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${cfg.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, ...body }),
    }).catch(() => null);
  const send = (body: Record<string, unknown>) => call("sendMessage", { disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}), ...body });
  let res = await send({ text: head.html + toTelegramHtml(text.slice(0, 3500), cfg.taskUrl, cfg.boardUrl), parse_mode: "HTML" });
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
export async function editTelegram(cfg: TgConfig, messageId: number, text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, message_id: messageId, text: toTelegramHtml(text.slice(0, 3500), cfg.taskUrl, cfg.boardUrl), parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }),
  }).catch(() => null);
  return Boolean(res?.ok);
}

/** One owner message on Telegram: off when no bot or no paired chat (owner-channel tries its next channel). */
export async function transportSend(cfg: TgConfig, store: Store, m: Message, now = Date.now()): Promise<{ sent: boolean; off?: true }> {
  if (!cfg.telegramToken || !cfg.telegramChatId) return { sent: false, off: true };
  const text = m.kind === "alert" ? `🚨 Needs you now\n${m.text}` : m.text;
  const chat = m.head ? { identifier: m.head.task, issueId: m.head.issue, agentName: m.head.agent } : undefined;
  let markup: unknown;
  try {
    // A one-tap answer is bound to its task's wait; actions win. A label Telegram can't show safely: the text still goes, without buttons.
    markup = m.actions?.length || !m.answer || !m.head ? buttonsMarkup(store, m.actions ?? []) : answerMarkup(store, m.head.issue, m.answer.since, m.answer.options);
  } catch {
    markup = undefined;
  }
  return { sent: await postTelegram(cfg, text, markup, store, now, chat, undefined, Boolean(m.asks)) };
}

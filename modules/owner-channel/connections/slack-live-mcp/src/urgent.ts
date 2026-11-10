import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { buttonsMarkup, escape, toTelegramHtml } from "./telegram.js";
import { stripPlaceholder, toSlackMrkdwn } from "./mrkdwn.js";

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
  task?: string | undefined; // the chat (task identifier) this message belongs to: its agent's name heads it; replies continue it
}
export interface NotifyConfig {
  botToken: string;
  ownerId: string;
  cooldownMs: number;
  telegramToken?: string;
  telegramChatId?: string;
  taskUrl?: string; // e.g. https://host/WOR/issues/{id}: task IDs in Telegram messages link here
  /** The task's id and its agent's name, from Paperclip (never from the message text). */
  resolveTask?: (identifier: string) => Promise<{ issueId: string; agentId?: string; agentName: string; ownerVia?: "board" | "telegram" | "slack" | undefined } | undefined>;
  /** Posts the reply on the chat as the calling agent (its own key), so the board shows what it said. */
  postReply?: (issueId: string, body: string, agentKey: string) => Promise<boolean>;
}
export type NotifyResult = { sent: boolean; reason?: "cooldown" | "error" | "duplicate"; onChat?: boolean };
/** Who called notify_owner: the agent behind the run key (agent-auth), and that key. */
export interface NotifyCaller {
  id: string;
  name?: string;
  key: string;
}

/**
 * Posts an agent's reply on its chat with the agent's own key. A key from a computer is a launcher run token (`ahqc_`), which
 * Paperclip doesn't know: the launcher posts it inside the box with that run's own Paperclip credential, on the run's task only.
 */
export function makePostReply(o: { paperclipUrl: string; launcherUrl: string; fetch?: typeof fetch; warn?: (msg: string, status?: number) => void }) {
  const f = o.fetch ?? fetch;
  return async (issueId: string, body: string, agentKey: string): Promise<boolean> => {
    const computer = agentKey.startsWith("ahqc_");
    if (computer && !o.launcherUrl) return o.warn?.("a computer's reply, but AIDENHQ_LAUNCHER_URL isn't set"), false;
    const [url, payload] = computer
      ? [new URL("/reply", o.launcherUrl), { issueId, body }]
      : [new URL(`/api/issues/${encodeURIComponent(issueId)}/comments`, o.paperclipUrl), { body }];
    const res = await f(url, {
      method: "POST",
      headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
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

const STALE_MS = 10 * 60_000;
// A thread that "just got worse" deserves a re-page through the cooldown.
const RE_ESCALATION_RE = /\b(escalat\w*|worse|spreading|second incident|new incident|production down|prod down|now also|still down|just got|getting worse|customer impact)\b/i;

// & < > start link/mention syntax; *_~` are neutralised with a zero-width space so senders can't restyle the DM.
// Agent text can carry untrusted content: no raw <links|labels>, @mentions or spoofed URLs reach the owner.
const SLACK_LINK = /^https:\/\/([a-z0-9-]+\.)?slack\.com\/archives\/[A-Z0-9]+\/p\d+(\?[\w=&.]*)?$/;
export function safeLink(url: string | undefined): string | undefined {
  return url && SLACK_LINK.test(url) ? url : undefined;
}
export function escapeMrkdwn(s: string): string {
  return escape(s).replace(/([*_~`])/g, "$1​");
}

export function humanizeMs(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h${m % 60}m`;
}

export function buildUrgentBlocks(a: NotifyArgs, now: number): Record<string, unknown>[] {
  const staleMs = a.received_at && now - a.received_at > STALE_MS ? now - a.received_at : null;
  // Summaries may start with "[C123] "; render that as a clickable channel mention.
  const prefix = a.text.match(/^\[([CGD][A-Z0-9]+)\]\s*/);
  const summary = prefix ? `<#${prefix[1]}> · ${escapeMrkdwn(a.text.slice(prefix[0].length))}` : escapeMrkdwn(a.text);
  const link = safeLink(a.permalink);
  const chip = link ? `\n<${link}|↗ open thread>` : "";
  const blocks: Record<string, unknown>[] = [];
  if (staleMs !== null) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_⏰ Backlog drain — received ${humanizeMs(staleMs)} ago; catching up now._` }] });
  }
  blocks.push(
    { type: "header", text: { type: "plain_text", text: staleMs !== null ? `⏰ Backlog — was urgent ${humanizeMs(staleMs)} ago` : "🚨 STOP — needs you NOW" } },
    { type: "section", text: { type: "mrkdwn", text: `${summary.slice(0, 1500)}${chip}` } },
  );
  return blocks;
}

async function postMessage(cfg: NotifyConfig, payload: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.botToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: cfg.ownerId, unfurl_links: false, unfurl_media: false, ...payload }),
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after") ?? 1), 30) * 1000));
      continue;
    }
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  }
  return false;
}

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

async function postSlack(cfg: NotifyConfig, payload: Record<string, unknown>): Promise<boolean> {
  return cfg.botToken && cfg.ownerId ? postMessage(cfg, payload) : false;
}

/** The message's own Slack permalink: the one passed, else looked up from its channel and ts. */
async function sourceLink(cfg: NotifyConfig, a: NotifyArgs): Promise<string | undefined> {
  const given = safeLink(a.permalink);
  if (given || !a.channel_id || !a.ts || !cfg.botToken) return given;
  const res = await fetch(`https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(a.channel_id)}&message_ts=${encodeURIComponent(a.ts)}`, { headers: { authorization: `Bearer ${cfg.botToken}` } }).catch(() => null);
  const r = (await res?.json().catch(() => null)) as { ok?: boolean; permalink?: string } | null;
  return r?.ok ? safeLink(r.permalink) : undefined;
}

export async function notifyOwner(store: Store, cfg: NotifyConfig, a: NotifyArgs, now = Date.now(), caller?: NotifyCaller): Promise<NotifyResult> {
  try {
    a = { ...a, text: stripPlaceholder(a.text) };
    if (!a.text && !a.questions?.length) return { sent: false, reason: "error" };
    if (a.priority === "normal") {
      // The same message twice in a few minutes (a duplicate wake) reaches the owner once.
      const dupKey = `notify:${createHash("sha256").update(`${a.channel ?? "both"}\n${a.task ?? ""}\n${a.text}\n${JSON.stringify(a.questions ?? [])}`).digest("hex").slice(0, 32)}`;
      const last = Number(store.getKv(dupKey) ?? 0);
      if (last && now - last < DUPLICATE_MS) return { sent: true, reason: "duplicate" };
      const found = a.task && cfg.resolveTask ? await cfg.resolveTask(a.task).catch(() => undefined) : undefined;
      // The owner is typing in this chat on the board: the reply stays there (the board notifies them), no pings elsewhere.
      const where = found?.ownerVia === "board" ? "board" : (a.channel ?? "both");
      const markup = where === "board" ? undefined : buttonsMarkup(store, a.actions ?? []);
      const chat = found && a.task ? { identifier: a.task, issueId: found.issueId, agentName: found.agentName } : undefined;
      const link = safeLink(a.permalink);
      const spelled = spellOut(a.questions);
      const text = toSlackMrkdwn(a.text + spelled) + (link ? `\n<${link}|↗ open>` : "");
      // The reply also lands on its chat, as the agent's own comment: only the chat's agent, running on it now, may.
      const mirror = found && caller && found.agentId === caller.id && cfg.postReply;
      // One channel: Slack, or Telegram when Slack isn't set up or fails ("both" means "reach them", not "ping twice").
      const onChatP = mirror ? cfg.postReply!(found.issueId, replyBody(a.text, a.actions, a.questions), caller.key).catch(() => false) : Promise.resolve(false);
      const slack = where === "telegram" || where === "board" ? false : await postSlack(cfg, { text });
      const tg = where === "board" || where === "slack" || slack ? false : await postTelegram(cfg, a.text + spelled + (link ? `\n${link}` : ""), markup, store, now, chat, undefined, Boolean(a.questions?.length));
      const onChat = await onChatP;
      // A web-only owner has no Telegram or Slack: the reply on the chat counts as sent.
      if (slack || tg || onChat) store.setKv(dupKey, String(now));
      const on = onChat ? { onChat } : {};
      return slack || tg || onChat ? { sent: true, ...on } : { sent: false, reason: "error", ...on };
    }
    const threadKey = a.thread_ts ?? a.ts;
    const track = a.channel_id && threadKey ? { channel: a.channel_id, key: threadKey } : null;
    if (track && cfg.cooldownMs > 0) {
      const last = store.lastUrgent(track.channel, track.key);
      if (last !== null && now - last < cfg.cooldownMs && !RE_ESCALATION_RE.test(a.text)) return { sent: false, reason: "cooldown" };
    }
    // Every urgent alert links the message it was raised from.
    const link = await sourceLink(cfg, a);
    if (link) a = { ...a, permalink: link };
    const [slack, tg] = await Promise.all([
      postSlack(cfg, { text: escapeMrkdwn(a.text), blocks: buildUrgentBlocks(a, now) }),
      postTelegram(cfg, `🚨 Needs you now\n${a.text}${link ? `\n${link}` : ""}`),
    ]);
    const sent = slack || tg;
    if (!sent) return { sent: false, reason: "error" };
    if (track) store.recordUrgent(track.channel, track.key, now);
    return { sent: true };
  } catch {
    return { sent: false, reason: "error" };
  }
}

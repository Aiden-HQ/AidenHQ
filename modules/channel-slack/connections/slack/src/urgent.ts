// notify_owner on Slack: DMs to the owner from the instance's bot (the owner's Slack user id is host-controlled). Agent text is
// rendered through a small mrkdwn subset with everything else escaped, so it can't form links, mentions or broadcasts.
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { escape, stripPlaceholder, toSlackMrkdwn } from "./mrkdwn.js";

export interface NotifyArgs {
  text: string;
  priority: "urgent" | "normal";
  permalink?: string | undefined;
  channel_id?: string | undefined;
  thread_ts?: string | undefined;
  ts?: string | undefined;
  received_at?: number | undefined;
  questions?: Question[] | undefined; // multiple choice, spelled out in the DM
  escalate?: string | undefined; // urgent: why the thread got worse since its last page; re-pages through the cooldown
  task?: string | undefined; // the task this message is about (the loop brake counts per task)
  kind?: NotifyKind | undefined; // decision: needs the owner (never braked); done: a finished result (the default); fyi: news
}
/** What a normal message is for: `decision` needs the owner (messages with questions are decisions), `done` a result, `fyi` news. */
export type NotifyKind = "decision" | "done" | "fyi";
export interface NotifyConfig {
  botToken: string;
  ownerId: string;
  cooldownMs: number;
  /** The kernel's loop brake (POST /v1/brake/notify), for a message about a task. */
  brake?: (task: string, agent: string, decision: boolean) => Promise<{ allow: boolean; note?: string }>;
}
export type NotifyResult = { sent: boolean; reason?: "cooldown" | "error" | "duplicate" | "limit" | "muted"; onChat?: boolean; note?: string };
/** Who called notify_owner (the kernel's assertion of the call). */
export interface NotifyCaller {
  id: string;
  name?: string;
  key: string;
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

export async function postMessage(cfg: NotifyConfig, payload: Record<string, unknown>): Promise<boolean> {
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

async function postSlack(cfg: NotifyConfig, payload: Record<string, unknown>): Promise<boolean> {
  return cfg.botToken && cfg.ownerId ? postMessage(cfg, payload) : false;
}

/**
 * The owner's normal messages channel-telegram's notify_owner hands over (the kernel's outbox): each as the Slack DM, the
 * owner's default. One that fails goes back to Telegram the same way.
 */
export async function relayOutbox(cfg: NotifyConfig, drain: () => Promise<{ text: string }[]>, back: (text: string) => Promise<unknown>): Promise<number> {
  let sent = 0;
  for (const m of await drain()) {
    if (await postSlack(cfg, { text: toSlackMrkdwn(m.text) }).catch(() => false)) sent++;
    else await back(m.text).catch(() => undefined);
  }
  return sent;
}

/** The message's own Slack permalink: the one passed, else looked up from its channel and ts. */
async function sourceLink(cfg: NotifyConfig, a: NotifyArgs): Promise<string | undefined> {
  const given = safeLink(a.permalink);
  if (given || !a.channel_id || !a.ts || !cfg.botToken) return given;
  const res = await fetch(`https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(a.channel_id)}&message_ts=${encodeURIComponent(a.ts)}`, { headers: { authorization: `Bearer ${cfg.botToken}` } }).catch(() => null);
  const r = (await res?.json().catch(() => null)) as { ok?: boolean; permalink?: string } | null;
  return r?.ok ? safeLink(r.permalink) : undefined;
}

/**
 * priority=normal: a message (one copy of a duplicate within 10 minutes; with `task`, the kernel's loop brake first);
 * priority=urgent: a STOP-style page linked to its source, once per thread per cooldown unless it escalates. The owner's
 * Telegram and their board chat are channel-telegram's notify_owner.
 */
export async function notifyOwner(store: Store, cfg: NotifyConfig, a: NotifyArgs, now = Date.now(), caller?: NotifyCaller): Promise<NotifyResult> {
  try {
    a = { ...a, text: stripPlaceholder(a.text) };
    if (!a.text && !a.questions?.length) return { sent: false, reason: "error" };
    if (a.priority === "normal") {
      const dupKey = `notify:${createHash("sha256").update(`${a.task ?? ""}\n${a.text}\n${JSON.stringify(a.questions ?? [])}`).digest("hex").slice(0, 32)}`;
      const last = Number(store.getKv(dupKey) ?? 0);
      if (last && now - last < DUPLICATE_MS) return { sent: true, reason: "duplicate" };
      const kind: NotifyKind = a.questions?.length ? "decision" : (a.kind ?? "done");
      if (a.task && cfg.brake) {
        const b = await cfg.brake(a.task, caller?.id ?? "", kind === "decision").catch(() => ({ allow: true, note: undefined }));
        if (!b.allow) return { sent: false, reason: "limit", note: b.note ?? `Limit reached on ${a.task} since the owner last wrote there. Nothing was sent; batch it into your next update.` };
      }
      const link = safeLink(a.permalink);
      const text = toSlackMrkdwn(a.text + spellOut(a.questions)) + (link ? `\n<${link}|↗ open>` : "");
      if (!(await postSlack(cfg, { text }))) return { sent: false, reason: "error" };
      store.setKv(dupKey, String(now));
      return { sent: true };
    }
    const threadKey = a.thread_ts ?? a.ts;
    const track = a.channel_id && threadKey ? { channel: a.channel_id, key: threadKey } : null;
    if (track && cfg.cooldownMs > 0) {
      const last = store.lastUrgent(track.channel, track.key);
      if (last !== null && now - last < cfg.cooldownMs && !a.escalate) return { sent: false, reason: "cooldown" };
    }
    // Every urgent alert links the message it was raised from.
    const link = await sourceLink(cfg, a);
    if (link) a = { ...a, permalink: link };
    if (!(await postSlack(cfg, { text: escapeMrkdwn(a.text), blocks: buildUrgentBlocks(a, now) }))) return { sent: false, reason: "error" };
    if (track) store.recordUrgent(track.channel, track.key, now);
    return { sent: true };
  } catch {
    return { sent: false, reason: "error" };
  }
}

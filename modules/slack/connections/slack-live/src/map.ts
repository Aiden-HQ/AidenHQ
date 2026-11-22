import type { LiveEvent } from "./store.js";

const KINDS = new Set(["message", "app_mention"]);
const SYSTEM_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);
const DEDUPE_MS = 60_000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export function permalink(channel: string, ts: string): string {
  return `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

// Socket Mode envelope body (the Events API callback) -> a LiveEvent, or null when it isn't one
// we keep. Only events_api messages and mentions; bots, system subtypes and empty text are dropped.
export function toEvent(body: unknown, now = Date.now()): LiveEvent | null {
  const b = rec(body);
  const ev = rec(b?.event);
  const eventId = str(b?.event_id);
  const kind = str(ev?.type);
  const channelId = str(ev?.channel);
  const ts = str(ev?.ts);
  const text = str(ev?.text)?.trim();
  if (!ev || !eventId || !kind || !KINDS.has(kind) || !channelId || !ts || !text) return null;
  const subtype = str(ev.subtype);
  if (subtype === "bot_message" || (subtype && SYSTEM_SUBTYPES.has(subtype))) return null;
  if (str(ev.bot_id) || str(ev.app_id)) return null;
  const threadTs = str(ev.thread_ts);
  return { eventId, kind, channelId, userId: str(ev.user) ?? "", ...(threadTs ? { threadTs } : {}), ts, text, permalink: permalink(channelId, ts), receivedAt: now };
}

/** A routine's event (the kernel's event router, POST /v1/events). */
export type SourceEvent = { connection: "slack"; resource: string; id: string; kind: string; author?: string; text: string; bot: boolean; url: string };
// The envelope -> a routine's event: messages and mentions with text, bot posts flagged `bot` (a routine's filter decides), system
// subtypes dropped. Its id is the message (channel and ts): one message delivered as a bot and a user event is one event.
export function toSourceEvent(body: unknown): SourceEvent | null {
  const ev = rec(rec(body)?.event);
  const kind = str(ev?.type), channel = str(ev?.channel), ts = str(ev?.ts), text = str(ev?.text)?.trim();
  if (!ev || !kind || !KINDS.has(kind) || !channel || !ts || !text) return null;
  const subtype = str(ev.subtype);
  if (subtype && SYSTEM_SUBTYPES.has(subtype)) return null;
  const author = str(ev.user) ?? str(ev.bot_id);
  return { connection: "slack", resource: channel, id: `${channel}:${ts}`, kind, ...(author ? { author } : {}), text: text.slice(0, 2000), bot: subtype === "bot_message" || Boolean(str(ev.bot_id) || str(ev.app_id)), url: permalink(channel, ts) };
}

// 60 s same-channel same-text dedupe (in memory; a restart clears it). `accept` runs unless the text is a duplicate; the text is
// remembered only once it returned, so an event whose insert threw (and is redelivered) isn't taken for a duplicate.
export function makeDedupe() {
  const seen = new Map<string, number>();
  return (e: LiveEvent, accept: () => void): void => {
    const key = `${e.channelId}::${e.text.replace(/\s+/g, " ").toLowerCase()}`;
    const last = seen.get(key);
    if (last === undefined || e.receivedAt - last > DEDUPE_MS) accept();
    seen.set(key, e.receivedAt);
    for (const [k, at] of seen) if (e.receivedAt - at > DEDUPE_MS) seen.delete(k);
  };
}

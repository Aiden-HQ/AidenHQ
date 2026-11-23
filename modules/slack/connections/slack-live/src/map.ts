const KINDS = new Set(["message", "app_mention"]);
const SYSTEM_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export function permalink(channel: string, ts: string): string {
  return `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

/** A routine's event (the kernel's event router, POST /v1/events). */
export type SourceEvent = { connection: "slack"; resource: string; id: string; kind: string; author?: string; text: string; bot: boolean; url: string; thread?: string };
// The envelope -> a routine's event: messages and mentions with text, bot posts flagged `bot` (a routine's filter decides), system
// subtypes dropped. Its id is the message (channel and ts): one message delivered as a bot and a user event is one event.
export function toSourceEvent(body: unknown): SourceEvent | null {
  const ev = rec(rec(body)?.event);
  const kind = str(ev?.type), channel = str(ev?.channel), ts = str(ev?.ts), text = str(ev?.text)?.trim();
  if (!ev || !kind || !KINDS.has(kind) || !channel || !ts || !text) return null;
  const subtype = str(ev.subtype);
  if (subtype && SYSTEM_SUBTYPES.has(subtype)) return null;
  // Direct messages to the bot are the bot's conversation, never a feed a routine reads: only channels go.
  const kindOf = str(ev.channel_type);
  if (kindOf === "im" || kindOf === "mpim" || channel.startsWith("D")) return null;
  const author = str(ev.user) ?? str(ev.bot_id);
  // A reply carries its thread's root ts: whom it addresses and which task it belongs to are the thread's.
  const thread = str(ev.thread_ts);
  return { connection: "slack", resource: channel, id: `${channel}:${ts}`, kind, ...(author ? { author } : {}), text: text.slice(0, 2000), bot: subtype === "bot_message" || Boolean(str(ev.bot_id) || str(ev.app_id)), url: permalink(channel, ts), ...(thread && thread !== ts ? { thread } : {}) };
}

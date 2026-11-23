const KINDS = new Set(["message", "app_mention"]);
// The owner's task emoji: reacting with it hands a message to Intake (the slack-triage routine).
const TASK_EMOJI = "pushpin";
const SYSTEM_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export function permalink(channel: string, ts: string): string {
  return `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

/** A routine's event (the kernel's event router, POST /v1/events). */
export type SourceEvent = { connection: "slack"; resource: string; id: string; kind: string; author?: string; text: string; bot: boolean; url: string; thread?: string; truncated?: true };
// The envelope -> a routine's event: messages and mentions with text, bot posts flagged `bot` (a routine's filter decides), system
// subtypes dropped. Its id is the message (channel and ts): one message delivered as a bot and a user event is one event.
export function toSourceEvent(body: unknown, owner?: string): SourceEvent | null {
  const ev = rec(rec(body)?.event);
  const reaction = reactionEvent(ev, owner);
  if (reaction !== undefined) return reaction;
  const kind = str(ev?.type), channel = str(ev?.channel), ts = str(ev?.ts), text = str(ev?.text)?.trim();
  if (!ev || !kind || !KINDS.has(kind) || !channel || !ts || !text) return null;
  const subtype = str(ev.subtype);
  if (subtype && SYSTEM_SUBTYPES.has(subtype)) return null;
  // A direct message goes only from the owner's own stream (a user authorization): a DM someone sends the bot is the bot's
  // conversation, never a feed a routine reads.
  const dm = ["im", "mpim"].includes(str(ev.channel_type) ?? "");
  const auths = (rec(body)?.authorizations as { is_bot?: boolean }[] | undefined) ?? [];
  if (dm && !auths.some((a) => a?.is_bot === false)) return null;
  const author = str(ev.user) ?? str(ev.bot_id);
  // A reply carries its thread's root ts: whom it addresses and which task it belongs to are the thread's.
  const thread = str(ev.thread_ts);
  return { connection: "slack", resource: channel, id: `${channel}:${ts}`, kind, ...(author ? { author } : {}), text: text.slice(0, 2000), bot: subtype === "bot_message" || Boolean(str(ev.bot_id) || str(ev.app_id)), url: permalink(channel, ts), ...(thread && thread !== ts ? { thread } : {}), ...(text.length > 2000 ? { truncated: true as const } : {}) };
}

// The owner's task emoji added or removed on a message: kind reaction_added / reaction_removed, the reacted message's permalink.
// Anyone else's reaction, or another emoji, is not an event. The id carries event_ts so a re-pin is a new event.
function reactionEvent(ev: Record<string, unknown> | undefined, owner?: string): SourceEvent | null | undefined {
  const kind = str(ev?.type);
  if (kind !== "reaction_added" && kind !== "reaction_removed") return undefined;
  const item = rec(ev?.item), channel = str(item?.channel), ts = str(item?.ts), at = str(ev?.event_ts);
  if (!owner || str(ev?.user) !== owner || str(ev?.reaction) !== TASK_EMOJI || str(item?.type) !== "message" || !channel || !ts || !at) return null;
  return { connection: "slack", resource: channel, id: `${channel}:${ts}:${kind}:${at}`, kind, author: owner, text: `:${TASK_EMOJI}: ${kind === "reaction_added" ? "added to" : "removed from"} the message ${ts}`, bot: false, url: permalink(channel, ts) };
}

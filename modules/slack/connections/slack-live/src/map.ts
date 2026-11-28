const KINDS = new Set(["message", "app_mention"]);
// The owner's task emoji: reacting with it hands a message to Intake (the slack-triage routine).
const TASK_EMOJI = "pushpin";
const SYSTEM_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export function permalink(channel: string, ts: string): string {
  return `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

/** A routine's event (the kernel's event router, POST /v1/events). `to_agent` and `entry` are the reach path's (agent-reach design):
 * an agent key (a dedicated app, a bound channel) or "*" (the instance bot: route by name, else the chief of staff), and the
 * connector-owned entry-point id the conversation keeps (`slack:bot`, `slack:app:<app id>`). `author_name` names the sender. */
export type SourceEvent = { connection: "slack"; resource: string; id: string; kind: string; author?: string; author_name?: string; text: string; bot: boolean; url: string; thread?: string; from_owner?: boolean; to_agent?: string; entry?: string; truncated?: true };

/** Where a message addressed to one of our bots goes: `to` is an agent key or "*", `entry` the entry-point id replies use. */
export type Target = { to: string; entry: string };
/** What classification needs to know, read at the call so a pairing, a binding or a new app applies at once. */
export type Route = {
  /** The app whose socket carried the event: a DM to it is addressed to it, and so is its app_mention. */
  receiver?: Target;
  /** Every bot of ours by Slack user id: a mention of one goes to its target. */
  bots?: Record<string, Target>;
  /** The agent a channel is bound to (bind.ts), for a mention of the instance bot ("*"). */
  bound?: (channel: string) => string | undefined;
  /** The owner's command DM with the instance bot: Aiden's chat, never an addressed message. */
  ownerChannel?: string;
  /** DM channel -> the other person's user id, for the owner's own DMs: one with a bot of ours is addressed to it, whichever socket saw it first. */
  peers?: Map<string, string>;
};
export const BOT_ENTRY = "slack:bot";
// The envelope -> a routine's event: messages and mentions with text, bot posts flagged `bot` (a routine's filter decides), system
// subtypes dropped. Its id is the message (channel and ts): one message delivered as a bot and a user event is one event.
// `from_owner` (the kernel's summon path, role kernel.attest-owner) is decided here, in code, from the author alone: the paired
// owner's own user id, no bot or app marker, a plain message (a thread broadcast or file share is still the owner's). It is never
// derived from text. `thread` is the conversation's root: in a channel a top-level message is its own root; in a DM only a reply
// has one (its thread's root, as triage has always read it).
const OWN_SUBTYPES = new Set(["thread_broadcast", "file_share"]);
const CHANNEL_TYPES = new Set(["channel", "group", "public", "private"]);
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const HUMAN = /^[UW][A-Z0-9]{2,}$/;
/**
 * Who a message is addressed to, decided once per message from its text and place, so the `message` and `app_mention` envelopes
 * of one message (and a gap replay of it) classify the same. The precedence: the owner's command DM (Aiden's chat: nobody), then
 * a bound channel (a mention of the instance bot there goes to the bound agent), then an addressed bot (a mention of one of our
 * bots, or a DM to one), else nobody. Only a person's plain message addresses a bot: never a bot, an app or an edit.
 */
function addressedTo(ev: Record<string, unknown>, channel: string, text: string, dm: boolean, auths: { is_bot?: boolean; user_id?: string }[], route: Route | undefined): Target | undefined {
  const botAuth = auths.some((a) => a?.is_bot === true);
  if (!route || str(ev.subtype) || str(ev.bot_id) || str(ev.app_id) || !HUMAN.test(str(ev.user) ?? "")) return undefined;
  if (dm && channel === route.ownerChannel) return undefined;
  const through = (t: Target): Target => {
    const bound = !dm && t.to === "*" ? route.bound?.(channel) : undefined;
    return bound ? { to: bound, entry: t.entry } : t;
  };
  // A DM to a bot is that bot's, whoever else the message names: the app that received it is the one that can answer in it.
  if (route.receiver && dm && botAuth) return through(route.receiver);
  // The receiving app's own bot id is in the envelope's authorizations, so its mention is known before anything is looked up.
  const bots = { ...(route.receiver ? Object.fromEntries(auths.filter((a) => a?.is_bot === true && typeof a.user_id === "string").map((a) => [a.user_id!, route.receiver!])) : {}), ...route.bots };
  // The owner's own DM with a bot of ours (an agent's app): the other party is that bot, whichever app's socket carried it.
  const peer = dm ? route.peers?.get(channel) : undefined;
  if (peer && bots[peer]) return through(bots[peer]!);
  for (const [, id] of text.matchAll(MENTION)) {
    const t = bots[id!];
    if (t) return through(t);
  }
  if (route.receiver && str(ev.type) === "app_mention") return through(route.receiver);
  return undefined;
}

export function toSourceEvent(body: unknown, owner?: string, route?: Route): SourceEvent | null {
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
  const auths = (rec(body)?.authorizations as { is_bot?: boolean; user_id?: string }[] | undefined) ?? [];
  const target = addressedTo(ev, channel, text, str(ev.channel_type) === "im", auths, route);
  if (dm && !target && !auths.some((a) => a?.is_bot === false)) return null;
  const author = str(ev.user) ?? str(ev.bot_id);
  const bot = subtype === "bot_message" || Boolean(str(ev.bot_id) || str(ev.app_id));
  // A reply carries its thread's root ts: whom it addresses and which task it belongs to are the thread's. An app_mention has no
  // channel_type: a channel id starting C or G is a channel.
  const type = str(ev.channel_type);
  const inChannel = type ? CHANNEL_TYPES.has(type) : /^[CG]/.test(channel);
  const root = str(ev.thread_ts);
  const thread = inChannel ? (root ?? ts) : root && root !== ts ? root : undefined;
  const fromOwner = Boolean(owner) && author === owner && !bot && (!subtype || OWN_SUBTYPES.has(subtype));
  // An addressed message is one kind, whichever envelope carried it.
  return { connection: "slack", resource: channel, id: `${channel}:${ts}`, kind: target ? "message" : kind, ...(author ? { author } : {}), text: text.slice(0, 2000), bot, url: permalink(channel, ts), ...(thread ? { thread } : {}), from_owner: fromOwner, ...(target ? { to_agent: target.to, entry: target.entry } : {}), ...(text.length > 2000 ? { truncated: true as const } : {}) };
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

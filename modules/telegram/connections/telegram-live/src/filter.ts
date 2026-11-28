// The filter runs first (Aria's rule): before any other work it decides whether a message is stored and whether it wakes
// triage. Pure and synchronous: the caller resolves everything it needs (the chat, the reply target) beforehand.
import type * as Td from "./tdlib-types.js";
import type { Me } from "./td.js";

export type ChatKind = "dm" | "group" | "channel" | "secret";
export type Scope = "private" | "group" | "channel";
/** Each notification scope's default `mute_for` (seconds; above 0 is muted). */
export type ScopeSettings = Record<Scope, number>;

export interface FilterCtx {
  chat: { id: number; type: ChatKind; muted: boolean };
  me: Me;
  setting: "tagged" | "all";
  excluded: Set<number>;
  /** Whether that message in that chat is the user's own. */
  isOwnMessage(chatId: number, messageId: number): boolean;
  /** Sent by an agent through the executor: stored, never an event. */
  agentSent: boolean;
  /** Read from history (backfill): stored, never an event. */
  history: boolean;
  /** A summons touched this chat: its messages are events even when muted (the kernel forwards them to the open task). */
  summoned?: boolean;
}

export type Verdict = { store: boolean; event: boolean; labels: string[]; mentions_me: boolean; replies_to_me: boolean };

export function chatKind(type: Td.ChatType): ChatKind {
  switch (type._) {
    case "chatTypePrivate":
      return "dm";
    case "chatTypeSecret":
      return "secret";
    case "chatTypeBasicGroup":
      return "group";
    case "chatTypeSupergroup":
      return type.is_channel ? "channel" : "group";
  }
}

/** TDLib's notification scope for each of ours. */
export const SCOPE_TD: Record<Scope, string> = { private: "notificationSettingsScopePrivateChats", group: "notificationSettingsScopeGroupChats", channel: "notificationSettingsScopeChannelChats" };
export const scopeOf = (kind: ChatKind): Scope => (kind === "dm" || kind === "secret" ? "private" : kind);

/** Muted by its own setting, or by its scope's default when it uses that. Archive is not mute. */
export function effectiveMute(chat: Pick<Td.chat, "type" | "notification_settings">, scopes: ScopeSettings): boolean {
  return isMuted(chat.notification_settings, scopes[scopeOf(chatKind(chat.type))]);
}

/** The mute rule itself, given the chat's scope default `mute_for`. */
export const isMuted = (n: Pick<Td.chatNotificationSettings, "use_default_mute_for" | "mute_for">, scopeMuteFor: number): boolean =>
  n.use_default_mute_for ? scopeMuteFor > 0 : n.mute_for > 0;

/** Whether a chat's messages are stored at all (rules 1 and 2). */
export function storesChat(chat: { id: number; type: ChatKind; muted: boolean }, setting: "tagged" | "all", excluded: Set<number>): boolean {
  if (chat.type === "secret" || excluded.has(chat.id)) return false;
  return !(chat.type === "channel" && chat.muted && setting === "tagged");
}

/** The message's text and its entities: a text message's, or a media caption's. */
export function formatted(content: Td.MessageContent): Td.formattedText | undefined {
  const c = content as { text?: Td.formattedText; caption?: Td.formattedText };
  return content._ === "messageText" ? c.text : c.caption;
}

/** The owner's own words: sent by them (TDLib's outgoing flag, or their user id: Saved Messages reports its messages as incoming) and not a forward, whose text is someone else's. */
export const ownerAuthored = (m: Td.message, me: Me): boolean =>
  !m.forward_info && (m.is_outgoing || (m.sender_id._ === "messageSenderUser" && m.sender_id.user_id === me.user_id));

export function mentionsMe(m: Td.message, me: Me): boolean {
  if (m.contains_unread_mention) return true;
  const f = formatted(m.content);
  if (!f) return false;
  const names = new Set(me.usernames.map((u) => `@${u.toLowerCase()}`));
  return f.entities.some((e) =>
    (e.type._ === "textEntityTypeMentionName" && e.type.user_id === me.user_id) ||
    (e.type._ === "textEntityTypeMention" && names.has(f.text.slice(e.offset, e.offset + e.length).toLowerCase())));
}

export function classify(m: Td.message, ctx: FilterCtx): Verdict {
  const { chat } = ctx;
  const none: Verdict = { store: false, event: false, labels: [], mentions_me: false, replies_to_me: false };
  if (!storesChat(chat, ctx.setting, ctx.excluded)) return none;
  const mentions_me = mentionsMe(m, ctx.me);
  const r = m.reply_to;
  const replies_to_me = r?._ === "messageReplyToMessage" && r.chat_id === m.chat_id && ctx.isOwnMessage(m.chat_id, r.message_id);
  const outgoing = m.is_outgoing;
  // Service messages (joins, pins, title changes) have no text or caption: stored, never an event.
  const event = !ctx.history && !ctx.agentSent && formatted(m.content) !== undefined &&
    (chat.type === "dm" || outgoing || !chat.muted || ctx.setting === "all" || mentions_me || replies_to_me || ctx.summoned === true);
  const labels = [chat.type, ...(chat.muted ? ["muted"] : []), ...(mentions_me ? ["mentions_me"] : []), ...(replies_to_me ? ["replies_to_me"] : []), ...(outgoing ? ["outgoing"] : [])];
  return { store: true, event, labels, mentions_me, replies_to_me };
}

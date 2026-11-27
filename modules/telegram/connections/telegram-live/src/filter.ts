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

export const scopeOf = (kind: ChatKind): Scope => (kind === "dm" || kind === "secret" ? "private" : kind);

/** Muted by its own setting, or by its scope's default when it uses that. Archive is not mute. */
export function effectiveMute(chat: Pick<Td.chat, "type" | "notification_settings">, scopes: ScopeSettings): boolean {
  const n = chat.notification_settings;
  return n.use_default_mute_for ? scopes[scopeOf(chatKind(chat.type))] > 0 : n.mute_for > 0;
}

/** Whether a chat's messages are stored at all (rules 1 and 2). */
export function storesChat(chat: { id: number; type: ChatKind; muted: boolean }, setting: "tagged" | "all", excluded: Set<number>): boolean {
  if (chat.type === "secret" || excluded.has(chat.id)) return false;
  return !(chat.type === "channel" && chat.muted && setting === "tagged");
}

/** The message's text and its entities: a text message's, or a media caption's. */
export function formatted(content: Td.MessageContent): Td.formattedText | undefined {
  const c = content as { text?: Td.formattedText; caption?: Td.formattedText };
  return c._ === "messageText" ? c.text : c.caption;
}

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
  const event = !ctx.history && !ctx.agentSent &&
    (chat.type === "dm" || outgoing || !chat.muted || ctx.setting === "all" || mentions_me || replies_to_me);
  const labels = [chat.type, ...(chat.muted ? ["muted"] : []), ...(mentions_me ? ["mentions_me"] : []), ...(replies_to_me ? ["replies_to_me"] : []), ...(outgoing ? ["outgoing"] : [])];
  return { store: true, event, labels, mentions_me, replies_to_me };
}

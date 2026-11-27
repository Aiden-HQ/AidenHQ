import { describe, expect, it } from "bun:test";
import { classify, effectiveMute, type ChatKind, type FilterCtx } from "../src/filter.js";
import type * as Td from "../src/tdlib-types.js";

const me = { user_id: 42, usernames: ["Owner"], name: "Owner" };

function msg(o: { chat?: number; id?: number; text?: string; outgoing?: boolean; replyTo?: number; mentionName?: boolean }): Td.message {
  const text = o.text ?? "hello";
  const entities: Td.textEntity[] = [];
  const at = text.indexOf("@owner");
  if (at >= 0) entities.push({ _: "textEntity", offset: at, length: 6, type: { _: "textEntityTypeMention" } });
  if (o.mentionName) entities.push({ _: "textEntity", offset: 0, length: 5, type: { _: "textEntityTypeMentionName", user_id: 42 } });
  return {
    _: "message", id: o.id ?? 10, chat_id: o.chat ?? -1, sender_id: { _: "messageSenderUser", user_id: o.outgoing ? 42 : 7 }, is_outgoing: !!o.outgoing,
    contains_unread_mention: false, date: 1_800_000_000,
    ...(o.replyTo ? { reply_to: { _: "messageReplyToMessage", chat_id: o.chat ?? -1, message_id: o.replyTo } } : {}),
    content: { _: "messageText", text: { _: "formattedText", text, entities } },
  } as unknown as Td.message;
}

const ctx = (type: ChatKind, muted: boolean, over: Partial<FilterCtx> = {}): FilterCtx => ({
  chat: { id: -1, type, muted }, me, setting: "tagged", excluded: new Set(), isOwnMessage: (_c, id) => id === 5, agentSent: false, history: false, ...over,
});

describe("filter", () => {
  it.each([
    ["DM", msg({}), ctx("dm", false), true, true, ["dm"]],
    ["unmuted group", msg({}), ctx("group", false), true, true, ["group"]],
    ["muted group, chatter", msg({}), ctx("group", true), true, false, ["group", "muted"]],
    ["muted group, @me", msg({ text: "hey @owner look" }), ctx("group", true), true, true, ["group", "muted", "mentions_me"]],
    ["muted group, a mention by name", msg({ mentionName: true }), ctx("group", true), true, true, ["group", "muted", "mentions_me"]],
    ["muted group, reply to my message", msg({ replyTo: 5 }), ctx("group", true), true, true, ["group", "muted", "replies_to_me"]],
    ["muted group, reply to someone else", msg({ replyTo: 6 }), ctx("group", true), true, false, ["group", "muted"]],
    ["muted channel, tagged", msg({}), ctx("channel", true), false, false, []],
    ["muted channel, all", msg({}), ctx("channel", true, { setting: "all" }), true, true, ["channel", "muted"]],
    ["excluded chat", msg({}), ctx("dm", false, { excluded: new Set([-1]) }), false, false, []],
    ["secret chat", msg({}), ctx("secret", false), false, false, []],
    ["own message in a muted group", msg({ outgoing: true }), ctx("group", true), true, true, ["group", "muted", "outgoing"]],
    ["agent-sent", msg({ outgoing: true }), ctx("dm", false, { agentSent: true }), true, false, ["dm", "outgoing"]],
    ["history row", msg({}), ctx("dm", false, { history: true }), true, false, ["dm"]],
  ] as const)("%s", (_name, m, c, store, event, labels) => {
    const v = classify(m, c);
    expect({ store: v.store, event: v.event, labels: v.labels }).toEqual({ store, event, labels: [...labels] });
  });

  it("effective mute: own setting, else the scope's default; archive is not mute", () => {
    const scopes = { private: 0, group: 3600, channel: 0 };
    const group = { _: "chatTypeBasicGroup", basic_group_id: 1 } as Td.ChatType;
    const notif = (use_default_mute_for: boolean, mute_for: number) => ({ use_default_mute_for, mute_for }) as Td.chatNotificationSettings;
    expect(effectiveMute({ type: group, notification_settings: notif(true, 0) }, scopes)).toBe(true);
    expect(effectiveMute({ type: group, notification_settings: notif(false, 0) }, scopes)).toBe(false);
    // An archived chat (archive lives in chat lists, never read here) follows its own mute state.
    expect(effectiveMute({ type: { _: "chatTypePrivate", user_id: 7 } as Td.ChatType, notification_settings: notif(true, 0) }, scopes)).toBe(false);
  });
});

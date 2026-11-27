// Shared fixtures for the ingest, reconcile and backfill tests: TDLib objects, a scripted FakeTd, a fake kernel and warehouse.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIngest, type Settings } from "../src/ingest.js";
import type { SourceStore } from "../src/source-store.js";
import { openStore, type Store } from "../src/store.js";
import type * as Td from "../src/tdlib-types.js";
import { FakeTd } from "./fake-td.js";

export const ME = { user_id: 42, usernames: ["owner"], name: "Owner" };
export const DAY_S = 86_400;
export const NOW_MS = 1_800_000_000_000;
export const log = { info() {}, warn() {}, error() {} };

export const tmpDb = () => join(mkdtempSync(join(tmpdir(), "tg-live-")), "telegram-live.sqlite");

type Kind = "dm" | "group" | "supergroup" | "channel";
export function chat(id: number, kind: Kind, o: { muted?: boolean; last?: number; title?: string } = {}): Td.chat {
  const type =
    kind === "dm" ? { _: "chatTypePrivate", user_id: id }
    : kind === "group" ? { _: "chatTypeBasicGroup", basic_group_id: -id }
    : { _: "chatTypeSupergroup", supergroup_id: 1, is_channel: kind === "channel" };
  return {
    _: "chat", id, type, title: o.title ?? `chat ${id}`, chat_lists: [{ _: "chatListMain" }], positions: [],
    notification_settings: { _: "chatNotificationSettings", use_default_mute_for: false, mute_for: o.muted ? 1 << 30 : 0 },
    ...(o.last ? { last_message: msg(id, o.last) } : {}),
  } as unknown as Td.chat;
}

export function msg(chatId: number, id: number, o: { text?: string; outgoing?: boolean; date?: number; replyTo?: number; sending?: boolean } = {}): Td.message {
  return {
    _: "message", id, chat_id: chatId, sender_id: { _: "messageSenderUser", user_id: o.outgoing ? ME.user_id : 7 }, is_outgoing: !!o.outgoing,
    contains_unread_mention: false, date: o.date ?? NOW_MS / 1000 - 60 + id, edit_date: 0,
    ...(o.sending ? { sending_state: { _: "messageSendingStatePending", sending_id: 1 } } : {}),
    ...(o.replyTo ? { reply_to: { _: "messageReplyToMessage", chat_id: chatId, message_id: o.replyTo } } : {}),
    content: { _: "messageText", text: { _: "formattedText", text: o.text ?? `message ${id}`, entities: [] } },
  } as unknown as Td.message;
}

export const newMessage = (m: Td.message) => ({ _: "updateNewMessage", message: m });

/**
 * A FakeTd that answers getChat, getMe, scope settings, getMessageLocally and getChatHistory (newest first, at most `page`
 * per answer, as TDLib may) from `chats` and `history`. `methods` records every method asked for, refused ones included.
 */
export function scriptedTd(chats: Td.chat[], history: Record<number, Td.message[]>, page = 2) {
  const td = new FakeTd();
  const methods: string[] = [];
  const invoke = td.invoke.bind(td);
  td.invoke = ((req: { _: string }) => (methods.push(req._), invoke(req))) as typeof td.invoke;
  const byId = new Map(chats.map((c) => [c.id, c]));
  td.on("getChat", (r: any) => {
    const c = byId.get(r.chat_id);
    if (!c) throw new Error(`no chat ${r.chat_id}`);
    return c;
  });
  td.on("getMe", { _: "user", id: ME.user_id, first_name: "Owner", last_name: "", usernames: { active_usernames: ME.usernames }, type: { _: "userTypeRegular" } });
  td.on("getScopeNotificationSettings", { _: "scopeNotificationSettings", mute_for: 0 });
  td.on("getMessageLocally", (r: any) => {
    const m = (history[r.chat_id] ?? []).find((x) => x.id === r.message_id);
    if (!m) throw new Error("not found");
    return m;
  });
  // As TDLib reads it: from 0 is the newest; offset 0 starts AT from_message_id (or at the first message below a position that
  // holds none), a negative offset adds that many newer ones. Like TDLib answering from its local copy first, the first request
  // for a chat returns only one message.
  const asked = new Set<number>();
  td.on("getChatHistory", (r: any) => {
    const all = [...(history[r.chat_id] ?? [])].sort((a, b) => b.id - a.id);
    const at = r.from_message_id ? all.findIndex((m) => m.id <= r.from_message_id) : 0;
    const start = Math.max(0, (at < 0 ? all.length : at) + (r.offset ?? 0));
    const first = !asked.has(r.chat_id);
    asked.add(r.chat_id);
    const messages = all.slice(start, start + (first ? 1 : Math.min(r.limit, page)));
    return { _: "messages", total_count: messages.length, messages };
  });
  return { td, methods, addChat: (c: Td.chat) => byId.set(c.id, c) };
}

export const settings = (o: Partial<Settings> = {}): Settings => ({ muted: "tagged", exclude: new Set(), backfillDays: 30, ...o });

export function ingestOn(store: Store, td: FakeTd, s = settings()) {
  const ingest = createIngest({ td, store, me: () => ME, settings: s, log, now: () => NOW_MS });
  td.onUpdate((u) => void ingest.handle(u));
  return ingest;
}

export const outbox = (store: Store, target: "warehouse" | "kernel") =>
  (store.db.prepare(`SELECT payload FROM outbox WHERE target = ? ORDER BY seq`).all(target) as { payload: string }[]).map((r) => JSON.parse(r.payload));

/** The kernel's event router as a fake: the ids it accepted; `failNext` answers the next call with a 500. */
export function fakeKernel() {
  const k = {
    ids: [] as string[],
    events: [] as any[],
    failNext: false,
    notices: [] as { text: string; key: string }[],
    needs: [] as { cause: string; detail: string }[],
    async event(e: any) {
      if (k.failNext) {
        k.failNext = false;
        throw new Error("POST /v1/events -> 500");
      }
      k.ids.push(e.id);
      k.events.push(e);
    },
    async notify(text: string, key: string) {
      k.notices.push({ text, key });
    },
    async need(cause: string, detail: string) {
      k.needs.push({ cause, detail });
    },
  };
  return k;
}

/** src_telegram as a fake SourceStore: rows by table and key, merged per write as an upsert would. */
export function fakeWarehouse() {
  const rows = new Map<string, Record<string, any>>();
  const writes: { table: string; row: Record<string, any>; baseline: boolean }[] = [];
  const key = (table: string, row: Record<string, any>) => (table === "users" ? `users:${row.user_id}` : table === "chat" ? `chat:${row.chat_id}` : `${table}:${row.chat_id}/${row.message_id}`);
  const store = {
    migrate: async () => undefined,
    upsert: async (t: { name: string }, row: Record<string, any>, o: { baseline: boolean }) => {
      writes.push({ table: t.name, row, baseline: o.baseline });
      const k = key(t.name, row);
      rows.set(k, { ...(rows.get(k) ?? {}), ...row });
      return "new";
    },
    pool: {
      query: async (sql: string, args: any[]) => {
        if (sql.includes("FROM src_telegram.message")) {
          const r = rows.get(`message:${args[0]}/${args[1]}`);
          return { rows: r ? [{ deleted: r.deleted ?? false, edited_at: r.edited_at ?? null }] : [] };
        }
        return { rows: [] };
      },
    },
  };
  return { store: store as unknown as SourceStore, rows, writes, messageIds: (chatId: number) => [...rows.keys()].filter((k) => k.startsWith(`message:${chatId}/`)).map((k) => Number(k.split("/")[1])).sort((a, b) => a - b) };
}

export { openStore };

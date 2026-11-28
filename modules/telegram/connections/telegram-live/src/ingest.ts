// Ingest: every kept TDLib update commits, in one SQLite transaction, its warehouse rows, its kernel event and the chat's
// checkpoint into a local outbox; two drains then empty the outbox into idempotent sinks (keyed warehouse upserts, the kernel's
// event ids), so a crash never loses or double-fires a message. TDLib recovers its own update gaps; on top of that each chat
// keeps a durable checkpoint (Aria's lesson: GramJS's catchUp was a stub), reconciled from history on start, on reconnect and
// on TDLib's gap signals. Nothing here marks anything read (td.ts refuses those calls).
import type { Logger } from "pino";
import { chatKind, classify, formatted, isMuted, ownerAuthored, SCOPE_TD, scopeOf, storesChat, type ChatKind, type Scope, type ScopeSettings } from "./filter.js";
import type { Kernel, SourceEvent } from "./kernel.js";
import { contentRow, DDL, editedRow, messageRow, reactionRow, senderId, tombstone, userRow, writeRow, type WarehouseItem } from "./sources.js";
import { SourceStore, type Row } from "./source-store.js";
import type { Store } from "./store.js";
import { TdError, type Me, type TdClient, type TdUpdate } from "./td.js";
import type * as Td from "./tdlib-types.js";

export type Settings = { muted: "tagged" | "all"; exclude: Set<number>; backfillDays: number };

/** What ingest keeps of a chat: TDLib's chat object, kept current from its updates. */
export type ChatState = { id: number; kind: ChatKind; title: string; notif: Td.chatNotificationSettings; lists: Td.ChatList[]; last?: { id: number; date: number } };

/** live: an update; reconcile: a missed live message read from history (fires its event); backfill: old history (no event). */
type Mode = "live" | "reconcile" | "backfill";

export interface Ingest {
  /** Sequential: one update at a time. */
  handle(u: TdUpdate): Promise<void>;
  /** Reconciles these chats (default: every chat with a checkpoint) from history, back to each one's checkpoint. */
  reconcile(chatIds?: number[]): Promise<void>;
  markAgentSend(chatId: number, tempId: number, writeId: string): void;
  startDrains(o: { warehouse: SourceStore | undefined; kernel: Kernel }): void;
  /** Delivers everything queued, then returns; throws on the first failed delivery (it stays queued). */
  drain(o: { warehouse: SourceStore | undefined; kernel: Pick<Kernel, "event"> }): Promise<void>;
  liveBusy(): boolean;
  /** Resolves once every update handed in so far is handled. */
  idle(): Promise<void>;
  chat(id: number): Promise<ChatState>;
  /** Whether a chat's messages are stored (the filter's chat rules). */
  stores(c: ChatState): Promise<boolean>;
  /** Backfill's door: old messages, rows only. Returns how many were new. */
  ingestHistory(msgs: Td.message[]): Promise<number>;
  /** The chat's checkpoint, seeding it at its last message when it has none. */
  seed(c: ChatState): number;
  stop(): void;
}

/** Recorded before the executor's sendMessage returns its temporary id: a plain store write, usable before any Ingest exists. */
export function markAgentSend(store: Store, chatId: number, tempId: number, writeId: string): void {
  store.db.prepare(`INSERT OR REPLACE INTO agent_pending (chat_id, temp_message_id, write_id) VALUES (?, ?, ?)`).run(chatId, tempId, writeId);
}

/** A Postgres data (22xxx) or integrity-constraint (23xxx) error: the same row fails the same way every time. */
const permanent = (e: unknown) => /^2[23]/.test(String((e as { code?: unknown })?.code ?? ""));
const transient = (e: unknown) => !(e instanceof TdError) || e.code === 429 || e.code >= 500 || e.retryAfterS !== undefined;
const RETRY_MS = 30_000;
const STRIKES = 3;

export function createIngest(o: { td: TdClient; store: Store; me: () => Me | undefined; settings: Settings; kernel?: Pick<Kernel, "notify">; log: Pick<Logger, "info" | "warn" | "error">; now?: () => number }): Ingest {
  const { td, store, settings, log } = o;
  const now = o.now ?? Date.now;
  const db = store.db;
  const q = {
    ingested: db.prepare(`SELECT outgoing FROM ingested WHERE chat_id = ? AND message_id = ?`),
    ingest: db.prepare(`INSERT OR IGNORE INTO ingested (chat_id, message_id, outgoing) VALUES (?, ?, ?)`),
    root: db.prepare(`SELECT root_id FROM msg_root WHERE chat_id = ? AND message_id = ?`),
    setRoot: db.prepare(`INSERT OR IGNORE INTO msg_root (chat_id, message_id, root_id) VALUES (?, ?, ?)`),
    outbox: db.prepare(`INSERT INTO outbox (target, payload, created_at) VALUES (?, ?, ?)`),
    next: db.prepare(`SELECT seq, payload FROM outbox WHERE target = ? AND dead = 0 ORDER BY seq LIMIT 100`),
    done: db.prepare(`DELETE FROM outbox WHERE seq = ?`),
    dead: db.prepare(`UPDATE outbox SET dead = 1 WHERE seq = ?`),
    cp: db.prepare(`SELECT last_message_id AS id FROM checkpoint WHERE chat_id = ?`),
    cps: db.prepare(`SELECT chat_id AS id FROM checkpoint`),
    seedCp: db.prepare(`INSERT OR IGNORE INTO checkpoint (chat_id, last_message_id) VALUES (?, ?)`),
    advanceCp: db.prepare(`INSERT INTO checkpoint (chat_id, last_message_id) VALUES (?, ?) ON CONFLICT (chat_id) DO UPDATE SET last_message_id = max(last_message_id, excluded.last_message_id)`),
    pending: db.prepare(`SELECT write_id FROM agent_pending WHERE chat_id = ? AND temp_message_id = ?`),
    pendingDone: db.prepare(`UPDATE agent_pending SET final_message_id = ? WHERE chat_id = ? AND temp_message_id = ?`),
    pendingFailed: db.prepare(`UPDATE agent_pending SET error = ? WHERE chat_id = ? AND temp_message_id = ?`),
    agentSent: db.prepare(`SELECT 1 FROM agent_sent WHERE chat_id = ? AND message_id = ?`),
    setAgentSent: db.prepare(`INSERT OR IGNORE INTO agent_sent (chat_id, message_id) VALUES (?, ?)`),
    // An agent's send whose success update a crash lost comes back as a plain outgoing message: its text, in that chat, within
    // the hour, from an executor record still sending or unknown, keeps it from firing an event (a stored row either way).
    summoned: db.prepare(`SELECT 1 FROM summoned_chats WHERE chat_id = ? AND until > ?`),
    agentWrite: db.prepare(`SELECT 1 FROM writes WHERE chat_id = ? AND body = ? AND at > ? AND state IN ('sending', 'unknown') LIMIT 1`),
  };

  const chats = new Map<number, ChatState>();
  const scopes: Partial<ScopeSettings> = {};
  const bots = new Map<number, boolean>();
  const folders = new Map<number, string>();
  /** The last row written per chat / reaction / user, so TDLib's frequent repeats queue nothing. */
  const written = new Map<string, string>();
  /** Chats awaiting reconcile: live messages don't move their checkpoint, so it stays a durable low-water mark. Every chat
   * with a checkpoint waits for the start reconcile. */
  const frozen = new Set<number>((q.cps.all() as { id: number }[]).map((r) => r.id));
  const strikes = new Map<number, number>();
  const running = new Map<number, Promise<void>>();
  const timers = new Set<NodeJS.Timeout>();
  const wakers = new Set<() => void>();
  let chain = Promise.resolve();
  let busy = 0;
  let stopped = false;
  let me: Me | undefined;
  let connection: string | undefined;

  const isIngested = (c: number, m: number) => q.ingested.get(c, m) as { outgoing: number } | undefined;
  const checkpoint = (c: number) => (q.cp.get(c) as { id: number } | undefined)?.id;
  const push = (target: "warehouse" | "kernel", payload: unknown) => {
    q.outbox.run(target, JSON.stringify(payload), now());
    for (const w of wakers) w();
    wakers.clear();
  };
  const pushRow = (item: WarehouseItem, dedupe?: string) => {
    if (dedupe) {
      const json = JSON.stringify(item.row);
      if (written.get(dedupe) === json) return;
      written.set(dedupe, json);
    }
    push("warehouse", item);
  };

  async function meNow(): Promise<Me> {
    const m = o.me() ?? me;
    if (m) return m;
    const u = await td.invoke<Td.user>({ _: "getMe" });
    return (me = { user_id: u.id, usernames: u.usernames?.active_usernames ?? [], name: [u.first_name, u.last_name].filter(Boolean).join(" ") });
  }

  async function scopeMute(s: Scope): Promise<number> {
    if (scopes[s] === undefined) {
      try {
        scopes[s] = (await td.invoke<Td.scopeNotificationSettings>({ _: "getScopeNotificationSettings", scope: { _: SCOPE_TD[s] } })).mute_for;
      } catch (err) {
        log.warn({ err: String(err).slice(0, 200), scope: s }, "scope notification settings unread; treated as unmuted");
        return 0;
      }
    }
    return scopes[s]!;
  }

  const fromTd = (c: Td.chat): ChatState => ({
    id: c.id, kind: chatKind(c.type), title: c.title, notif: c.notification_settings, lists: [...(c.chat_lists ?? [])],
    ...(c.last_message ? { last: { id: c.last_message.id, date: c.last_message.date } } : {}),
  });

  async function chatOf(id: number): Promise<ChatState> {
    const have = chats.get(id);
    if (have) return have;
    const c = fromTd(await td.invoke<Td.chat>({ _: "getChat", chat_id: id }));
    chats.set(id, c);
    return c;
  }

  async function view(c: ChatState) {
    const muted = isMuted(c.notif, c.notif.use_default_mute_for ? await scopeMute(scopeOf(c.kind)) : 0);
    return { id: c.id, type: c.kind, muted };
  }
  const stores = async (c: ChatState) => storesChat(await view(c), settings.muted, settings.exclude);

  function chatRow(c: ChatState, muted: boolean): Row {
    return {
      chat_id: String(c.id), type: c.kind, title: c.title, muted,
      folders: c.lists.filter((l) => l._ === "chatListFolder").map((l) => folders.get((l as Td.chatListFolder).chat_folder_id) ?? String((l as Td.chatListFolder).chat_folder_id)),
      archived: c.lists.some((l) => l._ === "chatListArchive"), member_count: null,
    };
  }
  async function writeChat(c: ChatState): Promise<void> {
    const v = await view(c);
    if (!storesChat(v, settings.muted, settings.exclude)) return;
    store.tx(() => pushRow({ t: "chat", row: chatRow(c, v.muted) }, `chat:${c.id}`));
  }

  /** A chat's checkpoint, seeded at its last message on first sight (never at 0: older history is backfill's, not events). */
  function seed(c: ChatState): number {
    if (c.last) q.seedCp.run(c.id, c.last.id);
    return checkpoint(c.id) ?? 0;
  }

  /** One message through the filter and, when kept, into the outbox, exactly once. Lookups first; the transaction is sync. */
  async function ingestOne(m: Td.message, mode: Mode, agentSent = false): Promise<boolean> {
    if (m.sending_state || m.scheduling_state) return false; // a temporary id waits for its success update
    const c = await chatOf(m.chat_id);
    const v = await view(c);
    if (!storesChat(v, settings.muted, settings.exclude)) return false;
    if (isIngested(m.chat_id, m.id)) return false;
    const r = m.reply_to?._ === "messageReplyToMessage" && m.reply_to.chat_id === m.chat_id ? m.reply_to : undefined;
    let parentOwn = false;
    let root = m.id;
    if (r) {
      const known = isIngested(m.chat_id, r.message_id);
      parentOwn = known ? known.outgoing === 1 : Boolean((await td.invoke<Td.message>({ _: "getMessageLocally", chat_id: m.chat_id, message_id: r.message_id }).catch(() => undefined))?.is_outgoing);
      root = (q.root.get(m.chat_id, r.message_id) as { root_id: number } | undefined)?.root_id ?? r.message_id;
    }
    const text = formatted(m.content)?.text ?? "";
    const byAgent = agentSent || !!q.agentSent.get(m.chat_id, m.id) || (m.is_outgoing && !!text && !!q.agentWrite.get(m.chat_id, text, now() - 3_600_000));
    const owner = await meNow();
    const verdict = classify(m, {
      chat: v, me: owner, setting: settings.muted, excluded: settings.exclude, agentSent: byAgent, history: mode === "backfill", summoned: !!q.summoned.get(m.chat_id, now()),
      isOwnMessage: (chat, id) => (r && id === r.message_id ? parentOwn : isIngested(chat, id)?.outgoing === 1),
    });
    if (!verdict.store) return false;
    const topic = m.topic_id?._ === "messageTopicForum" ? m.topic_id.forum_topic_id : undefined;
    return store.tx(() => {
      if (!q.ingest.run(m.chat_id, m.id, m.is_outgoing ? 1 : 0).changes) return false;
      q.setRoot.run(m.chat_id, m.id, root);
      pushRow({ t: "chat", row: chatRow(c, v.muted) }, `chat:${c.id}`);
      pushRow({ t: "message", row: messageRow(m, { root, mentions_me: verdict.mentions_me, replies_to_me: verdict.replies_to_me }), ...(mode === "live" ? {} : { history: true }), ...(mode === "backfill" ? { baseline: true } : {}) });
      if (verdict.event) {
        const shown = text || `[${messageRow(m, { mentions_me: false, replies_to_me: false }).media_kind ?? "message"}]`;
        const sender = m.sender_id._ === "messageSenderUser" ? m.sender_id.user_id : undefined;
        const thread = topic !== undefined ? `t${topic}` : r ? String(root) : undefined;
        const e: SourceEvent = {
          connection: "telegram_account", resource: String(m.chat_id), id: `${m.chat_id}:${m.id}`, kind: "message", author: senderId(m.sender_id),
          text: shown.slice(0, 2000), ...(shown.length > 2000 ? { truncated: true } : {}), bot: sender !== undefined && bots.get(sender) === true,
          from_owner: ownerAuthored(m, owner), labels: verdict.labels,
          data: { chat_type: c.kind, mentions_me: verdict.mentions_me, replies_to_me: verdict.replies_to_me, outgoing: m.is_outgoing, ...(thread ? { thread } : {}) },
        };
        push("kernel", e);
      }
      if (mode !== "backfill") {
        q.seedCp.run(m.chat_id, c.last?.id ?? m.id);
        if (!frozen.has(m.chat_id)) q.advanceCp.run(m.chat_id, m.id);
      }
      return true;
    });
  }

  /** A non-message change to a message we hold: rows only, never an event. */
  const changeRow = (chatId: number, messageId: number, item: WarehouseItem, dedupe?: string) => {
    if (!isIngested(chatId, messageId)) return;
    store.tx(() => pushRow(item, dedupe));
  };

  async function process(u: TdUpdate): Promise<void> {
    switch (u._) {
      case "updateNewMessage":
        await ingestOne((u as unknown as Td.updateNewMessage).message, "live");
        return;
      case "updateMessageSendSucceeded": {
        const x = u as unknown as Td.updateMessageSendSucceeded;
        const pending = q.pending.get(x.message.chat_id, x.old_message_id);
        if (pending)
          store.tx(() => {
            q.pendingDone.run(x.message.id, x.message.chat_id, x.old_message_id);
            q.setAgentSent.run(x.message.chat_id, x.message.id);
          });
        await ingestOne(x.message, "live", !!pending);
        return;
      }
      case "updateMessageSendFailed": {
        const x = u as unknown as Td.updateMessageSendFailed;
        q.pendingFailed.run(x.error.message, x.message.chat_id, x.old_message_id);
        return;
      }
      case "updateMessageContent": {
        const x = u as unknown as Td.updateMessageContent;
        return changeRow(x.chat_id, x.message_id, { t: "message", row: contentRow(x.chat_id, x.message_id, x.new_content) });
      }
      case "updateMessageEdited": {
        const x = u as unknown as Td.updateMessageEdited;
        return changeRow(x.chat_id, x.message_id, { t: "message", row: editedRow(x.chat_id, x.message_id, x.edit_date) });
      }
      case "updateDeleteMessages": {
        const x = u as unknown as Td.updateDeleteMessages;
        if (!x.is_permanent || x.from_cache) return;
        for (const id of x.message_ids) changeRow(x.chat_id, id, { t: "tombstone", row: tombstone(x.chat_id, id) });
        return;
      }
      case "updateMessageInteractionInfo": {
        const x = u as unknown as Td.updateMessageInteractionInfo;
        // View and forward counts change constantly in channels: only a change of reactions queues a row.
        return changeRow(x.chat_id, x.message_id, { t: "reaction", row: reactionRow(x.chat_id, x.message_id, x.interaction_info) }, `reaction:${x.chat_id}:${x.message_id}`);
      }
      case "updateNewChat": {
        const c = fromTd((u as unknown as Td.updateNewChat).chat);
        chats.set(c.id, c);
        if (await stores(c)) seed(c);
        return writeChat(c);
      }
      case "updateChatTitle":
      case "updateChatNotificationSettings":
      case "updateChatAddedToList":
      case "updateChatRemovedFromList":
      case "updateChatLastMessage": {
        const x = u as unknown as { chat_id: number };
        const c = chats.get(x.chat_id);
        if (!c) return; // TDLib sends updateNewChat first; a chat we never loaded is read with getChat when it matters
        if (u._ === "updateChatTitle") c.title = (u as unknown as Td.updateChatTitle).title;
        if (u._ === "updateChatNotificationSettings") c.notif = (u as unknown as Td.updateChatNotificationSettings).notification_settings;
        if (u._ === "updateChatAddedToList") c.lists.push((u as unknown as Td.updateChatAddedToList).chat_list);
        if (u._ === "updateChatRemovedFromList") {
          const gone = JSON.stringify((u as unknown as Td.updateChatRemovedFromList).chat_list);
          c.lists = c.lists.filter((l) => JSON.stringify(l) !== gone);
        }
        if (u._ === "updateChatLastMessage") {
          const last = (u as unknown as Td.updateChatLastMessage).last_message;
          if (last && !last.sending_state) {
            c.last = { id: last.id, date: last.date };
            const cp = checkpoint(c.id);
            // First sight of its last message (TDLib may send the chat without one): seed, never reconcile.
            if (cp === undefined) {
              if (await stores(c)) seed(c);
              return;
            }
            // A gap signal: TDLib's newest message for a chat we hold, above its checkpoint, never ingested.
            if (last.id > cp && !isIngested(c.id, last.id) && !frozen.has(c.id) && (await stores(c))) void reconcile([c.id]);
          }
          return;
        }
        return writeChat(c);
      }
      case "updateScopeNotificationSettings": {
        const x = u as unknown as Td.updateScopeNotificationSettings;
        const s = (Object.keys(SCOPE_TD) as Scope[]).find((k) => SCOPE_TD[k] === x.scope._);
        if (!s) return;
        scopes[s] = x.notification_settings.mute_for;
        for (const c of chats.values()) if (scopeOf(c.kind) === s) await writeChat(c);
        return;
      }
      case "updateChatFolders": {
        for (const f of (u as unknown as Td.updateChatFolders).chat_folders) folders.set(f.id, f.name.text.text);
        for (const c of chats.values()) await writeChat(c);
        return;
      }
      case "updateUser": {
        const user = (u as unknown as Td.updateUser).user;
        bots.set(user.id, user.type._ === "userTypeBot");
        store.tx(() => pushRow({ t: "user", row: userRow(user) }, `user:${user.id}`));
        return;
      }
      case "updateConnectionState": {
        const state = (u as unknown as Td.updateConnectionState).state._;
        const was = connection;
        connection = state;
        // Back online after a drop: TDLib refetches what it missed, and we check every chat against its checkpoint too.
        if (state === "connectionStateReady" && was !== undefined && was !== state) void reconcile();
        return;
      }
    }
  }

  function retryLater(id: number) {
    if (stopped) return;
    const t = setTimeout(() => {
      timers.delete(t);
      void reconcile([id]);
    }, RETRY_MS);
    t.unref?.();
    timers.add(t);
  }

  async function reconcileChat(id: number): Promise<void> {
    const cp = checkpoint(id);
    if (cp === undefined) return void frozen.delete(id);
    let newest = cp;
    try {
      const floor = now() / 1000 - settings.backfillDays * 86_400;
      const seen = new Set<number>();
      const missed: Td.message[] = [];
      let from = 0;
      let stalled = false;
      for (;;) {
        // From 0 the newest page; then strictly older than the oldest seen (offset 0 starts below from_message_id). A page with
        // nothing new is asked once more before it counts as the end (TDLib answers from its local copy first).
        const page = await td.invoke<Td.messages>({ _: "getChatHistory", chat_id: id, from_message_id: from, offset: 0, limit: 100, only_local: false });
        const msgs = page.messages.filter((m): m is Td.message => !!m);
        let fresh = 0;
        let reached = false;
        for (const m of msgs) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          fresh++;
          newest = Math.max(newest, m.id);
          if (m.id <= cp || m.date < floor) reached = true;
          else missed.push(m);
        }
        // TDLib may answer with fewer than `limit`: page on until the checkpoint or the window's edge.
        if (reached) break;
        if (fresh === 0) {
          if (stalled) break;
          stalled = true;
          continue;
        }
        stalled = false;
        from = Math.min(...msgs.map((m) => m.id));
      }
      missed.sort((a, b) => a.id - b.id);
      for (const m of missed) await ingestOne(m, "reconcile");
      // The newest id this read saw, not the newest ingested: a message whose ingest failed meanwhile stays above the mark.
      q.advanceCp.run(id, newest);
      strikes.delete(id);
      frozen.delete(id);
    } catch (err) {
      if (stopped) return;
      if (transient(err)) {
        log.warn({ chat: id, err: String(err).slice(0, 200) }, "reconcile failed; retrying");
        return retryLater(id);
      }
      const n = (strikes.get(id) ?? 0) + 1;
      strikes.set(id, n);
      if (n < STRIKES) return retryLater(id);
      strikes.delete(id);
      const c = chats.get(id);
      const since = new Date(now()).toISOString().slice(0, 16).replace("T", " "); // UTC, said in the notice
      log.error({ chat: id, err: String(err).slice(0, 200) }, "reconcile gave up; owner told");
      void o.kernel?.notify(`Telegram: messages in ${c?.title ?? `chat ${id}`} since checkpoint ${cp} could not be recovered (checked ${since} UTC). Open the chat in Telegram to read them.`, `telegram:gap:${id}`);
      q.advanceCp.run(id, Math.max(newest, c?.last?.id ?? 0));
      frozen.delete(id);
    }
  }

  async function reconcile(chatIds?: number[]): Promise<void> {
    const ids = chatIds ?? (q.cps.all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) frozen.add(id);
    // One chat at a time (paced); a second trigger for a chat already running waits for it, then runs again.
    for (const id of ids) {
      if (stopped) return;
      const prev = running.get(id) ?? Promise.resolve();
      const run = prev.then(() => reconcileChat(id));
      running.set(id, run);
      await run;
      if (running.get(id) === run) running.delete(id);
    }
  }

  async function drainTarget(target: "warehouse" | "kernel", deliver: (p: any) => Promise<void>): Promise<number> {
    let n = 0;
    for (;;) {
      const rows = q.next.all(target) as { seq: number; payload: string }[];
      if (!rows.length || stopped) return n;
      for (const r of rows) {
        try {
          await deliver(JSON.parse(r.payload));
        } catch (err) {
          // A row Postgres rejects for good (data or constraint error) is set aside so the rows behind it still land; anything else retries.
          if (!permanent(err)) throw err;
          log.error({ target, seq: r.seq, err: String((err as Error).message ?? err).slice(0, 300) }, "outbox row rejected for good; set aside");
          q.dead.run(r.seq);
          continue;
        }
        q.done.run(r.seq);
        n++;
      }
    }
  }
  const toWarehouse = (wh: SourceStore) => async (item: WarehouseItem) => {
    await wh.migrate(DDL);
    await writeRow(wh, item);
  };

  function loop(target: "warehouse" | "kernel", deliver: () => ((p: any) => Promise<void>) | undefined) {
    let backoff = 1000;
    const sleep = (ms: number, wakeable = false) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          timers.delete(t);
          wakers.delete(done);
          resolve();
        }
        timers.add(t);
        if (wakeable) wakers.add(done);
      });
    void (async () => {
      while (!stopped) {
        const d = deliver();
        if (!d) {
          await sleep(60_000);
          continue;
        }
        try {
          const n = await drainTarget(target, d);
          backoff = 1000;
          if (!n) await sleep(1000, true);
        } catch (err) {
          log.warn({ target, err: String((err as Error).message ?? err).slice(0, 300) }, "outbox delivery failed; retrying");
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    })();
  }

  return {
    handle(u) {
      busy++;
      chain = chain
        .then(() => process(u))
        .catch((err) => {
          log.warn({ update: u._, err: String((err as Error)?.message ?? err).slice(0, 300) }, "update not handled");
          // A message whose update failed is read back from history (its chat waits for that, so no later message passes it).
          const m = (u as { message?: { chat_id?: unknown } }).message;
          if (typeof m?.chat_id === "number" && !stopped) void reconcile([m.chat_id]);
        })
        .finally(() => void busy--);
      return chain;
    },
    reconcile,
    markAgentSend: (c, t, w) => markAgentSend(store, c, t, w),
    startDrains({ warehouse, kernel }) {
      let wh = warehouse;
      loop("warehouse", () => {
        wh ??= SourceStore.fromEnv("telegram");
        return wh ? toWarehouse(wh) : undefined;
      });
      loop("kernel", () => (e: SourceEvent) => kernel.event(e));
    },
    async drain({ warehouse, kernel }) {
      if (warehouse) await drainTarget("warehouse", toWarehouse(warehouse));
      await drainTarget("kernel", (e: SourceEvent) => kernel.event(e));
    },
    liveBusy: () => busy > 0,
    idle: () => chain,
    chat: chatOf,
    stores,
    async ingestHistory(msgs) {
      let n = 0;
      for (const m of msgs) if (await ingestOne(m, "backfill")) n++;
      return n;
    },
    seed,
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const w of wakers) w();
    },
  };
}


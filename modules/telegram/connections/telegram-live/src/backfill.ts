// Backfill: on first connect, each stored chat's history back to telegram_backfill_days, newest chats first. Paced: two chats
// at a time, live work first, Telegram's flood waits honoured and persisted, every page's position persisted so a restart
// resumes. Rows only: backfilled messages fire no events, never revive a deleted message and never overwrite a newer edit.
// Each chat is read from its checkpoint down, so it never touches messages that live ingest and reconcile own.
import type { Logger } from "pino";
import type { Ingest } from "./ingest.js";
import type { Store } from "./store.js";
import { TdError, type TdClient } from "./td.js";
import type * as Td from "./tdlib-types.js";

const WORKERS = 2;
const PAGE = 100;

export type Progress = { chats_done: number; chats_total: number; oldest?: string; waiting?: boolean };

export function startBackfill(o: {
  td: TdClient; store: Store; ingest: Ingest; days: number; log: Pick<Logger, "info" | "warn">;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}): { progress(): Progress; done: Promise<void>; stop(): void } {
  const { td, store, ingest, log } = o;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const db = store.db;
  const q = {
    insert: db.prepare(`INSERT OR IGNORE INTO backfill (chat_id, from_message_id, done, order_key) VALUES (?, ?, ?, ?)`),
    next: db.prepare(`SELECT chat_id, from_message_id, flood_until FROM backfill WHERE done = 0 ORDER BY order_key DESC, chat_id`),
    row: db.prepare(`SELECT from_message_id, flood_until FROM backfill WHERE chat_id = ?`),
    from: db.prepare(`UPDATE backfill SET from_message_id = ? WHERE chat_id = ?`),
    flood: db.prepare(`UPDATE backfill SET flood_until = ? WHERE chat_id = ?`),
    done: db.prepare(`UPDATE backfill SET done = 1 WHERE chat_id = ?`),
    count: db.prepare(`SELECT count(*) AS total, coalesce(sum(done), 0) AS done FROM backfill`),
  };
  const claimed = new Set<number>();
  const waiting = new Set<number>();
  let oldest: number | undefined;
  let stopped = false;
  const cutoff = () => now() / 1000 - o.days * 86_400;

  /** First run only: every chat of Main and Archive, one row per chat whose messages are stored. */
  async function plan(): Promise<void> {
    if (store.getKv("backfill_started")) return;
    const ids: number[] = [];
    for (const list of [{ _: "chatListMain" }, { _: "chatListArchive" }]) {
      for (;;) {
        try {
          await td.invoke({ _: "loadChats", chat_list: list, limit: 100 });
        } catch (err) {
          if (err instanceof TdError && err.code === 404) break; // every chat of the list is loaded
          throw err;
        }
      }
      ids.push(...(await td.invoke<Td.chats>({ _: "getChats", chat_list: list, limit: 100_000 })).chat_ids);
    }
    await ingest.idle(); // the chats' own updates (their last messages) land before they are seeded
    const rows: { id: number; from: number; order: number }[] = [];
    for (const id of new Set(ids)) {
      const c = await ingest.chat(id);
      if (!(await ingest.stores(c))) continue;
      const from = ingest.seed(c);
      if (from > 0) rows.push({ id, from, order: c.last?.date ?? 0 });
    }
    store.tx(() => {
      for (const r of rows) q.insert.run(r.id, r.from, 0, r.order);
      store.setKv("backfill_started", new Date(now()).toISOString());
    });
    log.info({ chats: rows.length }, "backfill planned");
  }

  async function chat(id: number): Promise<void> {
    let boundaryOnly = 0;
    while (!stopped) {
      const row = q.row.get(id) as { from_message_id: number; flood_until: number | null };
      if (row.flood_until && row.flood_until > now()) {
        waiting.add(id);
        await sleep(row.flood_until - now());
        waiting.delete(id);
        continue;
      }
      while (ingest.liveBusy() && !stopped) await sleep(200);
      if (stopped) return;
      const from = row.from_message_id;
      let page: Td.messages;
      try {
        // offset -1: the page includes from_message_id itself (offset 0 starts below it).
        page = await td.invoke<Td.messages>({ _: "getChatHistory", chat_id: id, from_message_id: from, offset: -1, limit: PAGE, only_local: false });
      } catch (err) {
        if (err instanceof TdError && err.retryAfterS !== undefined) {
          q.flood.run(now() + err.retryAfterS * 1000, id);
          continue;
        }
        if (err instanceof TdError && err.code < 500) {
          log.warn({ chat: id, err: err.message }, "backfill skipped a chat");
          q.done.run(id);
          return;
        }
        throw err;
      }
      const msgs = page.messages.filter((m): m is Td.message => !!m && m.id <= from);
      const edge = cutoff();
      const inWindow = msgs.filter((m) => m.date >= edge);
      await ingest.ingestHistory(inWindow);
      for (const m of inWindow) oldest = Math.min(oldest ?? m.date, m.date);
      const older = msgs.filter((m) => m.id < from);
      // TDLib may answer a page with only its starting message: ask once more before calling the chat done.
      if (!older.length && msgs.length && boundaryOnly++ === 0) continue;
      if (!older.length || inWindow.length < msgs.length) {
        q.done.run(id);
        return;
      }
      q.from.run(Math.min(...older.map((m) => m.id)), id);
    }
  }

  async function worker(): Promise<void> {
    while (!stopped) {
      const next = (q.next.all() as { chat_id: number }[]).find((r) => !claimed.has(r.chat_id));
      if (!next) return;
      claimed.add(next.chat_id);
      await chat(next.chat_id);
    }
  }

  const done = (async () => {
    await plan();
    const results = await Promise.allSettled(Array.from({ length: WORKERS }, () =>
      worker().catch((err) => {
        stopped = true; // one failure stops the others; the next start resumes from the persisted positions
        throw err;
      })));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    log.info(q.count.get() as object, "backfill done");
  })();

  return {
    progress() {
      const c = q.count.get() as { total: number; done: number };
      return { chats_done: c.done, chats_total: c.total, ...(oldest ? { oldest: new Date(oldest * 1000).toISOString() } : {}), ...(waiting.size ? { waiting: true } : {}) };
    },
    done,
    stop: () => void (stopped = true),
  };
}

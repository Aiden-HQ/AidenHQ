import { describe, expect, it } from "vitest";
import { startBackfill } from "../src/backfill.js";
import { READ_STATE_METHODS, TdError } from "../src/td.js";
import type * as Td from "../src/tdlib-types.js";
import { chat, DAY_S, fakeKernel, fakeWarehouse, ingestOn, log, msg, NOW_MS, openStore, outbox, scriptedTd, tmpDb } from "./helpers.js";

const NOW_S = NOW_MS / 1000;
/** n messages, ids 1..n, the newest a minute old and each `stepDays` older than the next. */
const history = (chatId: number, n: number, stepDays: number) =>
  Array.from({ length: n }, (_, i) => msg(chatId, i + 1, { date: Math.round(NOW_S - 60 - (n - 1 - i) * stepDays * DAY_S) }));

function boot(db: string, chats: Td.chat[], hist: Record<number, Td.message[]>, page = 100) {
  const store = openStore(db);
  const t = scriptedTd(chats, hist, page);
  const loaded = new Set<string>();
  t.td.on("loadChats", (r: any) => {
    if (loaded.has(r.chat_list._)) throw new TdError(404, "Not Found");
    loaded.add(r.chat_list._);
    return { _: "ok" };
  });
  t.td.on("getChats", (r: any) => ({ _: "chats", total_count: 0, chat_ids: r.chat_list._ === "chatListMain" ? chats.map((c) => c.id) : [] }));
  const ingest = ingestOn(store, t.td);
  return { store, ...t, ingest };
}

describe("backfill", () => {
  it("resumes after a crash, stays in the window, fires no events", async () => {
    const db = tmpDb();
    const a = chat(-2001, "supergroup", { last: 250 });
    const b = chat(9, "dm", { last: 30 });
    const muted = chat(-2002, "channel", { muted: true, last: 5 });
    // a: 250 messages back 50 days (only the last 30 days are fetched); b: 30 recent ones.
    const hist: Record<number, Td.message[]> = { [-2001]: history(-2001, 250, 0.2), 9: history(9, 30, 0.01), [-2002]: history(-2002, 5, 0.01) };
    const inWindow = (cid: number) => hist[cid]!.filter((m) => m.date >= NOW_S - 30 * DAY_S).map((m) => m.id);
    const wh = fakeWarehouse();
    const kernel = fakeKernel();
    const methods: string[] = [];

    // The first run dies at its second history page.
    let p = boot(db, [a, b, muted], hist);
    let pages = 0;
    const real = p.td.invoke.bind(p.td);
    p.td.invoke = (async (req: any) => {
      if (req._ === "getChatHistory" && ++pages === 2) throw new Error("crash");
      return real(req);
    }) as typeof p.td.invoke;
    let bf = startBackfill({ td: p.td, store: p.store, ingest: p.ingest, days: 30, log, now: () => NOW_MS, sleep: async () => {} });
    await expect(bf.done).rejects.toThrow("crash");
    expect(p.store.db.prepare(`SELECT chat_id FROM backfill ORDER BY chat_id`).all()).toEqual([{ chat_id: -2001 }, { chat_id: 9 }]); // the muted channel: none
    await p.ingest.drain({ warehouse: wh.store, kernel });
    methods.push(...p.methods);
    p.ingest.stop();
    p.store.db.close();

    p = boot(db, [a, b, muted], hist);
    bf = startBackfill({ td: p.td, store: p.store, ingest: p.ingest, days: 30, log, now: () => NOW_MS, sleep: async () => {} });
    await bf.done;
    expect(outbox(p.store, "kernel")).toEqual([]);
    await p.ingest.drain({ warehouse: wh.store, kernel });
    methods.push(...p.methods);
    expect(kernel.ids).toEqual([]);
    expect(wh.messageIds(-2001)).toEqual(inWindow(-2001));
    expect(wh.messageIds(9)).toEqual(inWindow(9));
    expect(wh.messageIds(-2002)).toEqual([]);
    // Exactly once: each message was queued once across both runs.
    const msgWrites = wh.writes.filter((w) => w.table === "message").map((w) => `${w.row.chat_id}/${w.row.message_id}`);
    expect(msgWrites.length).toBe(new Set(msgWrites).size);
    expect(wh.writes.filter((w) => w.table === "message").every((w) => w.baseline)).toBe(true);
    expect(bf.progress()).toMatchObject({ chats_done: 2, chats_total: 2 });
    expect(inWindow(-2001).length).toBeLessThan(250);
    expect(methods.filter((m) => READ_STATE_METHODS.has(m))).toEqual([]);
    p.ingest.stop();
  });

  it("a flood wait is persisted and waited out", async () => {
    const db = tmpDb();
    const c = chat(10, "dm", { last: 3 });
    const p = boot(db, [c], { 10: history(10, 3, 0.01) });
    let clock = NOW_MS;
    const slept: number[] = [];
    let floods = 0;
    const real = p.td.invoke.bind(p.td);
    p.td.invoke = (async (req: any) => {
      if (req._ === "getChatHistory" && floods++ === 0) throw new TdError(429, "Too Many Requests: retry after 5");
      return real(req);
    }) as typeof p.td.invoke;
    const bf = startBackfill({
      td: p.td, store: p.store, ingest: p.ingest, days: 30, log, now: () => clock,
      sleep: async (ms) => {
        if (ms >= 1000) expect(p.store.db.prepare(`SELECT flood_until FROM backfill WHERE chat_id = 10`).get()).toEqual({ flood_until: NOW_MS + 5000 });
        slept.push(ms);
        clock += ms;
      },
    });
    await bf.done;
    expect(slept).toContain(5000);
    expect(bf.progress()).toMatchObject({ chats_done: 1, chats_total: 1 });
    expect(p.store.db.prepare(`SELECT count(*) AS n FROM ingested WHERE chat_id = 10`).get()).toEqual({ n: 3 });
    p.ingest.stop();
  });
});

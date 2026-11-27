// Exactly once across crashes: every kept message reaches the warehouse and fires its event once, whether the process dies
// between commit and drain, before an update commits (at an update or at an invoke), or with live messages racing reconcile.
import { describe, expect, it } from "vitest";
import { writeRow, messageRow } from "../src/sources.js";
import { READ_STATE_METHODS } from "../src/td.js";
import type * as Td from "../src/tdlib-types.js";
import { chat, fakeKernel, fakeWarehouse, ingestOn, msg, newMessage, openStore, outbox, scriptedTd, tmpDb } from "./helpers.js";

const range = (chatId: number, ids: number[]) => ids.map((id) => msg(chatId, id));
const checkpoint = (db: string, chatId: number) => (openStore(db).db.prepare(`SELECT last_message_id AS id FROM checkpoint WHERE chat_id = ?`).get(chatId) as { id: number } | undefined)?.id;

/** One process lifetime: a store on the shared file, a TDLib fake over `history`, and ingest wired to it. */
function boot(db: string, chats: Td.chat[], history: Record<number, Td.message[]>) {
  const store = openStore(db);
  const t = scriptedTd(chats, history);
  const ingest = ingestOn(store, t.td);
  const crash = () => {
    ingest.stop();
    store.db.close();
  };
  return { store, ...t, ingest, crash };
}

describe("reconcile", () => {
  it("kill between commit and drain, and at an update before commit: each message once", async () => {
    const db = tmpDb();
    const dm = chat(7, "dm", { last: 0 });
    const kernel = fakeKernel();
    const wh = fakeWarehouse();
    const methods: string[] = [];

    // 1. Messages 1-3 commit; the process dies before anything drains.
    let p = boot(db, [dm], {});
    p.td.emit({ _: "updateNewChat", chat: dm });
    for (const m of range(7, [1, 2, 3])) p.td.emit(newMessage(m));
    await p.ingest.idle();
    methods.push(...p.methods);
    p.crash();

    p = boot(db, [dm], { 7: range(7, [1, 2, 3]) });
    await p.ingest.reconcile();
    kernel.failNext = true; // the kernel answers 500 once: the row stays queued
    await expect(p.ingest.drain({ warehouse: wh.store, kernel })).rejects.toThrow("500");
    await p.ingest.drain({ warehouse: wh.store, kernel });
    expect(kernel.ids).toEqual(["7:1", "7:2", "7:3"]);

    // 2. The update for message 4 never commits (the process dies at it); 5 and 6 arrive while it is down.
    p.td.crashAtUpdate(1);
    expect(() => p.td.emit(newMessage(msg(7, 4)))).toThrow("crash");
    methods.push(...p.methods);
    p.crash();

    p = boot(db, [dm], { 7: range(7, [1, 2, 3, 4, 5, 6]) });
    await p.ingest.reconcile();
    await p.ingest.drain({ warehouse: wh.store, kernel });
    expect(kernel.ids).toEqual(["7:1", "7:2", "7:3", "7:4", "7:5", "7:6"]);
    expect(wh.messageIds(7)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(checkpoint(db, 7)).toBe(6);

    // 2b. The process dies at an invoke inside an update (the chat lookup of a fresh process): nothing commits.
    methods.push(...p.methods);
    p.crash();
    p = boot(db, [dm], { 7: range(7, [1, 2, 3, 4, 5, 6, 7]) });
    p.td.crashAtInvoke(1);
    p.td.emit(newMessage(msg(7, 7)));
    await p.ingest.idle();
    expect(outbox(p.store, "kernel")).toEqual([]);
    methods.push(...p.methods);
    p.crash();
    p = boot(db, [dm], { 7: range(7, [1, 2, 3, 4, 5, 6, 7]) });
    await p.ingest.reconcile();
    await p.ingest.drain({ warehouse: wh.store, kernel });
    expect(kernel.ids.filter((id) => id === "7:7")).toHaveLength(1);
    methods.push(...p.methods);
    p.crash();
    expect(methods.filter((m) => READ_STATE_METHODS.has(m))).toEqual([]);
  });

  it("a supergroup: a lost message recovered once, and TDLib's redelivery fires nothing", async () => {
    const db = tmpDb();
    const sg = chat(-1001, "supergroup", { last: 0 });
    const kernel = fakeKernel();
    const wh = fakeWarehouse();
    let p = boot(db, [sg], {});
    p.td.emit({ _: "updateNewChat", chat: sg });
    for (const m of range(-1001, [1, 2, 3])) p.td.emit(newMessage(m));
    await p.ingest.idle();
    p.td.crashAtUpdate(1);
    expect(() => p.td.emit(newMessage(msg(-1001, 4)))).toThrow("crash");
    p.crash();

    p = boot(db, [sg], { [-1001]: range(-1001, [1, 2, 3, 4, 5, 6]) });
    await p.ingest.reconcile();
    p.td.emit(newMessage(msg(-1001, 5))); // TDLib delivers 5 again after the restart
    await p.ingest.idle();
    await p.ingest.drain({ warehouse: wh.store, kernel });
    expect(kernel.ids).toEqual(["-1001:1", "-1001:2", "-1001:3", "-1001:4", "-1001:5", "-1001:6"]);
    expect(wh.messageIds(-1001)).toEqual([1, 2, 3, 4, 5, 6]);
    p.crash();
  });

  it("live before reconcile: a lost message is still recovered, even across a second crash", async () => {
    const db = tmpDb();
    const sg = chat(-1002, "supergroup", { last: 0 });
    const kernel = fakeKernel();
    const wh = fakeWarehouse();
    let p = boot(db, [sg], {});
    p.td.emit({ _: "updateNewChat", chat: sg });
    for (const m of range(-1002, [1, 2, 3])) p.td.emit(newMessage(m));
    await p.ingest.idle();
    p.td.crashAtUpdate(1);
    expect(() => p.td.emit(newMessage(msg(-1002, 4)))).toThrow("crash");
    p.crash();

    // Restarted: 7 arrives live before reconcile runs. It fires, but the checkpoint stays below the lost 4.
    p = boot(db, [sg], { [-1002]: range(-1002, [1, 2, 3, 4, 7]) });
    p.td.emit(newMessage(msg(-1002, 7)));
    await p.ingest.idle();
    expect(checkpoint(db, -1002)).toBe(3);
    p.crash(); // and dies again before reconciling

    p = boot(db, [sg], { [-1002]: range(-1002, [1, 2, 3, 4, 7]) });
    await p.ingest.reconcile();
    await p.ingest.drain({ warehouse: wh.store, kernel });
    expect(kernel.ids.sort()).toEqual(["-1002:1", "-1002:2", "-1002:3", "-1002:4", "-1002:7"]);
    expect(checkpoint(db, -1002)).toBe(7);
    p.crash();
  });

  it("a chat first seen after a restart is seeded at its last message: nothing older, no event", async () => {
    const db = tmpDb();
    const fresh = chat(-1003, "supergroup", { last: 9 });
    const kernel = fakeKernel();
    const p = boot(db, [fresh], { [-1003]: range(-1003, [1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    p.td.emit({ _: "updateNewChat", chat: fresh });
    await p.ingest.idle();
    await p.ingest.reconcile();
    await p.ingest.drain({ warehouse: undefined, kernel });
    expect(checkpoint(db, -1003)).toBe(9);
    expect(kernel.ids).toEqual([]);
    expect(p.store.db.prepare(`SELECT count(*) AS n FROM ingested`).get()).toEqual({ n: 0 });
    p.crash();
  });

  it("a history read never revives a message deleted live", async () => {
    const db = tmpDb();
    const dm = chat(8, "dm");
    const wh = fakeWarehouse();
    const p = boot(db, [dm], {});
    p.td.emit(newMessage(msg(8, 2)));
    p.td.emit({ _: "updateDeleteMessages", chat_id: 8, message_ids: [2], is_permanent: true, from_cache: false });
    await p.ingest.idle();
    await p.ingest.drain({ warehouse: wh.store, kernel: fakeKernel() });
    expect(wh.rows.get("message:8/2")).toMatchObject({ deleted: true, text: null });
    await writeRow(wh.store, { t: "message", row: messageRow(msg(8, 2), { mentions_me: false, replies_to_me: false }), history: true });
    expect(wh.rows.get("message:8/2")).toMatchObject({ deleted: true, text: null });
    p.crash();
  });
});

import { describe, expect, it, vi } from "vitest";
import { eventWrite, gapSync, MESSAGE, type Api } from "../src/sources.js";
import type { SourceStore } from "../src/source-store.js";

// The writer side against a fake store: what lands, and with which baseline flag (the SQL itself was smoke-run on postgres:17).
function fakeStore() {
  const scopes = new Map<string, { baselined: boolean; cursor: string | null; syncedAt: number }>();
  const clock = { t: 0 }; // what a save is stamped with (the real store uses the database's now())
  const writes: { table: string; row: Record<string, any>; baseline: boolean }[] = [];
  const store = {
    migrate: async () => undefined,
    scope: async (s: string) => scopes.get(s) ?? { baselined: false, cursor: null },
    scopesByPrefix: async (p: string) => new Map([...scopes].filter(([k]) => k.startsWith(p))),
    saveScope: async (s: string, cursor: string | null, baselined = false) => void scopes.set(s, { baselined: baselined || !!scopes.get(s)?.baselined, cursor: cursor ?? scopes.get(s)?.cursor ?? null, syncedAt: clock.t }),
    upsert: async (t: { name: string }, row: Record<string, any>, o: { baseline: boolean }) => (writes.push({ table: t.name, row, baseline: o.baseline }), "new"),
    pool: { query: async () => ({ rows: [] }) },
  };
  return { store: store as unknown as SourceStore, writes, scopes, clock };
}

describe("src_slack", () => {
  it("tees every message event: bots and their attachments kept, edits as the new text, deletes as tombstones", () => {
    const bot = eventWrite({ event: { type: "message", subtype: "bot_message", bot_id: "B1", channel: "C1", channel_type: "channel", ts: "1.1", text: "", attachments: [{ title: "Deploy", text: "v1.2 released" }] } });
    expect(bot?.row).toMatchObject({ channel_id: "C1", ts: "1.1", channel_type: "public", bot_id: "B1", text: "Deploy\nv1.2 released", deleted: false });
    const edit = eventWrite({ event: { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", message: { ts: "2.2", text: "fixed", user: "U1", edited: { ts: "3" } } } });
    expect(edit?.row).toMatchObject({ channel_id: "D1", ts: "2.2", channel_type: "im", text: "fixed", user_id: "U1" });
    const del = eventWrite({ event: { type: "message", subtype: "message_deleted", channel: "D1", deleted_ts: "2.2" } });
    expect(del?.row).toMatchObject({ ts: "2.2", deleted: true, text: null });
    expect(del?.row).not.toHaveProperty("channel_type"); // Slack didn't say: never guessed (the view falls back to the channel's type)
    // A deleted thread parent comes as an edit to subtype "tombstone": still a tombstone, never a text revision.
    expect(eventWrite({ event: { type: "message", subtype: "message_changed", channel: "C1", message: { ts: "5.5", subtype: "tombstone", text: "This message was deleted." } } })?.row).toMatchObject({ ts: "5.5", deleted: true, text: null });
    expect(eventWrite({ event: { type: "reaction_added", channel: "C1" } })).toBeNull();
    expect(eventWrite({ event: { type: "message", channel: "C1", ts: "4.4", text: "x".repeat(5000) } })?.row).toMatchObject({ text_truncated: true });
  });

  it("gap sync: a channel's first pass is a baseline, later passes are new rows from its cursor", async () => {
    const { store, writes, scopes } = fakeStore();
    const history: Record<string, any[]> = { C1: [{ ts: "100.0", text: "old", user: "U1" }] };
    const api: Api = async (method, p) => {
      if (method === "users.list") return { ok: true, members: [{ id: "U1", name: "al", profile: { display_name: "Al" } }] };
      if (method === "users.conversations") return { ok: true, channels: [{ id: "C1", name: "general", is_channel: true }] };
      if (method === "conversations.history") return { ok: true, messages: history[p.channel!]!.filter((m) => Number(m.ts) > Number(p.oldest)) };
      return { ok: true, messages: [] };
    };
    const now = 200_000;
    await gapSync(store, api, now);
    expect(writes.filter((w) => w.table === MESSAGE.name)).toEqual([{ table: "message", row: expect.objectContaining({ ts: "100.0", channel_type: "public" }), baseline: true }]);
    expect(scopes.get("channel:C1")).toMatchObject({ baselined: true, cursor: "100.0" });
    expect(writes.find((w) => w.table === "users")?.row).toMatchObject({ user_id: "U1", display_name: "Al" });

    writes.length = 0;
    history.C1!.push({ ts: "150.0", text: "new", user: "U1" });
    await gapSync(store, api, now + 60_000);
    expect(writes.filter((w) => w.table === MESSAGE.name)).toEqual([{ table: "message", row: expect.objectContaining({ ts: "150.0", text: "new" }), baseline: false }]);
  });

  it("gap sync: one conversation Slack can't read (channel_not_found) is skipped, the others still sync", async () => {
    const { store, writes, scopes } = fakeStore();
    const api: Api = async (method, p) => {
      if (method === "users.list") return { ok: true, members: [] };
      if (method === "users.conversations") return { ok: true, channels: [{ id: "CBAD", name: "gone", is_channel: true }, { id: "C2", name: "ok", is_channel: true }] };
      if (method === "conversations.history" && p.channel === "CBAD") throw new Error("slack conversations.history: channel_not_found");
      if (method === "conversations.history") return { ok: true, messages: [{ ts: "100.0", text: "hi", user: "U1" }] };
      return { ok: true, messages: [] };
    };
    await gapSync(store, api, 200_000);
    expect(writes.filter((w) => w.table === MESSAGE.name).map((w) => w.row.channel_id)).toEqual(["C2"]);
    expect(scopes.get("channel:C2")?.baselined).toBe(true);
    const flaky: Api = async (method, p) => (method === "conversations.history" && p.channel === "CBAD" ? Promise.reject(new Error("slack conversations.history: ratelimited")) : api(method, p));
    await expect(gapSync(fakeStore().store, flaky, 200_000)).rejects.toThrow(/ratelimited/); // transient: the pass fails and retries
  });

  it("gap sync: channels the owner isn't in (messages from events, no channel row) get their name from conversations.info; one that fails doesn't fail the pass", async () => {
    const { store, writes } = fakeStore();
    (store as any).pool.query = async (q: string) => ({ rows: /NOT IN \(SELECT channel_id FROM src_slack.channel\)/.test(q) ? [{ channel_id: "CPUB" }, { channel_id: "CGONE" }, { channel_id: "CSLOW" }] : [] });
    const api: Api = async (method, p) => {
      if (method === "users.list") return { ok: true, members: [] };
      if (method === "users.conversations") return { ok: true, channels: [] };
      if (method === "conversations.info" && p.channel === "CPUB") return { ok: true, channel: { id: "CPUB", name: "announcements", is_channel: true } };
      if (method === "conversations.info" && p.channel === "CGONE") throw new Error("slack conversations.info: channel_not_found");
      if (method === "conversations.info") throw new Error("slack conversations.info: ratelimited");
      return { ok: true, messages: [] };
    };
    await gapSync(store, api, 200_000);
    expect(writes.filter((w) => w.table === "channel")).toEqual([
      { table: "channel", row: { channel_id: "CPUB", name: "announcements", channel_type: "public" }, baseline: false },
      { table: "channel", row: { channel_id: "CGONE", name: null, channel_type: null }, baseline: false }, // permanent: not asked again
    ]);
  });

  it("gap sync: one thread that no longer resolves (thread_not_found) is skipped, the rest of its channel still syncs", async () => {
    const { store, writes, scopes } = fakeStore();
    const api: Api = async (method, p) => {
      if (method === "users.list") return { ok: true, members: [] };
      if (method === "users.conversations") return { ok: true, channels: [{ id: "C1", name: "general", is_channel: true }] };
      if (method === "conversations.history") return { ok: true, messages: [
        { ts: "100.0", text: "gone thread", user: "U1", reply_count: 1, latest_reply: "101.0" },
        { ts: "200.0", text: "live thread", user: "U1", reply_count: 1, latest_reply: "201.0" },
      ] };
      if (method === "conversations.replies" && p.ts === "100.0") throw new Error("slack conversations.replies: thread_not_found");
      if (method === "conversations.replies") return { ok: true, messages: [{ ts: p.ts, text: "parent", user: "U1" }, { ts: "201.0", text: "reply", user: "U2", thread_ts: "200.0" }] };
      return { ok: true, messages: [] };
    };
    const warn = vi.fn();
    const rows = await gapSync(store, api, 200_000, { warn, info: vi.fn() } as any);
    expect(rows).toBeGreaterThan(0);
    expect(writes.filter((w) => w.table === MESSAGE.name).map((w) => w.row.ts)).toEqual(expect.arrayContaining(["100.0", "200.0", "201.0"]));
    expect(scopes.get("channel:C1")).toMatchObject({ baselined: true, cursor: "200.0" });
    expect(scopes.get("channel:C1:threads")?.cursor).toBe("100.0"); // read failed: retried next pass
    expect(warn).toHaveBeenCalledWith({ skipped: ["C1/100.0: slack conversations.replies: thread_not_found"], count: 1 }, "src_slack gap sync skipped threads it couldn't read");

    // The next pass is a reconcile cycle that doesn't take the channel again (it was synced since the cycle began), but
    // its pending thread is still retried.
    scopes.set("reconcile", { baselined: true, cursor: "0", syncedAt: 0 });
    scopes.set("reconcile-cycle", { baselined: true, cursor: "300000", syncedAt: 0 });
    scopes.set("channel:C1", { ...scopes.get("channel:C1")!, syncedAt: 400_000 });
    const historyCalls: string[] = [];
    const recovered: Api = async (method, p) => {
      if (method === "conversations.history") historyCalls.push(p.channel!);
      return method === "conversations.replies" && p.ts === "100.0" ? { ok: true, messages: [{ ts: "100.0", text: "parent", user: "U1" }, { ts: "101.0", text: "late reply", user: "U2", thread_ts: "100.0" }] } : api(method, p);
    };
    await gapSync(store, recovered, 400_000);
    expect(historyCalls).toEqual([]);
    expect(writes.filter((w) => w.table === MESSAGE.name).map((w) => w.row.ts)).toContain("101.0");
    expect(scopes.get("channel:C1:threads")?.cursor).toBe("");

    const flaky: Api = async (method, p) => (method === "conversations.replies" ? Promise.reject(new Error("slack conversations.replies: ratelimited")) : api(method, p));
    await expect(gapSync(fakeStore().store, flaky, 200_000)).rejects.toThrow(/ratelimited/); // transient: the pass fails and retries
  });

  it("gap sync: a pass stops when its time budget is spent, oldest-synced first, and a reconcile is done only once every conversation is covered", async () => {
    const { store, writes, scopes, clock } = fakeStore();
    const api: Api = async (method, p) => {
      if (method === "users.list") return { ok: true, members: [] };
      if (method === "users.conversations") return { ok: true, channels: ["C1", "C2", "C3"].map((id) => ({ id, name: id, is_channel: true })) };
      if (method === "conversations.history") return { ok: true, messages: [{ ts: "100.0", text: p.channel, user: "U1" }] };
      return { ok: true, messages: [] };
    };
    const pass = async (now: number) => {
      clock.t = now;
      writes.length = 0;
      await gapSync(store, api, now, undefined, 0); // zero budget: one conversation per pass
      return writes.filter((w) => w.table === MESSAGE.name).map((w) => w.row.channel_id);
    };
    const T = 1_000_000;
    expect(await pass(T)).toEqual(["C1"]);
    expect(await pass(T + 1)).toEqual(["C2"]); // C1 is covered this cycle; never-synced C2 is next
    expect(scopes.get("reconcile")?.baselined).toBeUndefined(); // the first baseline isn't done with C3 missing
    expect(await pass(T + 2)).toEqual(["C3"]);
    expect(scopes.get("reconcile")).toMatchObject({ baselined: true, cursor: String(T) });

    const W = T + 8 * 86_400_000; // a week on: a new reconcile cycle, again one conversation per pass, oldest-synced first
    expect(await pass(W)).toEqual(["C1"]);
    expect(scopes.get("reconcile")?.cursor).toBe(String(T));
    expect(await pass(W + 1)).toEqual(["C2"]);
    expect(scopes.get("reconcile")?.cursor).toBe(String(T));
    expect(await pass(W + 2)).toEqual(["C3"]);
    expect(scopes.get("reconcile")?.cursor).toBe(String(W));
  });
});

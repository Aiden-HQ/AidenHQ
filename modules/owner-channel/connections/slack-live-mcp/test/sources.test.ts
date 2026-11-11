import { describe, expect, it } from "vitest";
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

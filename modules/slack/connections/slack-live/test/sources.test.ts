import { describe, expect, it } from "bun:test";
import { eventWrite, gapSync, MESSAGE, messageWrite, type Api } from "../src/sources.js";
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
    // A pairing code read by the gap sync is a live credential: its row keeps its metadata and loses its text.
    expect(eventWrite({ event: { type: "message", channel: "D1", channel_type: "im", ts: "6.6", user: "U1", text: "A".repeat(22) } })?.row).toMatchObject({ text: null, user_id: "U1", ts: "6.6" });
    // In a public channel the same shape is ordinary text and is kept.
    expect(eventWrite({ event: { type: "message", channel: "C1", channel_type: "channel", ts: "7.7", user: "U1", text: "A".repeat(22) } })?.row).toMatchObject({ text: "A".repeat(22) });
    // A private channel is not a DM either: its ordinary text is kept, live and in history.
    expect(eventWrite({ event: { type: "message", channel: "G1", channel_type: "group", ts: "7.8", user: "U1", text: "A".repeat(22) } })?.row).toMatchObject({ text: "A".repeat(22) });
    expect(messageWrite("G1", { ts: "7.9", text: "A".repeat(22) }, "private")?.row).toMatchObject({ text: "A".repeat(22) });
    // An edit carries its new text under `message`, and Slack may omit channel_type on it: blanked all the same.
    expect(eventWrite({ event: { type: "message", subtype: "message_changed", channel: "D1", message: { ts: "8.8", user: "U1", text: "B".repeat(22) } } })?.row).toMatchObject({ ts: "8.8", text: null });
    expect(eventWrite({ event: { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", message: { ts: "8.9", user: "U1", text: "B".repeat(22) } } })?.row).toMatchObject({ ts: "8.9", text: null });
    // An edit in a public channel keeps its ordinary text.
    expect(eventWrite({ event: { type: "message", subtype: "message_changed", channel: "C1", channel_type: "channel", message: { ts: "9.0", user: "U1", text: "B".repeat(22) } } })?.row).toMatchObject({ ts: "9.0", text: "B".repeat(22) });
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

  it("gap sync never replays a pairing code to the event router", async () => {
    const { store } = fakeStore();
    const history: any[] = [];
    const api: Api = async (method, p) => {
      if (method === "users.conversations") return { ok: true, channels: [{ id: "D1", is_im: true, user: "U1" }] };
      if (method === "conversations.history") return { ok: true, messages: history.filter((m) => Number(m.ts) > Number(p.oldest)) };
      return { ok: true, members: [], messages: [] };
    };
    const sent: any[] = [];
    const forward = async (e: unknown) => void sent.push(e);
    await gapSync(store, api, 200_000, undefined, undefined, forward); // the baseline
    // After the baseline: a plain DM, a code DM, then ordinary text.
    history.push({ ts: "150.0", text: "hello there", user: "U1" });
    history.push({ ts: "151.0", text: "C".repeat(22), user: "U1" });
    history.push({ ts: "152.0", text: "ordinary", user: "U1" });
    const before = sent.length;
    await gapSync(store, api, 260_000, undefined, undefined, forward);
    expect(sent.slice(before).map((e) => e.text)).toEqual(["hello there", "ordinary"]);
  });

  it("gap sync replays a code-shaped message that sat in a private channel: there it is ordinary text", async () => {
    const { store } = fakeStore();
    const history: any[] = [];
    const api: Api = async (method, p) => {
      if (method === "users.conversations") return { ok: true, channels: [{ id: "G1", name: "secret", is_private: true }] };
      if (method === "conversations.history") return { ok: true, messages: history.filter((m) => Number(m.ts) > Number(p.oldest)) };
      return { ok: true, members: [], messages: [] };
    };
    const sent: any[] = [];
    const forward = async (e: unknown) => void sent.push(e);
    await gapSync(store, api, 200_000, undefined, undefined, forward); // the baseline
    const before = sent.length;
    history.push({ ts: "150.0", text: "D".repeat(22), user: "U1" });
    await gapSync(store, api, 260_000, undefined, undefined, forward);
    expect(sent.slice(before).map((e) => e.text)).toEqual(["D".repeat(22)]);
  });

  it("gap sync: a newly inserted message is replayed to the event router; the baseline is not", async () => {
    const { store } = fakeStore();
    const history: any[] = [{ ts: "100.0", text: "old", user: "U1" }];
    const api: Api = async (method, p) => {
      if (method === "users.conversations") return { ok: true, channels: [{ id: "C1", name: "general", is_channel: true }] };
      if (method === "conversations.history") return { ok: true, messages: history.filter((m) => Number(m.ts) > Number(p.oldest)) };
      return { ok: true, members: [], messages: [] };
    };
    const sent: any[] = [];
    const forward = async (e: unknown) => void sent.push(e);
    await gapSync(store, api, 200_000, undefined, undefined, forward);
    expect(sent).toEqual([]);
    history.push({ ts: "150.0", text: "missed while down", user: "U2" });
    await gapSync(store, api, 260_000, undefined, undefined, forward);
    expect(sent).toEqual([expect.objectContaining({ connection: "slack", resource: "C1", id: "C1:150.0", kind: "message", author: "U2", text: "missed while down", bot: false })]);
  });
});

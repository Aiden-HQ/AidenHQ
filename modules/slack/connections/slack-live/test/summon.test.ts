// Summoning (summon.ts, map.ts): the owner's own messages are attested in code with their conversation, and the kernel's three
// calls read and answer as the owner through the relay.
import { describe, expect, it } from "bun:test";
import { toSourceEvent } from "../src/map.js";
import { gapSync, replayQueue, type Api } from "../src/sources.js";
import type { SourceStore } from "../src/source-store.js";
import { summon, SummonError, toSlackLinks, type Relay } from "../src/summon.js";
import { openStore } from "../src/store.js";

const OWNER = "UOWNER";
const msg = (event: Record<string, unknown>, authorizations = [{ is_bot: false }]) => toSourceEvent({ event: { type: "message", channel_type: "channel", channel: "C1", ts: "10.5", text: "ok, cc Aria", ...event }, authorizations }, OWNER);

describe("owner attestation", () => {
  it("an owner-authored channel message is from_owner, its own thread root; a threaded reply carries the root; a colleague's is not", () => {
    expect(msg({ user: OWNER })).toMatchObject({ from_owner: true, thread: "10.5", id: "C1:10.5", resource: "C1" });
    expect(msg({ user: OWNER, thread_ts: "9.1" })).toMatchObject({ from_owner: true, thread: "9.1" });
    expect(msg({ user: "U2" })).toMatchObject({ from_owner: false });
  });
  it("a DM has a thread only as a reply (as triage reads it); an app_mention (no channel_type) in a C channel has one", () => {
    expect(msg({ user: OWNER, channel_type: "im", channel: "D1" })).toMatchObject({ from_owner: true });
    expect(msg({ user: OWNER, channel_type: "im", channel: "D1" })).not.toHaveProperty("thread");
    expect(msg({ user: OWNER, channel_type: "mpim", channel: "G1", thread_ts: "9.1" })).toMatchObject({ thread: "9.1" });
    expect(msg({ user: OWNER, channel_type: undefined, type: "app_mention" })).toMatchObject({ thread: "10.5" });
  });
  it("never from a bot, an app or a non-plain subtype posing as the owner, and never without a paired owner", () => {
    expect(msg({ user: OWNER, bot_id: "B1" })).toMatchObject({ from_owner: false });
    expect(msg({ user: OWNER, app_id: "A1" })).toMatchObject({ from_owner: false });
    expect(msg({ user: OWNER, subtype: "bot_message" })).toMatchObject({ from_owner: false });
    expect(msg({ user: OWNER, subtype: "file_share" })).toMatchObject({ from_owner: true });
    expect(toSourceEvent({ event: { type: "message", channel_type: "channel", channel: "C1", ts: "1.1", user: OWNER, text: "cc Aria" } })).toMatchObject({ from_owner: false });
  });
});

describe("gap sync", () => {
  function fakeStore() {
    const scopes = new Map<string, { baselined: boolean; cursor: string | null; syncedAt: number }>();
    const store = {
      migrate: async () => undefined,
      scope: async (s: string) => scopes.get(s) ?? { baselined: false, cursor: null },
      scopesByPrefix: async (p: string) => new Map([...scopes].filter(([k]) => k.startsWith(p))),
      saveScope: async (s: string, cursor: string | null, baselined = false) => void scopes.set(s, { baselined: baselined || !!scopes.get(s)?.baselined, cursor, syncedAt: 0 }),
      upsert: async () => "new",
      pool: { query: async () => ({ rows: [] }) },
    };
    return store as unknown as SourceStore;
  }
  it("replays the same fields as live, and a forward the kernel didn't take is kept and retried on the next pass", async () => {
    const store = fakeStore();
    const history: any[] = [{ ts: "100.0", text: "old", user: OWNER }];
    const api: Api = async (method, p) => {
      if (method === "users.conversations") return { ok: true, channels: [{ id: "C1", name: "general", is_channel: true }] };
      if (method === "conversations.history") return { ok: true, messages: history.filter((m) => Number(m.ts) > Number(p.oldest)) };
      return { ok: true, members: [], messages: [] };
    };
    const queue = replayQueue(openStore(":memory:"));
    const sent: any[] = [];
    let down = true;
    const forward = async (e: unknown) => { if (down) throw new Error("POST /v1/events -> 503"); sent.push(e); };
    await gapSync(store, api, 200_000, undefined, undefined, forward, OWNER, queue); // the baseline
    history.push({ ts: "150.0", text: "ok, cc Aria", user: OWNER });
    await gapSync(store, api, 260_000, undefined, undefined, forward, OWNER, queue); // the kernel is down
    expect(sent).toEqual([]);
    down = false;
    await gapSync(store, api, 320_000, undefined, undefined, forward, OWNER, queue);
    expect(sent).toEqual([expect.objectContaining({ id: "C1:150.0", from_owner: true, thread: "150.0", text: "ok, cc Aria" })]);
    await gapSync(store, api, 380_000, undefined, undefined, forward, OWNER, queue);
    expect(sent).toHaveLength(1); // delivered once
  });
});

describe("the summon calls", () => {
  function fake() {
    const posts: Record<string, unknown>[] = [];
    const reads: [string, Record<string, string>][] = [];
    const channelHistory = [{ ts: "9.0", user: "U2", text: "can we meet?" }, { ts: "8.0", user: OWNER, text: "earlier" }]; // newest first, as Slack
    const relay: Relay = {
      read: async (method, p) => {
        reads.push([method, p]);
        if (method === "users.info") return { ok: true, user: { name: p.user!.toLowerCase(), profile: { display_name: p.user === OWNER ? "Mudit" : "Dana" } } };
        if (method === "conversations.replies") return { ok: true, messages: p.ts === "10.5" ? [{ ts: "10.5", user: OWNER, text: "root" }] : [{ ts: "9.1", user: "U2", text: "root" }, { ts: "9.5", user: OWNER, text: "reply" }, { ts: "10.9", user: "U2", text: "after" }] };
        return { ok: true, messages: channelHistory };
      },
      write: async (path, body) => (posts.push({ path, ...body }), { ok: true, ts: `20.${posts.length}` }),
    };
    const api = summon({ relay, store: openStore(":memory:"), owner: () => OWNER, signedIn: async () => OWNER });
    return { api, posts, reads };
  }

  it("reply posts once per key, threaded under the conversation's root, and returns the event-shaped id", async () => {
    const { api, posts } = fake();
    const b = { resource: "C1", thread: "10.5", in_reply_to: "C1:10.5", text: "Booked. Sent by Aria from [AidenHQ](https://aidenhq.ai)", key: "k1" };
    const first = await api.reply(b);
    expect(first).toEqual({ id: "C1:20.1" });
    expect(await api.reply(b)).toEqual(first);
    expect((await Promise.all([api.reply({ ...b, key: "k2" }), api.reply({ ...b, key: "k2" })])).map((r) => r.id)).toEqual(["C1:20.2", "C1:20.2"]);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({ path: "post-message", channel: "C1", thread_ts: "10.5", text: "Booked. Sent by Aria from <https://aidenhq.ai|AidenHQ>" });
    await api.reply({ resource: "D1", text: "hi", key: "k3" }); // a DM has no thread
    expect(posts[2]).not.toHaveProperty("thread_ts");
  });

  it("the signature link renders as Slack's, and agent text can't form mentions, broadcasts or raw links", () => {
    expect(toSlackLinks("Sent by Aria from [AidenHQ](https://aidenhq.ai)")).toBe("Sent by Aria from <https://aidenhq.ai|AidenHQ>");
    expect(toSlackLinks("<!channel> <@U1> <https://evil.example|go> & [x](javascript:alert(1))")).toBe("&lt;!channel&gt; &lt;@U1&gt; &lt;https://evil.example|go&gt; &amp; [x](javascript:alert(1))");
  });

  it("context reads a thread before the message, or the channel's history when the message is its own root; oldest first, owner marked", async () => {
    const { api } = fake();
    const t = await api.context({ resource: "C1", thread: "9.1", before: "C1:10.0", n: 10 });
    expect(t.messages).toEqual([
      { id: "C1:9.1", author: "Dana", is_owner: false, text: "root", ts: "9.1" },
      { id: "C1:9.5", author: "Mudit", is_owner: true, text: "reply", ts: "9.5" },
    ]);
    const c = await api.context({ resource: "C1", thread: "10.5", before: "C1:10.5", n: 2 });
    expect(c.messages.map((m) => m.ts)).toEqual(["8.0", "9.0"]);
    expect(c.messages[0]).toMatchObject({ is_owner: true, author: "Mudit" });
  });

  it("react adds 👀 as the owner; already_reacted is fine; a missing scope is a 502 that names the fix, never a 403", async () => {
    const { api, posts } = fake();
    expect(await api.react({ resource: "C1", message: "C1:10.5", emoji: "eyes" })).toEqual({});
    expect(posts[0]).toEqual({ path: "add-reaction", channel: "C1", timestamp: "10.5", name: "eyes" });
    const scopeless = summon({ relay: { read: async () => ({}), write: async () => { throw new Error("missing_scope"); } }, store: openStore(":memory:"), owner: () => OWNER, signedIn: async () => OWNER });
    const err = await scopeless.react({ resource: "C1", message: "C1:10.5", emoji: "eyes" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SummonError);
    expect((err as SummonError).status).toBe(502);
    expect((err as SummonError).message).toMatch(/chat:write and reactions:write/);
  });

  it("refuses every call when the relay's sign-in is not the paired owner's account", async () => {
    const posted: unknown[] = [];
    const other = summon({ relay: { read: async () => ({}), write: async (_, b) => (posted.push(b), { ok: true, ts: "1.1" }) }, store: openStore(":memory:"), owner: () => OWNER, signedIn: async () => "UOTHER" });
    for (const call of [() => other.reply({ resource: "C1", text: "hi", key: "k" }), () => other.react({ resource: "C1", message: "C1:1.1", emoji: "eyes" }), () => other.context({ resource: "C1" })])
      expect(await call().catch((e: SummonError) => e.status)).toBe(409);
    expect(posted).toEqual([]);
  });

  it("context follows Slack's pages: the last n replies before the summons, not the first page's", async () => {
    const page = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ ts: `${from + i}.0`, user: OWNER, text: `m${from + i}` }));
    const relay: Relay = { read: async (_, p) => (p.cursor ? { ok: true, messages: page(201, 205) } : { ok: true, messages: page(1, 201), response_metadata: { next_cursor: "c2" } }), write: async () => ({}) };
    const api = summon({ relay, store: openStore(":memory:"), owner: () => OWNER, signedIn: async () => OWNER });
    expect((await api.context({ resource: "C1", thread: "1.0", before: "C1:204.0", n: 3 })).messages.map((m) => m.ts)).toEqual(["201.0", "202.0", "203.0"]);
  });
});

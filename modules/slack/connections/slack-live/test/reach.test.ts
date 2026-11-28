// Agent reach: a message addressed to one of our bots is classified once (the instance bot by name, a bound channel, an agent's
// own app), the dedicated apps run one worker each, and a reply as the agent is posted by the entry's bot under the agent's name.
import { describe, expect, it } from "bun:test";
import { toSourceEvent, type Route } from "../src/map.js";
import { appIdOf, identity, once, reach, type Slack } from "../src/reach.js";
import { summon } from "../src/summon.js";
import { openStore } from "../src/store.js";

const OWNER = "U0OWNER1", GUEST = "U0GUEST1", BOT = "U0BOTAAA", ARIA_BOT = "U0ARIABT";
const route: Route = {
  receiver: { to: "*", entry: "slack:bot" },
  bots: { [BOT]: { to: "*", entry: "slack:bot" }, [ARIA_BOT]: { to: "aria", entry: "slack:app:A0ARIA00" } },
  bound: (c) => (c === "C0BOUND01" ? "roadmap-keeper" : undefined),
  ownerChannel: "D0OWNER01",
};
const env = (event: Record<string, unknown>, bot = true) => ({ event, authorizations: [{ is_bot: bot, user_id: BOT }] });

describe("classification", () => {
  it("a stranger's DM to the bot goes to the instance bot, not to the owner's authority", () => {
    const e = toSourceEvent(env({ type: "message", channel_type: "im", user: GUEST, channel: "D0GUEST01", ts: "5.1", text: "can Aria move my slot?" }), OWNER, route);
    expect(e).toMatchObject({ id: "D0GUEST01:5.1", kind: "message", to_agent: "*", entry: "slack:bot", from_owner: false });
  });
  it("the owner's command DM is Aiden's chat, never an addressed message", () => {
    const e = toSourceEvent(env({ type: "message", channel_type: "im", user: OWNER, channel: "D0OWNER01", ts: "5.2", text: "hi" }, true), OWNER, route);
    expect(e?.to_agent).toBeUndefined();
  });
  it("a bound channel's mention goes to the bound agent; the same mention elsewhere goes to the instance bot", () => {
    const m = (channel: string) => toSourceEvent(env({ type: "app_mention", user: GUEST, channel, ts: "6.1", text: `<@${BOT}> status?` }), OWNER, route);
    expect(m("C0BOUND01")).toMatchObject({ to_agent: "roadmap-keeper", entry: "slack:bot", thread: "6.1" });
    expect(m("C0OTHER01")).toMatchObject({ to_agent: "*", entry: "slack:bot" });
  });
  it("a message and an app_mention for the same ts are the same event", () => {
    const text = `<@${BOT}> hello`;
    const a = toSourceEvent(env({ type: "message", channel_type: "channel", user: GUEST, channel: "C0OTHER01", ts: "7.1", text }), OWNER, route);
    const b = toSourceEvent(env({ type: "app_mention", user: GUEST, channel: "C0OTHER01", ts: "7.1", text }), OWNER, route);
    expect(a).toEqual(b);
    const seen = once(openStore(":memory:"));
    expect([seen.begin(a!.id), seen.begin(b!.id)]).toEqual([true, false]);
    seen.done(a!.id);
    expect(seen.begin(a!.id)).toBe(false);
  });
  it("the owner's DM with an agent's own app is the same event from the instance socket (user stream) and from the app's", () => {
    const dmEvent = { type: "message", channel_type: "im", user: OWNER, channel: "D0ARIADM1", ts: "9.9", text: "when is he free?" };
    const peers = new Map([["D0ARIADM1", ARIA_BOT]]);
    const fromInstance = toSourceEvent({ event: dmEvent, authorizations: [{ is_bot: false }] }, OWNER, { ...route, peers });
    const fromApp = toSourceEvent({ event: dmEvent, authorizations: [{ is_bot: true, user_id: ARIA_BOT }] }, OWNER, { receiver: { to: "aria", entry: "slack:app:A0ARIA00" }, bots: route.bots });
    expect(fromInstance).toEqual(fromApp);
    // Naming another of our bots in that DM changes nothing: the DM is with Aria, on every stream.
    const named = { ...dmEvent, text: `<@${BOT}> loop Nora in` };
    expect(toSourceEvent({ event: named, authorizations: [{ is_bot: false }] }, OWNER, { ...route, peers })).toEqual(toSourceEvent({ event: named, authorizations: [{ is_bot: true, user_id: ARIA_BOT }] }, OWNER, { receiver: { to: "aria", entry: "slack:app:A0ARIA00" }, bots: route.bots }));
    expect(fromApp).toMatchObject({ to_agent: "aria", entry: "slack:app:A0ARIA00", from_owner: true });
    // Before the other party is known the owner's colleague DM stays a plain event.
    expect(toSourceEvent({ event: dmEvent, authorizations: [{ is_bot: false }] }, OWNER, route)?.to_agent).toBeUndefined();
  });
  it("a message's mention of the receiving bot is known from the envelope itself, before any lookup", () => {
    const e = toSourceEvent({ event: { type: "message", channel_type: "channel", user: GUEST, channel: "C0OTHER01", ts: "9.5", text: `<@${BOT}> hi` }, authorizations: [{ is_bot: true, user_id: BOT }] }, OWNER, { receiver: route.receiver });
    expect(e).toMatchObject({ to_agent: "*", entry: "slack:bot" });
  });
  it("a mention of an agent's own app goes to that agent's entry from either socket; bots and edits never address a bot", () => {
    const e = toSourceEvent(env({ type: "message", channel_type: "channel", user: OWNER, channel: "C0OTHER01", ts: "8.1", text: `<@${ARIA_BOT}> book it` }), OWNER, route);
    expect(e).toMatchObject({ to_agent: "aria", entry: "slack:app:A0ARIA00", from_owner: true });
    expect(toSourceEvent(env({ type: "message", bot_id: "B0X", channel: "C0OTHER01", ts: "8.2", text: `<@${BOT}> hi` }), OWNER, route)?.to_agent).toBeUndefined();
    expect(toSourceEvent(env({ type: "message", subtype: "message_changed", user: GUEST, channel: "C0OTHER01", ts: "8.3", text: `<@${BOT}> hi` }), OWNER, route)?.to_agent).toBeUndefined();
  });
});

const log = { info() {}, warn() {}, error() {} };
const XAPP = (id: string) => `xapp-1-${id}-1234567890-abcdefabcdefabcdef`;
const XOXB = (n: string) => `xoxb-${n}-abcdefabcdefabcdefabcdef`;

describe("dedicated apps", () => {
  function setup(slackAnswers: Record<string, Record<string, any>> = {}) {
    const store = openStore(":memory:");
    const opened: { appToken: string; stopped: boolean; onEvent: (m: any) => Promise<void> }[] = [];
    const order: string[] = [];
    const forwarded: unknown[] = [];
    const tokens: Record<string, { app_token: string; bot_token: string }> = { aria: { app_token: XAPP("A0ARIA00"), bot_token: XOXB("1") } };
    const slack: Slack = async (method, token) => {
      const a = slackAnswers[`${method}:${token}`] ?? (method === "auth.test" ? { user_id: ARIA_BOT, team_id: "T0TEAM01", bot_id: "B0ARIA" } : method === "bots.info" ? { bot: { app_id: "A0ARIA00" } } : {});
      if (a.error) throw new Error(a.error);
      return a;
    };
    const ident = identity(XOXB("inst"), async () => ({ user_id: BOT, team_id: "T0TEAM01" }));
    const r = reach({
      store, log, owner: () => OWNER, agents: () => Object.keys(tokens), tokens: () => tokens, slack,
      instance: { app_id: "A0INST00", identity: ident }, forward: async (e) => void forwarded.push(e),
      listen: ({ appToken, onEvent }) => {
        const l = { appToken, stopped: false, onEvent: onEvent as never };
        opened.push(l);
        order.push("start");
        return { stop: async () => void ((l.stopped = true), order.push("stop")) };
      },
    });
    return { r, opened, order, forwarded, tokens };
  }
  const dm = (user: string) => ({ type: "events_api", ack: async () => {}, body: { event: { type: "message", channel_type: "im", user, channel: "D0ARIADM1", ts: "9.1", text: "when is he free?" }, authorizations: [{ is_bot: true }] } });

  it("a DM to the app maps to the app's agent, as the owner only when the owner wrote it", async () => {
    const { r, opened, forwarded } = setup();
    await new Promise<void>((ok) => { void r.reconcile().then(ok); });
    expect(r.status()).toEqual([{ agent: "aria", state: "disconnected", app_id: "A0ARIA00" }]);
    await opened[0]!.onEvent(dm(GUEST));
    await opened[0]!.onEvent(dm(OWNER));
    expect(forwarded).toMatchObject([{ to_agent: "aria", entry: "slack:app:A0ARIA00", from_owner: false }, { to_agent: "aria", entry: "slack:app:A0ARIA00", from_owner: true }]);
    expect(r.token("slack:app:A0ARIA00")).toBe(XOXB("1"));
  });

  it("the owner's user-token stream of the app is not this agent's", async () => {
    const { r, opened, forwarded } = setup();
    await r.reconcile();
    await opened[0]!.onEvent({ ...dm(OWNER), body: { ...dm(OWNER).body, authorizations: [{ is_bot: false }] } });
    expect(forwarded).toEqual([]);
  });

  it("rejects the instance's own app, another workspace, a mismatched pair, and a duplicate", async () => {
    const own = setup();
    own.tokens.aria = { app_token: XAPP("A0INST00"), bot_token: XOXB("1") };
    await own.r.reconcile();
    expect(own.opened).toEqual([]);
    expect(own.r.status()[0]).toMatchObject({ state: "invalid", detail: expect.stringMatching(/instance's own/) });

    const team = setup({ [`auth.test:${XOXB("1")}`]: { user_id: ARIA_BOT, team_id: "T0OTHER1", bot_id: "B1" } });
    await team.r.reconcile();
    expect(team.r.status()[0]).toMatchObject({ state: "invalid", detail: expect.stringMatching(/another Slack workspace/) });

    const pair = setup({ [`bots.info:${XOXB("1")}`]: { bot: { app_id: "A0SOMEONE" } } });
    await pair.r.reconcile();
    expect(pair.r.status()[0]).toMatchObject({ state: "invalid", detail: expect.stringMatching(/different apps/) });

    const dup = setup();
    dup.tokens.nora = { ...dup.tokens.aria! };
    await dup.r.reconcile();
    expect(dup.opened.length).toBe(1);
    expect(dup.r.status().find((s) => s.agent === "nora")).toMatchObject({ state: "invalid", detail: expect.stringMatching(/already aria's/) });
  });

  it("a pair that can't be proven one app, or an instance whose workspace isn't known, starts nothing", async () => {
    const noScope = setup({ [`bots.info:${XOXB("1")}`]: { error: "missing_scope" } });
    await noScope.r.reconcile();
    expect(noScope.opened).toEqual([]);
    expect(noScope.r.status()[0]).toMatchObject({ state: "invalid", detail: expect.stringMatching(/users:read/) });
    const unnamed = setup({ [`bots.info:${XOXB("1")}`]: { bot: {} } });
    await unnamed.r.reconcile();
    expect(unnamed.opened).toEqual([]);
  });

  it("a rotated pair stops the old worker before the new one starts", async () => {
    const { r, order, tokens } = setup();
    await r.reconcile();
    tokens.aria = { app_token: XAPP("A0ARIA00"), bot_token: XOXB("2") };
    await r.reconcile();
    expect(order).toEqual(["start", "stop", "start"]);
  });

  it("appIdOf reads the app id from an app-level token", () => {
    expect(appIdOf(XAPP("A0ARIA00"))).toBe("A0ARIA00");
    expect(appIdOf("xapp-nonsense")).toBeUndefined();
  });
});

describe("reply as the agent", () => {
  const posts: { url: string; body: any; auth: string }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    posts.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return new Response(JSON.stringify({ ok: true, ts: "10.5" }));
  }) as unknown as typeof fetch;
  const make = () => summon({ store: openStore(":memory:"), owner: () => OWNER, bot: (e) => (e === "slack:bot" ? "xoxb-instance" : e === "slack:app:A0ARIA00" ? "xoxb-aria" : undefined), fetchFn });

  it("the instance bot posts under the agent's name, with no owner sign-in and no signature", async () => {
    posts.length = 0;
    const r = await make().reply({ resource: "D0GUEST01", in_reply_to: "D0GUEST01:5.1", text: "Aria here: Tuesday works.", key: "k1", entry: "slack:bot", reply_as: "agent", agent: { key: "aria", name: "Aria Botley" } });
    expect(r).toEqual({ id: "D0GUEST01:10.5" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(/chat\.postMessage$/);
    expect(posts[0]!.auth).toBe("Bearer xoxb-instance");
    expect(posts[0]!.body).toMatchObject({ channel: "D0GUEST01", text: "Aria here: Tuesday works.", username: "Aria Botley" });
  });
  it("an agent's own app posts as itself with its own token, threaded; a repeated key posts once", async () => {
    posts.length = 0;
    const s = make();
    const body = { resource: "C0X", thread: "4.4", text: "done", key: "k2", entry: "slack:app:A0ARIA00", reply_as: "agent", agent: { key: "aria", name: "Aria" } };
    await s.reply(body);
    await s.reply(body);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.auth).toBe("Bearer xoxb-aria");
    expect(posts[0]!.body).toMatchObject({ thread_ts: "4.4" });
    expect(posts[0]!.body.username).toBeUndefined();
  });
  it("a reply as the agent needs an entry whose bot is connected", async () => {
    await expect(make().reply({ resource: "C0X", text: "x", key: "k3", reply_as: "agent", agent: { key: "aria" } })).rejects.toThrow(/entry/);
    await expect(make().reply({ resource: "C0X", text: "x", key: "k4", entry: "slack:app:A0GONE00", reply_as: "agent", agent: { key: "aria" } })).rejects.toThrow(/isn't connected/);
  });
});

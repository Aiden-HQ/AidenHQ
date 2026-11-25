import { afterEach, expect, it, vi } from "vitest";
import { createPairing, handlePairingDm } from "../src/pair.js";
import { openStore } from "../src/store.js";

afterEach(() => vi.unstubAllGlobals());

/** conversations.info as the bot token sees it: our DMs are D1/D2, anyone else's DM is not found. */
const botSees = (...channels: string[]) =>
  vi.fn(async (url: string) => {
    const channel = new URL(url).searchParams.get("channel") ?? "";
    return Response.json(channels.includes(channel) ? { ok: true, channel: { id: channel, is_im: true } } : { ok: false, error: "channel_not_found" });
  });

const setup = (t = { now: 1_000_000 }) => {
  const pairing = createPairing(openStore(":memory:").db, () => t.now);
  const said: [string, string][] = [];
  const dm = (code: string, over: Record<string, unknown> = {}, user = "U1", channel = "D1") =>
    handlePairingDm(
      pairing,
      { authorizations: [{ is_bot: true }], event: { type: "message", channel_type: "im", user, channel, text: code, ...over } },
      async (c, text) => void said.push([c, text]),
      () => undefined,
      { botToken: "xoxb-test", fetch: botSees("D1", "D2", "D3", "D4", "D5") as typeof fetch },
    );
  return { t, pairing, said, dm };
};

it("a DMed code pairs that user, and the DM becomes the command channel", async () => {
  const { pairing, said, dm } = setup();
  expect(await dm(pairing.mint())).toBe(true);
  expect(pairing.owner()).toEqual({ user: "U1", channel: "D1" });
  expect(said).toEqual([["D1", "Paired. Say hi to Aiden."]]);
  expect(pairing.pairedAt()).toBe(new Date(1_000_000).toISOString());
});

it("a DM with no authorizations field pairs, and one whose first authorization is not the bot", async () => {
  const { pairing } = setup();
  const noAuthz = (code: string, user: string, channel: string) =>
    handlePairingDm(
      pairing,
      { event: { type: "message", channel_type: "im", user, channel, text: code } },
      async () => undefined,
      () => undefined,
      { botToken: "xoxb-test", fetch: botSees(channel) as typeof fetch },
    );
  expect(await noAuthz(pairing.mint(), "U1", "D1")).toBe(true);
  expect(pairing.owner()).toEqual({ user: "U1", channel: "D1" });

  // Slack's authorizations array holds at most one arbitrary install: the user's, not the bot's.
  const userFirst = (code: string) =>
    handlePairingDm(
      pairing,
      { authorizations: [{ is_bot: false }], event: { type: "message", channel_type: "im", user: "U2", channel: "D2", text: code } },
      async () => undefined,
      () => undefined,
      { botToken: "xoxb-test", fetch: botSees("D2") as typeof fetch },
    );
  expect(await userFirst(pairing.mint())).toBe(true);
  expect(pairing.owner()).toEqual({ user: "U2", channel: "D2" });
});

it("a code in a DM the bot cannot see pairs nobody, and the code is not redeemed", async () => {
  const { pairing } = setup();
  const code = pairing.mint();
  const fetchSpy = botSees(); // every lookup answers channel_not_found
  const r = await handlePairingDm(
    pairing,
    { authorizations: [{ is_bot: true }], event: { type: "message", channel_type: "im", user: "U2", channel: "DOTHER", text: code } },
    async () => undefined,
    () => undefined,
    { botToken: "xoxb-test", fetch: fetchSpy as typeof fetch },
  );
  expect(r).toBe(false);
  expect(pairing.paired()).toBe(false);
  expect(fetchSpy).toHaveBeenCalledOnce();
  // Still good, in the same store: the person whose DM is with the bot pairs with it.
  expect(await handlePairingDm(
    pairing,
    { event_id: "EvRetry", event: { type: "message", channel_type: "im", user: "U2", channel: "D1", text: code } },
    async () => undefined,
    () => undefined,
    { botToken: "xoxb-test", fetch: botSees("D1") as typeof fetch },
  )).toBe(true);
  expect(pairing.owner()).toEqual({ user: "U2", channel: "D1" });
});

it("a lookup that itself fails falls back to the event naming a bot install", async () => {
  const { pairing } = setup();
  const down = (async () => new Response("down", { status: 503 })) as typeof fetch;
  const attempt = (authz: { is_bot?: boolean }[] | undefined, channel: string, said: [string, string][]) => {
    const body = { ...(authz ? { authorizations: authz } : {}), event: { type: "message", channel_type: "im", user: "U6", channel, text: pairing.mint() } };
    return handlePairingDm(pairing, body, async (c, text) => void said.push([c, text]), () => undefined, { botToken: "xoxb-test", fetch: down });
  };
  const botSaid: [string, string][] = [];
  expect(await attempt([{ is_bot: true }], "D6", botSaid)).toBe(true);
  expect(pairing.owner()).toEqual({ user: "U6", channel: "D6" });

  // Slack gave no bot install to fall back on: unanswered and unconsumed, so the still-valid code never reaches ingestion.
  const otherSaid: [string, string][] = [];
  expect(await attempt([{ is_bot: false }], "D7", otherSaid)).toBe(true);
  const noneSaid: [string, string][] = [];
  expect(await attempt(undefined, "D8", noneSaid)).toBe(true);
  expect(otherSaid).toEqual([["D7", "I couldn't check that DM with the bot. Try again in a moment."]]);
  expect(noneSaid).toEqual([["D8", "I couldn't check that DM with the bot. Try again in a moment."]]);
  expect(pairing.owner()).toEqual({ user: "U6", channel: "D6" });
});

it("a redelivered event is decided once, and a wrong code from an already-paired DM still says so", async () => {
  const { pairing } = setup();
  const code = pairing.mint();
  const said: [string, string][] = [];
  const dm = (text: string, event = "Ev7") =>
    handlePairingDm(
      pairing,
      { event_id: event, event: { type: "message", channel_type: "im", user: "U1", channel: "D1", text } },
      async (c, t) => void said.push([c, t]),
      () => undefined,
      { botToken: "xoxb-test", fetch: botSees("D1") as typeof fetch },
    );
  expect(await dm(code)).toBe(true);
  expect(await dm(code)).toBe(true); // Slack redelivers the event it already paired
  expect(await dm(code)).toBe(true);
  expect(said).toEqual([["D1", "Paired. Say hi to Aiden."]]);

  // A genuinely wrong code from the same, already-paired DM still says so.
  expect(await dm("x".repeat(22), "Ev8")).toBe(true);
  expect(said.at(-1)).toEqual(["D1", "That code didn't work. Make a new one on the AidenHQ board."]);
});

it("a redelivered wrong code charges the limit once", async () => {
  const { pairing } = setup();
  const dm = (text: string, event: string) =>
    handlePairingDm(
      pairing,
      { event_id: event, event: { type: "message", channel_type: "im", user: "U1", channel: "D1", text } },
      async () => undefined,
      () => undefined,
      { botToken: "xoxb-test", fetch: botSees("D1") as typeof fetch },
    );
  // Three distinct mistakes, each delivered twice, then the right code: the redeliveries must not exhaust the five tries.
  for (let i = 0; i < 3; i++) {
    await dm(`w${i}${"z".repeat(20)}`, `EvW${i}`);
    await dm(`w${i}${"z".repeat(20)}`, `EvW${i}`);
  }
  expect(await dm(pairing.mint(), "EvGood")).toBe(true);
  expect(pairing.paired()).toBe(true);
  expect(pairing.owner()).toEqual({ user: "U1", channel: "D1" });
});

it("acknowledges as soon as the decision is durable, before the reply goes out", async () => {
  const { pairing } = setup();
  const order: string[] = [];
  let releaseReply = () => {};
  const replyGate = new Promise<void>((r) => (releaseReply = r));
  const call = handlePairingDm(
    pairing,
    { event_id: "EvA", event: { type: "message", channel_type: "im", user: "U1", channel: "D1", text: pairing.mint() } },
    async () => { order.push("reply"); await replyGate; order.push("replied"); },
    () => undefined,
    { botToken: "xoxb-test", fetch: botSees("D1") as typeof fetch, ack: async () => { order.push("ack"); } },
  );
  await new Promise((r) => setImmediate(r));
  expect(order).toEqual(["ack", "reply"]); // acked, and the reply is still in flight
  releaseReply();
  expect(await call).toBe(true);
});

it("a code posted in a channel pairs nobody, and neither does one in a DM with someone else", async () => {
  const { pairing, dm } = setup();
  const code = pairing.mint();
  expect(await dm(code, { channel_type: "channel", channel: "C1" })).toBe(false);
  expect(await dm(code, { channel_type: "group", channel: "G1" })).toBe(false);
  expect(await dm(code, { channel: "DOTHER" })).toBe(false); // conversations.info: channel_not_found
  expect(pairing.paired()).toBe(false);
  expect(await dm(code)).toBe(true); // the code is still good
  expect(pairing.paired()).toBe(true);
});

it("a used or expired code pairs nobody, and only 5 wrong codes a minute are tried per user", async () => {
  const { t, pairing, dm } = setup();
  const used = pairing.mint();
  await dm(used);
  await dm(used, {}, "U2", "D2");
  expect(pairing.owner()).toEqual({ user: "U1", channel: "D1" });

  const old = pairing.mint();
  t.now += 15 * 60_000 + 1;
  await dm(old, {}, "U3", "D3");
  expect(pairing.owner()?.user).toBe("U1");

  const fresh = pairing.mint();
  for (let i = 0; i < 5; i++) await dm("x".repeat(22), {}, "U4", "D4");
  await dm(fresh, {}, "U4", "D4"); // the sixth try is refused even with the right code
  expect(pairing.owner()?.user).toBe("U1");
  await dm(fresh, {}, "U5", "D5"); // another user still pairs
  expect(pairing.owner()).toEqual({ user: "U5", channel: "D5" });
});

import { expect, it } from "vitest";
import { createPairing, handlePairingDm } from "../src/pair.js";
import { openStore } from "../src/store.js";

const setup = (t = { now: 1_000_000 }) => {
  const pairing = createPairing(openStore(":memory:").db, () => t.now);
  const said: [string, string][] = [];
  const dm = (code: string, over: Record<string, unknown> = {}, user = "U1", channel = "D1") =>
    handlePairingDm(
      pairing,
      { authorizations: [{ is_bot: true }], event: { type: "message", channel_type: "im", user, channel, text: code, ...over } },
      async (c, text) => void said.push([c, text]),
      () => undefined,
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

it("a code posted in a channel pairs nobody, and neither does one in the owner's DM with someone else", async () => {
  const { pairing, dm } = setup();
  const code = pairing.mint();
  expect(await dm(code, { channel_type: "channel", channel: "C1" })).toBe(false);
  expect(await dm(code, { channel_type: "group", channel: "G1" })).toBe(false);
  const user = { authorizations: [{ is_bot: false }], event: { type: "message", channel_type: "im", user: "U2", channel: "D2", text: code } };
  expect(await handlePairingDm(pairing, user, async () => undefined, () => undefined)).toBe(false);
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

it("re-pairing notifies the old DM", async () => {
  const { pairing, said, dm } = setup();
  await dm(pairing.mint(), {}, "U0", "D0");
  await dm(pairing.mint());
  expect(said).toContainEqual(["D0", "This Slack account is no longer paired with AidenHQ."]);
});

it("an owner stored without a channel gets one, once, and only for that owner", () => {
  const db = openStore(":memory:").db;
  const pairing = createPairing(db);
  db.prepare(`INSERT INTO pair_owner (id, user_id, channel) VALUES (1, 'U0', '')`).run();
  expect(pairing.setChannel("U9", "D9")).toBe(false);
  expect(pairing.setChannel("U0", "D0")).toBe(true);
  expect(pairing.setChannel("U0", "D1")).toBe(false);
  expect(pairing.owner()).toEqual({ user: "U0", channel: "D0" });
});

it("minting a code retires the earlier unused ones", async () => {
  const { pairing, dm } = setup();
  const first = pairing.mint();
  const second = pairing.mint();
  await dm(first);
  expect(pairing.paired()).toBe(false);
  await dm(second);
  expect(pairing.paired()).toBe(true);
});

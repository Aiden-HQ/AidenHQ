// Pairing the owner chat: a board-minted code, used once, within 15 minutes, 5 wrong tries a minute per chat.
import { describe, expect, it } from "vitest";
import { CODE_TTL_MS, createPairing, handleStart, seedOwnerChat } from "../src/pair.js";
import { openStore } from "../src/store.js";

const setup = () => {
  let t = 1_000_000;
  const store = openStore(":memory:");
  return { store, pairing: createPairing(store, () => t), tick: (ms: number) => (t += ms) };
};
const start = (chatId: number, code: string, type = "private") => ({ message: { text: `/start ${code}`, chat: { id: chatId, type } } });

describe("pairing", () => {
  it("a fresh code pairs the sending chat", () => {
    const { store, pairing } = setup();
    const code = pairing.mint();
    expect(Buffer.from(code, "base64url")).toHaveLength(16);
    expect(pairing.paired()).toBe(false);
    expect(pairing.pairedAt()).toBeNull();
    expect(pairing.redeem(code, 42)).toBe("paired");
    expect(store.ownerChat()).toBe("42");
    expect(pairing.paired()).toBe(true);
    expect(pairing.pairedAt()).toBe(new Date(1_000_000).toISOString());
  });

  it("a used code pairs nobody", async () => {
    const { store, pairing } = setup();
    const code = pairing.mint();
    expect(pairing.redeem(code, 42)).toBe("paired");
    const sent: [string, string][] = [];
    expect(await handleStart(start(77, code), pairing, store, async (c, t) => sent.push([c, t]))).toBe(true);
    expect(store.ownerChat()).toBe("42");
    expect(sent).toEqual([["77", expect.stringMatching(/didn't work/)]]);
  });

  it("an expired code pairs nobody, and is used up", () => {
    const { store, pairing, tick } = setup();
    const code = pairing.mint();
    tick(CODE_TTL_MS + 1);
    expect(pairing.redeem(code, 42)).toBe("expired");
    expect(store.ownerChat()).toBeUndefined();
    expect(pairing.redeem(code, 42)).toBe("wrong");
  });

  it("handleStart says each outcome: paired, expired, wrong and a group chat, with a chat id and no code", async () => {
    const { store, pairing, tick } = setup();
    const logged: { fields: Record<string, unknown>; msg: string }[] = [];
    const log = { info: (fields: Record<string, unknown>, msg: string) => void logged.push({ fields, msg }) };
    const sent: [string, string][] = [];
    const send = async (c: string, t: string) => void sent.push([c, t]);

    // Paired: the chat's id, and neither the code nor a token.
    const code = pairing.mint();
    expect(await handleStart(start(42, code), pairing, store, send, log)).toBe(true);
    expect(logged).toEqual([{ fields: { chatId: 42 }, msg: "chat paired" }]);
    expect(JSON.stringify(logged)).not.toContain(code);

    // Expired: told apart from a wrong code, both in the answer and the log.
    logged.length = 0;
    sent.length = 0;
    const gone = pairing.mint();
    tick(CODE_TTL_MS + 1);
    expect(await handleStart(start(77, gone), pairing, store, send, log)).toBe(true);
    expect(sent).toEqual([["77", expect.stringMatching(/expired/)] ]);
    expect(logged).toEqual([{ fields: { chatId: 77, reason: "expired" }, msg: "pairing code rejected" }]);
    logged.length = 0;
    sent.length = 0;
    expect(await handleStart(start(77, "no-such-code"), pairing, store, send, log)).toBe(true);
    expect(sent).toEqual([["77", expect.stringMatching(/didn't work/)] ]);
    expect(logged).toEqual([{ fields: { chatId: 77, reason: "wrong" }, msg: "pairing code rejected" }]);

    // A group never pairs, and says it in one line.
    logged.length = 0;
    expect(await handleStart(start(99, pairing.mint(), "group"), pairing, store, send, log)).toBe(true);
    expect(store.ownerChat()).toBe("42");
    expect(logged).toEqual([{ fields: { chatId: 99, reason: "group" }, msg: "pairing refused: not a private chat" }]);
  });

  it("six wrong codes in a minute from one chat are refused, another chat still pairs", () => {
    const { store, pairing, tick } = setup();
    const code = pairing.mint();
    for (let i = 0; i < 5; i++) expect(pairing.redeem(`wrong${i}`, 66)).toBe("wrong");
    expect(pairing.redeem(code, 66)).toBe("limited"); // the sixth try, even with the right code
    expect(store.ownerChat()).toBeUndefined();
    tick(1000);
    expect(pairing.redeem(code, 42)).toBe("paired"); // the code wasn't used up by the refused try
    expect(store.ownerChat()).toBe("42");
  });

  it("an existing env chat id is seeded once", () => {
    const { store } = setup();
    const logged: string[] = [];
    seedOwnerChat(store, "1234", (m) => logged.push(m));
    expect(store.ownerChat()).toBe("1234");
    store.setOwnerChat("42");
    seedOwnerChat(store, "1234", (m) => logged.push(m));
    expect(store.ownerChat()).toBe("42");
    expect(logged).toEqual(["owner chat seeded from env"]);
  });

  it("re-pairing notifies the old chat", async () => {
    const { store, pairing } = setup();
    store.setOwnerChat("42", 0);
    const sent: [string, string][] = [];
    const send = async (c: string, t: string) => void sent.push([c, t]);
    expect(await handleStart(start(99, pairing.mint(), "group"), pairing, store, send)).toBe(true);
    expect(store.ownerChat()).toBe("42"); // a group never pairs
    sent.length = 0;
    expect(await handleStart(start(77, pairing.mint()), pairing, store, send)).toBe(true);
    expect(store.ownerChat()).toBe("77");
    expect(pairing.pairedAt()).toBe(new Date(1_000_000).toISOString()); // moved on: the board sees the re-pair finish
    expect(sent).toEqual([
      ["42", "This chat is no longer paired with AidenHQ."],
      ["77", "Paired. Say hi to Aiden."],
    ]);
  });
});

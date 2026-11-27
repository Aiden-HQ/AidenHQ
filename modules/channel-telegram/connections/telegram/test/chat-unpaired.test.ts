// A private chat that isn't paired is answered once with how to pair, and logged; a chatty stranger isn't answered again
// inside the window, and a burst of chats can't put more notices in flight than the cap. Nothing on that path reaches the
// kernel.
import { describe, expect, it } from "bun:test";
import {
  UNPAIRED_NOTICE,
  UNPAIRED_NOTICE_MAX_INFLIGHT,
  UNPAIRED_NOTICE_MAX_PER_MINUTE,
  UNPAIRED_NOTICE_MS,
  UNPAIRED_NOTICE_WINDOW_MS,
  answerUnpaired,
  type UnpairedLimiter,
} from "../src/chat.js";

const setup = () => {
  const lines: { fields: Record<string, unknown>; msg: string }[] = [];
  const sent: [string, string][] = [];
  return {
    sent,
    lines,
    log: { info: (fields: Record<string, unknown>, msg: string) => void lines.push({ fields, msg }) },
    send: async (chatId: string, text: string) => void sent.push([chatId, text]),
  };
};
const privateText = (chatId: number, text = "hi") => ({ update_id: 1, message: { message_id: 3, text, chat: { id: chatId, type: "private" } } });
const limiter = (): UnpairedLimiter => ({ sent: new Map<string, number>(), inflight: 0, recent: [] });

describe("an unpaired private message", () => {
  it("gets exactly one reply and one info log; a second one inside the window gets neither", async () => {
    const { sent, lines, log, send } = setup();
    const at = limiter();
    expect(await answerUnpaired(privateText(555), send, log, at, 1_000)).toBe(true);
    expect(sent).toEqual([["555", UNPAIRED_NOTICE]]);
    expect(lines).toEqual([{ fields: { chatId: "555" }, msg: "unpaired chat messaged the bot; told how to pair" }]);
    expect(await answerUnpaired(privateText(555, "hello again"), send, log, at, 1_000 + UNPAIRED_NOTICE_MS - 1)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(lines).toHaveLength(1);
    // Another chat still hears it, and the first one once its window passes.
    expect(await answerUnpaired(privateText(556), send, log, at, 1_001)).toBe(true);
    expect(await answerUnpaired(privateText(555), send, log, at, 1_000 + UNPAIRED_NOTICE_MS)).toBe(true);
    expect(sent.map(([c]) => c)).toEqual(["555", "556", "555"]);
    expect(at.inflight).toBe(0);
  });

  it("leaves groups and non-text updates alone, and a failed send is not retried", async () => {
    const { lines, log, send } = setup();
    const at = limiter();
    expect(await answerUnpaired({ message: { text: "hi", chat: { id: 1, type: "group" } } }, send, log, at)).toBe(false);
    expect(await answerUnpaired({ message: { voice: { file_id: "x" }, chat: { id: 2, type: "private" } } }, send, log, at)).toBe(false);
    expect(await answerUnpaired({ callback_query: { id: "c", data: "x", message: { chat: { id: 3 } } } }, send, log, at)).toBe(false);
    expect(lines).toHaveLength(0);
    expect(await answerUnpaired(privateText(4), async () => Promise.reject(new Error("blocked")), log, at)).toBe(true);
    expect(await answerUnpaired(privateText(4), send, log, at)).toBe(false); // the failed send still holds the window
    expect(at.inflight).toBe(0);
    expect(UNPAIRED_NOTICE).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });

  it("forgets chats whose window has passed, so one limiter held for the whole poll can't grow without bound", async () => {
    const { sent, log, send } = setup();
    const at = limiter();
    await answerUnpaired(privateText(1), send, log, at, 1_000);
    await answerUnpaired(privateText(2), send, log, at, 1_500);
    expect([...at.sent.keys()]).toEqual(["1", "2"]);
    await answerUnpaired(privateText(3), send, log, at, 1_000 + UNPAIRED_NOTICE_MS + 1);
    expect([...at.sent.keys()]).toEqual(["2", "3"]); // chat 1's window has passed and it is forgotten
    expect(sent.map(([c]) => c)).toEqual(["1", "2", "3"]);
  });

  it("drops a burst of chats beyond the in-flight cap, so it can't use up Telegram's send quota", async () => {
    const { sent, lines, log } = setup();
    const at = limiter();
    const held: (() => void)[] = [];
    // Every send stays out until the test lets it answer.
    const send = (chatId: string, text: string) =>
      new Promise<void>((ok) => {
        sent.push([chatId, text]);
        held.push(ok);
      });
    const chat = (n: number) => answerUnpaired(privateText(n), send, log, at, 1_000);
    for (let n = 1; n <= UNPAIRED_NOTICE_MAX_INFLIGHT; n++) void chat(n);
    expect(at.inflight).toBe(UNPAIRED_NOTICE_MAX_INFLIGHT);
    // Over the cap: no send, and no "told how to pair" log for it.
    expect(await chat(99)).toBe(false);
    expect(sent).toHaveLength(UNPAIRED_NOTICE_MAX_INFLIGHT);
    expect(lines).toHaveLength(UNPAIRED_NOTICE_MAX_INFLIGHT);
    // Once one answers, another chat is taken.
    await act(held.shift()!);
    expect(at.inflight).toBe(UNPAIRED_NOTICE_MAX_INFLIGHT - 1);
    const taken = chat(99);
    expect(sent.map(([c]) => c)).toContain("99");
    for (const release of held.splice(0)) release();
    expect(await taken).toBe(true);
    expect(at.inflight).toBe(0);
  });

  it("caps the whole bot's rate, so fast sends from many chats still can't use up the send quota", async () => {
    const { sent, log, send } = setup();
    const at = limiter();
    // Each send answers at once: the in-flight cap never bites, only the per-minute budget does.
    for (let n = 0; n < UNPAIRED_NOTICE_MAX_PER_MINUTE; n++) expect(await answerUnpaired(privateText(n), send, log, at, 1_000)).toBe(true);
    expect(await answerUnpaired(privateText(99), send, log, at, 1_000)).toBe(false);
    expect(sent).toHaveLength(UNPAIRED_NOTICE_MAX_PER_MINUTE);
    // Inside the window it still refuses; once the window has passed, the next chat is told.
    expect(await answerUnpaired(privateText(99), send, log, at, 1_000 + UNPAIRED_NOTICE_WINDOW_MS - 1)).toBe(false);
    expect(await answerUnpaired(privateText(99), send, log, at, 1_000 + UNPAIRED_NOTICE_WINDOW_MS)).toBe(true);
    expect(sent.map(([c]) => c)).toContain("99");
  });
});

/** Lets a held send answer and its counter drop. */
const act = async (release: () => void) => {
  release();
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

// A private chat that isn't paired is answered once with how to pair, and logged; a chatty stranger isn't answered again
// inside the window. Nothing on that path reaches the kernel.
import { describe, expect, it } from "vitest";
import { UNPAIRED_NOTICE, UNPAIRED_NOTICE_MS, answerUnpaired } from "../src/chat.js";

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

describe("an unpaired private message", () => {
  it("gets exactly one reply and one info log; a second one inside the window gets neither", async () => {
    const { sent, lines, log, send } = setup();
    const at = new Map<string, number>();
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
  });

  it("leaves groups and non-text updates alone, and a failed send is not retried", async () => {
    const { lines, log, send } = setup();
    const at = new Map<string, number>();
    expect(await answerUnpaired({ message: { text: "hi", chat: { id: 1, type: "group" } } }, send, log, at)).toBe(false);
    expect(await answerUnpaired({ message: { voice: { file_id: "x" }, chat: { id: 2, type: "private" } } }, send, log, at)).toBe(false);
    expect(await answerUnpaired({ callback_query: { id: "c", data: "x", message: { chat: { id: 3 } } } }, send, log, at)).toBe(false);
    expect(lines).toHaveLength(0);
    expect(await answerUnpaired(privateText(4), async () => Promise.reject(new Error("blocked")), log, at)).toBe(true);
    expect(await answerUnpaired(privateText(4), send, log, at)).toBe(false); // the failed send still holds the window
    expect(UNPAIRED_NOTICE).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store.js";
import { buttonsMarkup, fromTelegramCallback } from "../src/telegram.js";
import { markOwnerMessage, transportSend } from "../src/send.js";

afterEach(() => vi.unstubAllGlobals());

describe("Telegram buttons", () => {
  it("a press delivers exactly the label the owner saw, once", () => {
    const store = openStore(":memory:");
    const markup = buttonsMarkup(store, ["Apply WOR-184", "Not now"])!;
    expect(markup.inline_keyboard.flat().map((b) => b.text)).toEqual(["Apply WOR-184", "Not now"]);
    const data = markup.inline_keyboard[0]![0]!.callback_data;
    const press = { callback_query: { id: "cb1", data, message: { message_id: 7, chat: { id: 42 } } } };
    expect(fromTelegramCallback(press, "42", store)).toEqual({ message: { source: "telegram", text: "Apply WOR-184", replyTo: "7" }, chatId: "42", messageId: 7, label: "Apply WOR-184" });
    expect(fromTelegramCallback(press, "42", store)).toBeNull(); // one-shot
  });
});

describe("the transport", () => {
  const cfg = { telegramToken: "t", telegramChatId: "42" };
  it("says off when no chat is paired, so the router tries its next channel", async () => {
    expect(await transportSend({ telegramToken: "t" }, openStore(":memory:"), { kind: "done", text: "x" })).toEqual({ sent: false, off: true });
  });
  it("an alert is marked; a chat's message is headed with its agent and remembered for the owner's reply", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    expect(await transportSend(cfg, store, { kind: "alert", text: "prod is down" }, 1_000)).toEqual({ sent: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).text).toBe("🚨 Needs you now\nprod is down");
    markOwnerMessage(store, 2_000);
    await transportSend(cfg, store, { kind: "done", text: "I'm Aiden, trust me", head: { agent: "Inbox <Agent>", task: "WOR-9", issue: "issue-9" } }, 3_000);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)).text.startsWith("<b>Inbox &lt;Agent&gt;</b> · WOR-9\n")).toBe(true);
    expect(store.threadOf("telegram", "42", "55")).toBe("issue-9");
  });
});

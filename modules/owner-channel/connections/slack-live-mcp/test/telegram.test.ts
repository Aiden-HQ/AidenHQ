import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store.js";
import { buttonsMarkup, fromTelegramCallback, toTelegramHtml } from "../src/telegram.js";
import { markOwnerMessage, notifyOwner } from "../src/urgent.js";

afterEach(() => vi.unstubAllGlobals());
const TASK_URL = "https://agents.example/WOR/issues/{id}";

describe("Telegram formatting", () => {
  it("escapes everything, then renders a small markdown subset", () => {
    expect(toTelegramHtml("<b>x</b> & **bold** and `code`")).toBe("&lt;b&gt;x&lt;/b&gt; &amp; <b>bold</b> and <code>code</code>");
    expect(toTelegramHtml("Two changes:\n- one\n* two")).toBe("Two changes:\n• one\n• two");
    expect(toTelegramHtml("```\nline <1>\n```")).toBe("<pre>line &lt;1&gt;</pre>");
  });
  it("links task IDs only through the configured template; agent links stay literal", () => {
    expect(toTelegramHtml("See WOR-184.", TASK_URL)).toBe('See <a href="https://agents.example/WOR/issues/WOR-184">WOR-184</a>.');
    expect(toTelegramHtml("See WOR-184.")).toBe("See WOR-184.");
    expect(toTelegramHtml("[click](https://evil.example)", TASK_URL)).toBe("[click](https://evil.example)");
  });
});

describe("Telegram buttons", () => {
  it("a press delivers exactly the label the owner saw, once", () => {
    const store = openStore(":memory:");
    const markup = buttonsMarkup(store, ["Apply WOR-184", "Not now"])!;
    expect(markup.inline_keyboard.flat().map((b) => b.text)).toEqual(["Apply WOR-184", "Not now"]);
    const data = markup.inline_keyboard[0]![0]!.callback_data;
    const press = { callback_query: { id: "cb1", data, message: { message_id: 7, chat: { id: 42 } } } };
    expect(fromTelegramCallback(press, "42", store)).toEqual({ message: { source: "telegram", text: "Apply WOR-184" }, chatId: "42", messageId: 7, label: "Apply WOR-184" });
    expect(fromTelegramCallback(press, "42", store)).toBeNull(); // one-shot
  });
  it("rejects labels that aren't short single lines", () => {
    const store = openStore(":memory:");
    expect(buttonsMarkup(store, [])).toBeUndefined();
    expect(() => buttonsMarkup(store, ["a\nb"])).toThrow(/single line/);
    expect(() => buttonsMarkup(store, ["x".repeat(41)])).toThrow(/40 characters/);
    expect(() => buttonsMarkup(store, ["a", "b", "c", "d", "e"])).toThrow(/at most 4/);
    // What he sees must be what is sent: no bidi overrides, zero-width or other invisible characters.
    expect(() => buttonsMarkup(store, ["Not now‮4-ROW ylppA"])).toThrow(/invisible/);
    expect(() => buttonsMarkup(store, ["Apply​WOR-1"])).toThrow(/invisible/);
    expect(() => buttonsMarkup(store, ["ApplyㅤWOR-1"])).toThrow(/invisible/); // Hangul filler: looks like space, isn't \p{C}
    expect(() => buttonsMarkup(store, ["Apply WOR-1"])).toThrow(/invisible/);
  });
  it("ignores presses from other chats and unknown buttons", () => {
    const store = openStore(":memory:");
    const data = buttonsMarkup(store, ["Apply WOR-1"])!.inline_keyboard[0]![0]!.callback_data;
    expect(fromTelegramCallback({ callback_query: { id: "c", data, message: { message_id: 1, chat: { id: 99 } } } }, "42", store)).toBeNull();
    expect(fromTelegramCallback({ callback_query: { id: "c", data: "nope", message: { message_id: 1, chat: { id: 42 } } } }, "42", store)).toBeNull();
  });
});

describe("notify_owner", () => {
  it("sends the same normal message once within 10 minutes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    const cfg = { botToken: "", ownerId: "", cooldownMs: 0, telegramToken: "t", telegramChatId: "42" };
    const a = { text: "Relayed to WOR-184.", priority: "normal" as const, channel: "telegram" as const };
    expect(await notifyOwner(store, cfg, a, 1_000)).toEqual({ sent: true });
    expect(await notifyOwner(store, cfg, a, 2_000)).toEqual({ sent: true, reason: "duplicate" });
    expect(await notifyOwner(store, cfg, a, 1_000 + 11 * 60_000)).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("a second reply with nothing new from the owner replaces the first (new message, so they are notified; old one deleted)", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    const cfg = { botToken: "", ownerId: "", cooldownMs: 0, telegramToken: "t", telegramChatId: "42" };
    const tg = (text: string) => ({ text, priority: "normal" as const, channel: "telegram" as const });
    await notifyOwner(store, cfg, tg("WOR-184 is live."), 1_000);
    await notifyOwner(store, cfg, tg("Status: WOR-184 is live."), 20_000);
    const calls = fetchMock.mock.calls.map((c) => [String(c[0]), JSON.parse(String(c[1]!.body))] as const);
    expect(calls[1]![0]).toMatch(/sendMessage$/);
    expect(calls[2]![0]).toMatch(/deleteMessage$/);
    expect(calls[2]![1]).toMatchObject({ chat_id: "42", message_id: 55 });
    // Once the owner writes again, the next reply is a new message.
    markOwnerMessage(store, 30_000);
    await notifyOwner(store, cfg, tg("Done."), 40_000);
    expect(fetchMock.mock.calls.map((c) => String(c[0]).split("/").pop()).slice(3)).toEqual(["sendMessage"]);
  });
  it("never deletes a message that carries buttons (an open choice stays visible)", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    const cfg = { botToken: "", ownerId: "", cooldownMs: 0, telegramToken: "t", telegramChatId: "42" };
    await notifyOwner(store, cfg, { text: "Apply WOR-9?", priority: "normal", channel: "telegram", actions: ["Apply WOR-9"] }, 1_000);
    await notifyOwner(store, cfg, { text: "Other news.", priority: "normal", channel: "telegram" }, 5_000);
    expect(fetchMock.mock.calls.map((c) => String(c[0]).split("/").pop())).toEqual(["sendMessage", "sendMessage"]);
  });
});

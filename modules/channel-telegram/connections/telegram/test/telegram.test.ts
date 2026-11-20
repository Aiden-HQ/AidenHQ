import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store.js";
import { buttonsMarkup, fromTelegramCallback, toTelegramHtml } from "../src/telegram.js";
import { markOwnerMessage, transportSend } from "../src/send.js";

afterEach(() => vi.unstubAllGlobals());
const TASK_URL = "https://agents.example/WOR/issues/{id}";
const BOARD_URL = "https://board.example/";

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
  it("an in-app route becomes a link to the board's own address; no board configured keeps it literal", () => {
    expect(toTelegramHtml("Tap [Set up Telegram](#/setup/x).", TASK_URL, BOARD_URL)).toBe('Tap <a href="https://board.example/#/setup/x">Set up Telegram</a>.');
    expect(toTelegramHtml("[Connect](*not a route*)", TASK_URL, BOARD_URL)).toBe("[Connect](*not a route*)");
  });
  it("an arbitrary host stays literal, so a label can never hide a different destination", () => {
    expect(toTelegramHtml("[click](https://evil.example)", TASK_URL, BOARD_URL)).toBe("[click](https://evil.example)");
    expect(toTelegramHtml("[click](#//evil.example)", TASK_URL, BOARD_URL)).toBe("[click](#//evil.example)");
    expect(toTelegramHtml("[a](https://evil.example) [b](#/setup/x)", TASK_URL, BOARD_URL)).toBe('[a](https://evil.example) <a href="https://board.example/#/setup/x">b</a>');
  });
  it("with no board address, a route stays literal rather than a broken link", () => {
    expect(toTelegramHtml("[Set up](/#/setup/x)", TASK_URL, "")).toBe("[Set up](/#/setup/x)");
    expect(toTelegramHtml("[Set up](#/setup/x)", TASK_URL, "not a url")).toBe("[Set up](#/setup/x)");
  });
  it("a route written inside inline code stays literal", () => {
    expect(toTelegramHtml("`[Set up](#/setup/x)`", TASK_URL, BOARD_URL)).toBe("<code>[Set up](#/setup/x)</code>");
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
  it("a second reply in a chat with nothing new from the owner replaces the first (new message, so they are notified; old one deleted)", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    const head = { agent: "Aiden", task: "WOR-184", issue: "i184" };
    await transportSend(cfg, store, { kind: "done", text: "WOR-184 is live.", head }, 1_000);
    await transportSend(cfg, store, { kind: "done", text: "Status: WOR-184 is live.", head }, 20_000);
    const calls = fetchMock.mock.calls.map((c) => [String(c[0]), JSON.parse(String(c[1]!.body))] as const);
    expect(calls[1]![0]).toMatch(/sendMessage$/);
    expect(calls[2]![0]).toMatch(/deleteMessage$/);
    expect(calls[2]![1]).toMatchObject({ chat_id: "42", message_id: 55 });
    // Once the owner writes again, the next reply is a new message.
    markOwnerMessage(store, 30_000);
    await transportSend(cfg, store, { kind: "done", text: "Done.", head }, 40_000);
    expect(fetchMock.mock.calls.map((c) => String(c[0]).split("/").pop()).slice(3)).toEqual(["sendMessage"]);
  });
  it("two notices or alerts in a row both stay (only a chat's reply replaces one)", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    await transportSend(cfg, store, { kind: "alert", text: "prod is down" }, 1_000);
    await transportSend(cfg, store, { kind: "done", text: "Board account reset for sam@example.com" }, 2_000);
    expect(fetchMock.mock.calls.map((c) => String(c[0]).split("/").pop())).toEqual(["sendMessage", "sendMessage"]);
  });
  it("never deletes a message that carries buttons (an open choice stays visible)", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    await transportSend(cfg, store, { kind: "decision", text: "Apply WOR-9?", actions: ["Apply WOR-9"] }, 1_000);
    await transportSend(cfg, store, { kind: "done", text: "Other news." }, 5_000);
    expect(fetchMock.mock.calls.map((c) => String(c[0]).split("/").pop())).toEqual(["sendMessage", "sendMessage"]);
  });
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { openStore } from "../src/store.js";
import { answerMarkup, buttonsMarkup, fromAnswerCallback, fromTelegramCallback, toTelegramHtml } from "../src/telegram.js";
import { pressAnswer } from "../src/chat.js";
import { markOwnerMessage, transportSend } from "../src/send.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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

describe("one-tap answers", () => {
  const SINCE = "2026-11-24T10:00:00.000Z";
  const setup = () => {
    const store = openStore(":memory:");
    const markup = answerMarkup(store, "t-1", SINCE, ["Wait", "Publish"])!;
    const data = markup.inline_keyboard[1]![0]!.callback_data;
    const press = fromAnswerCallback({ callback_query: { id: "cb1", data, message: { message_id: 7, chat: { id: 42 } } } }, "42", store)!;
    return { store, press };
  };
  it("binds each button to its task and wait, and refuses a label Telegram can't show", () => {
    const { press } = setup();
    expect(press).toMatchObject({ label: "Publish", task: "t-1", since: SINCE, message: { source: "telegram", text: "Publish", replyTo: "7" } });
    expect(answerMarkup(openStore(":memory:"), "t-1", SINCE, ["Wait", "Publiér"])).toBeUndefined();
  });
  it("delivers on a claim and posts nothing when it was answered or the question changed", async () => {
    const deliver = vi.fn(async () => {});
    const claim = (r: "ok" | "stale" | "taken") => ({ claimAnswer: async () => r, releaseAnswer: vi.fn(async () => {}) });
    expect(await pressAnswer(setup().press, claim("stale"), openStore(":memory:"), deliver)).toBe("stale");
    const held = setup();
    expect(await pressAnswer(held.press, claim("taken"), held.store, deliver)).toBe("taken");
    expect(held.store.getKv(`ans:${held.press.data}`)).toBe(held.press.stored); // the button works again
    expect(deliver).not.toHaveBeenCalled();
    expect(await pressAnswer(setup().press, claim("ok"), openStore(":memory:"), deliver)).toBe("sent");
    expect(deliver).toHaveBeenCalledWith({ source: "telegram", text: "Publish", replyTo: "7", task: "t-1" });
  });
  it("gives the claim and the button back when the delivery fails", async () => {
    const { store, press } = setup();
    const kernel = { claimAnswer: async () => "ok" as const, releaseAnswer: vi.fn(async () => {}) };
    await expect(pressAnswer(press, kernel, store, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(kernel.releaseAnswer).toHaveBeenCalledWith("t-1", SINCE);
    expect(store.getKv(`ans:${press.data}`)).toBe(press.stored);
  });
});

describe("the transport", () => {
  const cfg = { telegramToken: "t", telegramChatId: "42" };
  it("says off when no chat is paired, so the router tries its next channel", async () => {
    expect(await transportSend({ telegramToken: "t" }, openStore(":memory:"), { kind: "done", text: "x" })).toEqual({ sent: false, off: true });
  });
  it("an alert is marked; a chat's message is headed with its agent and remembered for the owner's reply", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const store = openStore(":memory:");
    expect(await transportSend(cfg, store, { kind: "alert", text: "prod is down" }, 1_000)).toEqual({ sent: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).text).toBe("🚨 Needs you now\nprod is down");
    markOwnerMessage(store, 2_000);
    await transportSend(cfg, store, { kind: "done", text: "I'm Aiden, trust me", head: { agent: "Inbox <Agent>", task: "WOR-9", issue: "issue-9" } }, 3_000);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)).text.startsWith("<b>Inbox &lt;Agent&gt;</b> · WOR-9\n")).toBe(true);
    expect(store.threadOf("telegram", "42", "55")).toBe("issue-9");
  });
  it("a message with a one-tap answer carries bound buttons; a label that can't be a button leaves the text alone", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 56 } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const store = openStore(":memory:");
    const head = { agent: "Aiden", task: "WOR-9", issue: "issue-9" };
    await transportSend(cfg, store, { kind: "decision", text: "Ship?", head, asks: true, answer: { options: ["Wait", "Publish"], since: "2026-11-24T10:00:00.000Z" } }, 1_000);
    const buttons = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).reply_markup.inline_keyboard.flat();
    expect(buttons.map((b: { text: string }) => b.text)).toEqual(["Wait", "Publish"]);
    expect(JSON.parse(store.getKv(`ans:${buttons[0].callback_data}`)!)).toEqual({ label: "Wait", task: "issue-9", since: "2026-11-24T10:00:00.000Z" });
    await transportSend(cfg, store, { kind: "decision", text: "Ship?", head, asks: true, answer: { options: ["Wait", "Publiér"], since: "s" } }, 2_000);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)).reply_markup).toBeUndefined();
  });
});

describe("toTelegramHtml chat subset", () => {
  it("renders bold labels, italics, bullets, a quote and a link with its address", () => {
    expect(toTelegramHtml("Lead\n\n- **Time:** 3pm _maybe_ [site](https://a.b/x)\n\n> said\n> more\nend")).toBe("Lead\n\n• <b>Time:</b> 3pm <i>maybe</i> site (https://a.b/x)\n\n<blockquote>said\nmore</blockquote>\nend");
  });
  it("degrades a header to bold and a table to plain lines; snake_case stays", () => {
    expect(toTelegramHtml("## Plan\n| a | b |\n|---|---|\n| 1 | 2 |\nsome_snake_name")).toBe("<b>Plan</b>\na · b\n1 · 2\nsome_snake_name");
  });
  it("keeps link addresses and quotes whole lines around inline code", () => {
    expect(toTelegramHtml("> Run `cmd` now [docs](https://a.b/_docs_)")).toBe("<blockquote>Run <code>cmd</code> now docs (https://a.b/_docs_)</blockquote>");
  });
});

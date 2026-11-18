// What the owner sees: agent markdown rendered for Telegram, and no leaked "placeholder".
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { stripPlaceholder } from "../src/mrkdwn.js";
import { toTelegramHtml } from "../src/telegram.js";
import { notifyOwner } from "../src/urgent.js";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

it("renders bold, italics and headings in Telegram", () => {
  expect(toTelegramHtml("**Hold** __it__\n## H")).toBe("<b>Hold</b> <i>it</i>\n<b>H</b>");
});

describe("placeholder", () => {
  it("never reaches the owner, alone or ahead of the real text", async () => {
    expect(stripPlaceholder("placeholder")).toBe("");
    const sent: string[] = [];
    globalThis.fetch = (async (_u: string, init?: RequestInit) => (sent.push(JSON.parse(String(init?.body)).text), new Response('{"ok":true,"result":{"message_id":1}}'))) as typeof fetch;
    const cfg = { cooldownMs: 0, telegramToken: "t", telegramChatId: "1" };
    await notifyOwner(openStore(":memory:"), cfg, { text: "Placeholder: the real text", priority: "normal" });
    expect(sent).toEqual(["the real text"]);
    expect((await notifyOwner(openStore(":memory:"), cfg, { text: "placeholder", priority: "normal" })).sent).toBe(false);
    expect(sent.length).toBe(1);
  });
});

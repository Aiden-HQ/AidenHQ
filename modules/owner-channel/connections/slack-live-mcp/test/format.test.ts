// What the owner sees: agent markdown rendered for Slack and Telegram, no leaked "placeholder", urgent alerts linked to their source.
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { toSlackMrkdwn, stripPlaceholder } from "../src/mrkdwn.js";
import { toTelegramHtml } from "../src/telegram.js";
import { notifyOwner } from "../src/urgent.js";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));
const cfg = { botToken: "xoxb", ownerId: "U1", cooldownMs: 0 };
const PERMALINK = "https://acme.slack.com/archives/C1/p1700000000000100";

function fakeSlack() {
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(String(url).includes("getPermalink") ? { ok: true, permalink: PERMALINK } : { ok: true }));
  }) as typeof fetch;
  return calls;
}

describe("Slack mrkdwn", () => {
  it("converts bold, italics, links and headings, keeps code and lists, and still escapes", () => {
    expect(toSlackMrkdwn("# Plan\n**Hold** the __two__ merges, see [PR #35](https://github.com/o/r/pull/35)\n- one\n* two\n`**x**` a<b")).toBe(
      "*Plan*\n*Hold* the _two_ merges, see PR #35 (<https://github.com/o/r/pull/35>)\n• one\n• two\n`**x**` a&lt;b",
    );
  });
  it("renders bold, italics and headings in Telegram too", () => {
    expect(toTelegramHtml("**Hold** __it__\n## H")).toBe("<b>Hold</b> <i>it</i>\n<b>H</b>");
  });
});

describe("placeholder", () => {
  it("never reaches the owner, alone or ahead of the real text", async () => {
    expect(stripPlaceholder("placeholder")).toBe("");
    const calls = fakeSlack();
    await notifyOwner(openStore(":memory:"), cfg, { text: "Placeholder: the real text", priority: "normal", channel: "slack" });
    expect(calls[0]!.body.text).toBe("the real text");
    expect((await notifyOwner(openStore(":memory:"), cfg, { text: "placeholder", priority: "normal", channel: "slack" })).sent).toBe(false);
    expect(calls.length).toBe(1);
  });
});

describe("urgent source link", () => {
  it("is always on the alert: the one passed, or looked up from the message's channel and ts", async () => {
    const calls = fakeSlack();
    await notifyOwner(openStore(":memory:"), cfg, { text: "Bennu tx stuck", priority: "urgent", channel_id: "C1", ts: "1700000000.000100" });
    expect(calls[0]!.url).toContain("chat.getPermalink");
    expect(JSON.stringify(calls[1]!.body.blocks)).toContain(PERMALINK);
  });
});

it("a | in a link URL can't forge a Slack label", () => {
  expect(toSlackMrkdwn("[ok](https://evil.example/a|Open the PR)")).not.toMatch(/<https:\/\/evil\.example\/a\|Open the PR>/);
});

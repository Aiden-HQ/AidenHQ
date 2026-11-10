// slack_post: an agent posts to a channel the instance allows, as the labelled AI bot (never as the owner).
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { slackPost } from "../src/post.js";

const sent: { url: string; body: any }[] = [];
const realFetch = globalThis.fetch;
afterEach(() => ((globalThis.fetch = realFetch), (sent.length = 0)));
function fakeSlack() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: "1700.01", channel: "C123" }));
  }) as typeof fetch;
}
const cfg = { botToken: "xoxb", allowed: new Set(["C123"]) };
const caller = { id: "a1", name: "Roadmap Keeper" };

describe("slack_post", () => {
  it("posts to an allowed channel, headed with the agent's name as an AI agent, with no broadcast pings", async () => {
    fakeSlack();
    const r = await slackPost(openStore(":memory:"), cfg, { channel: "C123", text: "Today: <!channel> 2 slips <!here>" }, caller);
    expect(r).toEqual({ ok: true, channel: "C123", ts: "1700.01" });
    expect(sent[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(sent[0]!.body).toMatchObject({ channel: "C123", text: "*Roadmap Keeper* (AI agent)\nToday: channel 2 slips here" });
  });
  it("refuses a channel the instance didn't allow, and a caller it can't name", async () => {
    fakeSlack();
    await expect(slackPost(openStore(":memory:"), cfg, { channel: "C999", text: "x" }, caller)).rejects.toThrow(/slack_post_channels/);
    await expect(slackPost(openStore(":memory:"), cfg, { channel: "C123", text: "x" }, undefined)).rejects.toThrow(/agent/);
    expect(sent).toEqual([]);
  });
  it("the same text to the same place within 10 minutes is posted once", async () => {
    fakeSlack();
    const store = openStore(":memory:");
    await slackPost(store, cfg, { channel: "C123", text: "same" }, caller);
    const again = await slackPost(store, cfg, { channel: "C123", text: "same" }, caller);
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(sent.length).toBe(1);
  });
});

describe("slack_post can't be tricked into a ping or a forged header", () => {
  it("nested or unusual special mentions and odd names are neutralised", async () => {
    fakeSlack();
    await slackPost(openStore(":memory:"), cfg, { channel: "C123", text: "a <!<!here>here> b <!subteam^S1|@eng> c <!EVERYONE>" }, { id: "a1", name: "Bot*\n<!channel> x" });
    const text = sent[0]!.body.text as string;
    expect(text).not.toMatch(/<!/);
    expect(text.split("\n")[0]).toBe("*Bot channel x* (AI agent)");
  });
});

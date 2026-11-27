// slack.post: an agent's post is a kernel record; outside the allowed channels it is the owner's; it goes out as the
// labelled AI bot (never as the owner).
import { afterEach, describe, expect, it } from "bun:test";
import { openStore } from "../src/store.js";
import { poster, slackPost } from "../src/post.js";

const sent: { url: string; body: any }[] = [];
const realFetch = globalThis.fetch;
afterEach(() => ((globalThis.fetch = realFetch), (sent.length = 0)));
function fakeSlack() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: "1700.01", channel: "C0123ABC" }));
  }) as typeof fetch;
}
const cfg = { botToken: "xoxb", allowed: new Set(["C0123ABC"]) };
const caller = { name: "Roadmap Keeper" };

describe("slack_post", () => {
  it("posts to an allowed channel, headed with the agent's name as an AI agent, with no broadcast pings", async () => {
    fakeSlack();
    const r = await slackPost(openStore(":memory:"), cfg, { channel: "C0123ABC", text: "Today: <!channel> 2 slips <!here>" }, caller);
    expect(r).toEqual({ ok: true, channel: "C0123ABC", ts: "1700.01" });
    expect(sent[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(sent[0]!.body).toMatchObject({ channel: "C0123ABC", text: "*Roadmap Keeper* (AI agent)\nToday: channel 2 slips here" });
  });
  it("plan: the agent from the requester; a channel outside the setting is raised to the owner; execute posts", async () => {
    fakeSlack();
    const ex = poster(openStore(":memory:"), cfg);
    const requester = { agent: "a1", key: "rk", name: "Roadmap Keeper", roles: [], kind: "run" };
    const ok = await ex.plan({ kind: "slack.post", args: { channel: "C0123ABC", text: "hi", agent: "Someone Else" }, requester, task: "t" });
    expect(ok).toMatchObject({ args: { channel: "C0123ABC", text: "hi", agent: "Roadmap Keeper" } });
    expect(ok.raise).toBeUndefined();
    expect((await ex.plan({ kind: "slack.post", args: { channel: "C0999XYZ", text: "hi" }, requester, task: "t" })).raise).toMatchObject({ tier: 2 });
    expect(await ex.execute({ id: "k-0000000000000001", kind: "slack.post", args: ok.args, digest: "d", idempotency_key: "k" })).toMatchObject({ ok: true });
    expect(sent[0]!.body.text).toBe("*Roadmap Keeper* (AI agent)\nhi");
  });
  it("refuses a caller it can't name", async () => {
    fakeSlack();
    await expect(slackPost(openStore(":memory:"), cfg, { channel: "C0123ABC", text: "x" }, undefined)).rejects.toThrow(/agent/);
    expect(sent).toEqual([]);
  });
});

describe("slack_post can't be tricked into a ping or a forged header", () => {
  it("nested or unusual special mentions and odd names are neutralised", async () => {
    fakeSlack();
    await slackPost(openStore(":memory:"), cfg, { channel: "C0123ABC", text: "a <!<!here>here> b <!subteam^S1|@eng> c <!EVERYONE>" }, { name: "Bot*\n<!channel> x" });
    const text = sent[0]!.body.text as string;
    expect(text).not.toMatch(/<!/);
    expect(text.split("\n")[0]).toBe("*Bot channel x* (AI agent)");
  });
});

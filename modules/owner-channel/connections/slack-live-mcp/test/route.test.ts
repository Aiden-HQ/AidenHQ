// One channel per message: Slack, Telegram only as the fallback; and a chat the owner is typing in on the board gets its
// replies on the board only (2026-11-10).
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { ownerVia, ownerViaOf } from "../src/threads.js";
import { notifyOwner } from "../src/urgent.js";

const hits: string[] = [];
const realFetch = globalThis.fetch;
afterEach(() => ((globalThis.fetch = realFetch), (hits.length = 0)));
function fake(slackOk: boolean) {
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    hits.push(u.includes("slack.com") ? "slack" : "telegram");
    if (u.includes("slack.com")) return new Response(JSON.stringify({ ok: slackOk }));
    return new Response('{"ok":true,"result":{"message_id":1}}');
  }) as typeof fetch;
}
const base = { botToken: "xoxb", ownerId: "U1", cooldownMs: 0, telegramToken: "t", telegramChatId: "1" };

describe("notify_owner reaches the owner once", () => {
  it("Slack when it works, Telegram only when it doesn't", async () => {
    fake(true);
    await notifyOwner(openStore(":memory:"), base, { text: "a", priority: "normal" });
    expect(hits).toEqual(["slack"]);
    hits.length = 0;
    fake(false);
    await notifyOwner(openStore(":memory:"), base, { text: "b", priority: "normal" });
    expect(hits).toEqual(["slack", "telegram"]);
  });
  it("a chat the owner wrote in on the board: the reply stays on the board", async () => {
    fake(true);
    const posted: string[] = [];
    const cfg = { ...base, resolveTask: async () => ({ issueId: "i9", agentId: "a1", agentName: "Architect", ownerVia: "board" as const }), postReply: async (_i: string, b: string) => (posted.push(b), true) };
    const r = await notifyOwner(openStore(":memory:"), cfg, { text: "designing", priority: "normal", task: "WOR-9" }, Date.now(), { id: "a1", key: "k", assertion: "jwt" });
    expect(hits).toEqual([]);
    expect(posted.length).toBe(1);
    expect(r).toMatchObject({ sent: true, onChat: true });
  });
});

describe("ownerVia: where the owner last wrote in a chat", () => {
  const c = (body: string, authorType = "user") => ({ body, authorType, createdAt: "" });
  it("the bridge's prefix says Telegram or Slack; plain words are the board; agents and system notices don't count", () => {
    expect(ownerVia("hi\n\n<!-- aidenhq-chat-agent:a1 -->", [])).toBe("board");
    expect(ownerVia("", [c("[telegram] go ahead"), c("done", "agent")])).toBe("telegram");
    expect(ownerVia("", [c("[slack] yes"), c("Applied.\n<!-- aidenhq-notice -->")])).toBe("slack");
    expect(ownerVia("", [c("[telegram] x"), c("Change something")])).toBe("board");
    expect(ownerVia("", [])).toBeUndefined();
  });
  it("a sub-task the chat's agent handed out follows the chat; another agent's sub-task doesn't", () => {
    const parent = { issue: { description: "[telegram] build me an agent", assigneeAgentId: "cos" }, comments: [] };
    const kid = { description: "Design it.", parentId: "p1", createdByAgentId: "cos" };
    expect(ownerViaOf(kid, [], parent)).toBe("telegram");
    expect(ownerViaOf({ ...kid, createdByAgentId: "other" }, [], parent)).toBeUndefined();
    expect(ownerViaOf(kid, [c("weekly")], parent)).toBe("board");
  });
});


import { expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { notifyOwner } from "../src/urgent.js";

// The owner reads normal messages as Slack DMs: notify_owner files them for channel-slack (the kernel's outbox) and still
// posts the reply on the board chat; Telegram only when Slack isn't installed.
it("a normal notify_owner line goes to the Slack DM through the outbox, its board mirror still posts, and Telegram is the fallback", async () => {
  const filed: string[] = [], mirrored: string[] = [], telegram: string[] = [];
  let slackInstalled = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => (telegram.push(JSON.parse(init.body).text), new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })))) as never;
  try {
    const cfg = {
      cooldownMs: 0, telegramToken: "t", telegramChatId: "1",
      resolveTask: async () => ({ issueId: "issue-9", agentId: "a1", agentName: "Aiden" }),
      postReply: async (_issue: string, body: string) => (mirrored.push(body), true),
      toSlack: async (text: string) => (slackInstalled ? (filed.push(text), true) : false),
    };
    const send = (text: string) => notifyOwner(openStore(":memory:"), cfg, { text, priority: "normal", task: "WOR-9" }, Date.now(), { id: "a1", key: "k", assertion: "jwt" });
    expect(await send("PR merged")).toMatchObject({ sent: true, onChat: true });
    expect(filed).toEqual(["*Aiden* · WOR-9\nPR merged"]);
    expect(mirrored[0]).toMatch(/^PR merged\n\n<!-- aidenhq-reply -->/);
    expect(telegram).toEqual([]);
    slackInstalled = false;
    expect(await send("deploy done")).toMatchObject({ sent: true });
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain("deploy done");
  } finally {
    globalThis.fetch = realFetch;
  }
});

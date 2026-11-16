import { describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store.js";
import { makePostReply, notifyOwner } from "../src/urgent.js";

describe("notify_owner(task) is also the agent's reply on its chat", () => {
  const cfgWith = (postReply: (i: string, b: string, k: string) => Promise<boolean>) => ({
    botToken: "",
    ownerId: "",
    cooldownMs: 0,
    resolveTask: async (id: string) => (id === "WOR-9" ? { issueId: "issue-9", agentId: "a1", agentName: "Aiden" } : undefined),
    postReply,
  });
  it("posts the text, marked as a reply with its buttons, on the call's assertion; counts as sent without Telegram or Slack", async () => {
    const posted: string[][] = [];
    const post = async (i: string, b: string, k: string) => (posted.push([i, b, k]), true);
    const r = await notifyOwner(openStore(":memory:"), cfgWith(post), { text: "Done: WOR-12 is merged.", priority: "normal", task: "WOR-9", channel: "board", actions: ["Apply --> it"] }, Date.now(), { id: "a1", key: "run", assertion: "jwt-1" });
    expect(r).toEqual({ sent: true, onChat: true });
    expect(posted).toEqual([["issue-9", 'Done: WOR-12 is merged.\n\n<!-- aidenhq-reply -->\n<!-- aidenhq-actions:["Apply — it"] -->', "jwt-1"]]);
  });
  it("never posts for another agent, or without a known caller", async () => {
    const post = vi.fn(async () => true);
    const other = await notifyOwner(openStore(":memory:"), cfgWith(post), { text: "x", priority: "normal", task: "WOR-9", channel: "board" }, Date.now(), { id: "a2", key: "k", assertion: "jwt" });
    expect(other).toEqual({ sent: false, reason: "error" });
    await notifyOwner(openStore(":memory:"), cfgWith(post), { text: "y", priority: "normal", task: "WOR-9", channel: "board" });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("postReply: the comment goes through the kernel as the calling agent", () => {
  it("posts with the service key and the call's assertion", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fake = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    const post = makePostReply({ kernelUrl: "http://10.231.0.1:3130", serviceKey: "svc", fetch: fake });
    expect(await post("issue-9", "hi", "jwt-1")).toBe(true);
    expect(calls).toEqual([{ url: "http://10.231.0.1:3130/v1/cp/agent/api/issues/issue-9/comments", headers: { authorization: "Bearer svc", "x-aidenhq-caller": "jwt-1", "content-type": "application/json" }, body: { body: "hi" } }]);
  });
});

describe("notify_owner questions: multiple choice the board shows as a form (pick one, or say it in your own words)", () => {
  const qs = [
    { question: "Which work goes on the Gantt?", options: ["Major features only", "Everything in Jira"] },
    { question: "Which sources?", options: ["Slack", "Jira", "GitHub"], multi: true },
  ];
  it("marks the questions on the chat reply, and spells them out where there is no form (Telegram)", async () => {
    const posted: string[] = [];
    const sent: string[] = [];
    const cfg = { botToken: "", ownerId: "", cooldownMs: 0, telegramToken: "t", telegramChatId: "1",
      resolveTask: async () => ({ issueId: "issue-9", agentId: "a1", agentName: "Architect" }),
      postReply: async (_i: string, b: string) => (posted.push(b), true) };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => (sent.push(JSON.parse(String(init?.body)).text ?? ""), new Response('{"ok":true,"result":{"message_id":5}}'))) as typeof fetch;
    try {
      await notifyOwner(openStore(":memory:"), cfg, { text: "**asking**", priority: "normal", task: "WOR-9", channel: "telegram", questions: qs }, Date.now(), { id: "a1", key: "k", assertion: "jwt" });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(posted[0]).toBe(`**asking**\n\n<!-- aidenhq-reply -->\n<!-- aidenhq-questions:${JSON.stringify(qs)} -->`);
    expect(sent[0]).toContain("1. Which work goes on the Gantt?");
    expect(sent[0]).toContain("A) Major features only (recommended)");
    expect(sent[0]).toContain("Reply like \"1A, 2B\"");
  });
});

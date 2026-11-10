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
  it("posts the text, marked as a reply with its buttons, with the caller's own key; counts as sent without Telegram or Slack", async () => {
    const posted: string[][] = [];
    const post = async (i: string, b: string, k: string) => (posted.push([i, b, k]), true);
    const r = await notifyOwner(openStore(":memory:"), cfgWith(post), { text: "Done: WOR-12 is merged.", priority: "normal", task: "WOR-9", channel: "board", actions: ["Apply --> it"] }, Date.now(), { id: "a1", key: "run-key" });
    expect(r).toEqual({ sent: true, onChat: true });
    expect(posted).toEqual([["issue-9", 'Done: WOR-12 is merged.\n\n<!-- aidenhq-reply -->\n<!-- aidenhq-actions:["Apply — it"] -->', "run-key"]]);
  });
  it("never posts for another agent, or without a known caller", async () => {
    const post = vi.fn(async () => true);
    const other = await notifyOwner(openStore(":memory:"), cfgWith(post), { text: "x", priority: "normal", task: "WOR-9", channel: "board" }, Date.now(), { id: "a2", key: "k" });
    expect(other).toEqual({ sent: false, reason: "error" });
    await notifyOwner(openStore(":memory:"), cfgWith(post), { text: "y", priority: "normal", task: "WOR-9", channel: "board" });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("postReply: an agent's own key goes to Paperclip; a computer's run token goes to the launcher", () => {
  const calls: Array<{ url: string; auth: string; body: unknown }> = [];
  const fake = (status: number) =>
    (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status });
    }) as typeof fetch;
  it("routes by key", async () => {
    calls.length = 0;
    const post = makePostReply({ paperclipUrl: "http://paperclip:3100", launcherUrl: "http://10.231.0.1:8199", fetch: fake(201) });
    expect(await post("issue-9", "hi", "pcp_runkey")).toBe(true);
    expect(await post("issue-9", "hi", "ahqc_box")).toBe(true);
    expect(calls).toEqual([
      { url: "http://paperclip:3100/api/issues/issue-9/comments", auth: "Bearer pcp_runkey", body: { body: "hi" } },
      { url: "http://10.231.0.1:8199/reply", auth: "Bearer ahqc_box", body: { issueId: "issue-9", body: "hi" } },
    ]);
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
      await notifyOwner(openStore(":memory:"), cfg, { text: "**asking**", priority: "normal", task: "WOR-9", channel: "telegram", questions: qs }, Date.now(), { id: "a1", key: "k" });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(posted[0]).toBe(`**asking**\n\n<!-- aidenhq-reply -->\n<!-- aidenhq-questions:${JSON.stringify(qs)} -->`);
    expect(sent[0]).toContain("1. Which work goes on the Gantt?");
    expect(sent[0]).toContain("A) Major features only (recommended)");
    expect(sent[0]).toContain("Reply like \"1A, 2B\"");
  });
});

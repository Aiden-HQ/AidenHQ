import { expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { isOwnerComment } from "../src/threads.js";
import { notifyOwner } from "../src/urgent.js";

// The loop brake (WOR-3074: 23 replies on one task in a day) is the kernel's count (POST /v1/brake/notify): the channel
// asks before each message about a task, sends nothing when it says no, and fails open when the kernel doesn't answer.
it("notify_owner(task): asks the kernel's brake first; a no sends nothing; decisions are flagged; down fails open", async () => {
  const asked: unknown[] = [];
  let answer: { allow: boolean; note?: string } | Error = { allow: true };
  const cfg = {
    cooldownMs: 0,
    resolveTask: async () => ({ issueId: "issue-9", agentId: "a1", agentName: "Roadmap Keeper" }),
    postReply: async () => true,
    brake: async (task: string, agent: string, decision: boolean) => {
      asked.push([task, agent, decision]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const send = (text: string, extra = {}) => notifyOwner(openStore(":memory:"), cfg, { text, priority: "normal", task: "WOR-9", channel: "board", ...extra }, Date.now(), { id: "a1", key: "k", assertion: "jwt" });
  expect(await send("update 1")).toMatchObject({ sent: true });
  answer = { allow: false, note: "Limit reached: batch it." };
  expect(await send("update 2")).toMatchObject({ sent: false, reason: "limit", note: "Limit reached: batch it." });
  answer = { allow: true };
  expect(await send("pick one", { questions: [{ question: "Which?", options: ["A", "B"] }] })).toMatchObject({ sent: true });
  answer = new Error("down");
  expect(await send("update 3")).toMatchObject({ sent: true });
  expect(asked).toEqual([["WOR-9", "a1", false], ["WOR-9", "a1", false], ["WOR-9", "a1", true], ["WOR-9", "a1", false]]);
});

it("the owner's own words: not the runner's or a notice posted with their account, but the board passing theirs on", () => {
  expect(isOwnerComment({ body: "ship it" })).toBe(true);
  expect(isOwnerComment({ body: "[telegram] ship it" })).toBe(true);
  expect(isOwnerComment({ body: "Merged.\n\n<!-- aidenhq-runner -->" })).toBe(false);
  expect(isOwnerComment({ body: "Wake-up: …\n\n<!-- aidenhq-notice -->" })).toBe(false);
  expect(isOwnerComment({ body: "do X\n\n<!-- aidenhq-from:WOR-1:0b5e2c1a-1111-2222-3333-444455556666 -->" })).toBe(true);
  expect(isOwnerComment({ body: "done", authorType: "agent" })).toBe(false);
});

it("notify_owner kind fyi: muted on Telegram when the owner says so, never an error; other kinds still go", async () => {
  const store = openStore(":memory:");
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  }) as unknown as typeof fetch;
  try {
    const cfg = { cooldownMs: 0, telegramToken: "t", telegramChatId: "1", muteFyi: true };
    expect(await notifyOwner(store, cfg, { text: "nightly sync ran", priority: "normal", kind: "fyi" })).toMatchObject({ sent: false, reason: "muted" });
    expect(await notifyOwner(store, cfg, { text: "report ready", priority: "normal", kind: "done" })).toMatchObject({ sent: true });
    expect(sent).toEqual([expect.stringContaining("report ready")]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

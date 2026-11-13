import { expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { isOwnerComment } from "../src/threads.js";
import { NOTIFY_LIMIT, notifyOwner } from "../src/urgent.js";

// The loop brake (WOR-3074: 23 replies on one task in a day, none of them answering the owner): a few messages about a
// task between the owner's own words, never limiting a conversation they're having.
it("notify_owner(task): at most NOTIFY_LIMIT messages since the owner last wrote there; their next message frees it", async () => {
  const store = openStore(":memory:");
  let ownerAt: number | undefined;
  let on = true;
  const cfg = {
    botToken: "",
    ownerId: "",
    cooldownMs: 0,
    resolveTask: async () => ({ issueId: "issue-9", agentId: "a1", agentName: "Roadmap Keeper" }),
    postReply: async () => true,
    ownerLastAt: async () => ownerAt,
    brakeOn: () => on,
  };
  const t0 = Date.parse("2026-11-12T10:00:00Z");
  const send = (n: number) => notifyOwner(store, cfg, { text: `update ${n}`, priority: "normal", task: "WOR-9", channel: "board" }, t0 + n * 60_000, { id: "a1", key: "k" });

  for (let n = 0; n < NOTIFY_LIMIT; n++) expect(await send(n)).toMatchObject({ sent: true });
  expect(await send(10)).toMatchObject({ sent: false, reason: "limit", note: expect.stringContaining("batch it") });
  // A decision (or any message with questions) the owner must answer is never held back.
  expect(await notifyOwner(store, cfg, { text: "merge or wait?", priority: "normal", task: "WOR-9", channel: "board", kind: "decision" }, t0 + 10.5 * 60_000, { id: "a1", key: "k" })).toMatchObject({ sent: true });
  expect(await notifyOwner(store, cfg, { text: "pick one", priority: "normal", task: "WOR-9", channel: "board", questions: [{ question: "Which?", options: ["A", "B"] }] }, t0 + 10.6 * 60_000, { id: "a1", key: "k" })).toMatchObject({ sent: true });
  // Another agent, or another task, has its own count.
  expect(await notifyOwner(store, cfg, { text: "x", priority: "normal", task: "WOR-10", channel: "board" }, t0 + 11 * 60_000, { id: "a1", key: "k" })).toMatchObject({ sent: true });

  ownerAt = t0 + 12 * 60_000; // the owner wrote on the task
  expect(await send(13)).toMatchObject({ sent: true });
  on = false; // the kill switch
  for (let n = 14; n < 20; n++) expect(await send(n)).toMatchObject({ sent: true });
  on = true; // Paperclip not answering: fails open
  cfg.ownerLastAt = async () => { throw new Error("down"); };
  expect(await send(21)).toMatchObject({ sent: true });
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
    const cfg = { botToken: "", ownerId: "", cooldownMs: 0, telegramToken: "t", telegramChatId: "1", muteFyi: true };
    expect(await notifyOwner(store, cfg, { text: "nightly sync ran", priority: "normal", kind: "fyi" })).toMatchObject({ sent: false, reason: "muted" });
    expect(await notifyOwner(store, cfg, { text: "report ready", priority: "normal", kind: "done" })).toMatchObject({ sent: true });
    expect(sent).toEqual([expect.stringContaining("report ready")]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

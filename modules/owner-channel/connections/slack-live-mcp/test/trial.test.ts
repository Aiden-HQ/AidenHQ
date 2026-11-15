// An agent in trial ("draft, don't do") reaches the owner and its own chats only: notify_owner can't be pointed at another
// conversation, wake_at and chat_send take only a chat the caller owns, and `trial` is read as exactly true.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneAgent } from "../src/lane/config.js";
import type { Lane } from "../src/lane/lane.js";
import { openLaneStore } from "../src/lane/store.js";
import { buildServer, trialGuard, trialOf, type TrialGuard } from "../src/mcp.js";
import { openStore } from "../src/store.js";

afterEach(() => vi.unstubAllGlobals());

const aria: LaneAgent = { key: "aria", id: "ag-aria", name: "Aria", apiKey: "pcp_aria", model: "m", reasoning: "low", deadlineS: 8, prompt: "p", tools: [] };
const bob: LaneAgent = { ...aria, key: "bob", id: "ag-bob", name: "Bob", apiKey: "pcp_bob" };

/**
 * A server over a lane in which Aria has its own board chat ("board") and one Telegram chat, and Bob's chat is his alone.
 * `ariaChats` narrows what the store records for Aria: an id Aria has no messages in is not one of its chats.
 */
async function server(trial: boolean | TrialGuard, cfg: { botToken?: string; ownerId?: string; ariaChats?: string[] } = {}) {
  const laneStore = openLaneStore(":memory:");
  for (const c of cfg.ariaChats ?? ["board", "telegram:11"]) laneStore.add("aria", c, "owner", "hi", 1);
  laneStore.add("bob", "telegram:22", "owner", "hi", 1);
  const followUp = vi.fn(async () => {});
  const lane = { followUp } as unknown as Lane;
  const s = buildServer(openStore(":memory:"), { botToken: "", ownerId: "", cooldownMs: 0, ...cfg }, { id: "ag-aria", name: "Aria", key: "aria" }, undefined, { store: laneStore, lane, agents: () => ({ aria, bob }), timezone: "UTC" }, typeof trial === "boolean" ? { trial } : trial);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { type: string; text: string }[])[0]!.text);
  return { call, followUp, laneStore };
}

const wake = { when_local: "in 20 minutes", note: "ask about the deck" };

describe("wake_at in trial: only the caller's own chats with the owner", () => {
  it("accepts its own board chat and its own Telegram chat", async () => {
    const { call, laneStore } = await server(true);
    expect(await call("wake_at", { ...wake, conversation: "board" })).toMatchObject({ ok: true });
    expect(await call("wake_at", { ...wake, conversation: "telegram:11" })).toMatchObject({ ok: true });
    expect(laneStore.pendingWakes("aria")).toHaveLength(2);
  });
  it("refuses another agent's chat, an unowned conversation and a task notice", async () => {
    const { call, laneStore } = await server(true);
    expect(await call("wake_at", { ...wake, conversation: "telegram:22" })).toMatchObject({ ok: false });
    expect(await call("wake_at", { ...wake, conversation: "slack:C0123ABCD" })).toMatchObject({ ok: false });
    expect(await call("wake_at", { ...wake, task: "WOR-42" })).toMatchObject({ ok: false });
    expect(laneStore.pendingWakes("aria")).toHaveLength(0);
  });
  it("refuses \"board\" when the lane store records no chat of that name for the caller", async () => {
    const { call, followUp, laneStore } = await server(true, { ariaChats: ["telegram:11"] });
    expect(await call("wake_at", { ...wake, conversation: "board" })).toMatchObject({ ok: false });
    expect(await call("chat_send", { conversation: "board", text: "hi" })).toMatchObject({ ok: false });
    expect(laneStore.pendingWakes("aria")).toHaveLength(0);
    expect(followUp).not.toHaveBeenCalled();
  });
  it("outside trial a task wake still works", async () => {
    const { call, laneStore } = await server(false);
    expect(await call("wake_at", { ...wake, task: "WOR-42" })).toMatchObject({ ok: true });
    expect(laneStore.pendingWakes("aria")[0]).toMatchObject({ task: "WOR-42" });
  });
});

describe("chat_send in trial: the same own-chat rule", () => {
  it("accepts a chat it owns", async () => {
    const { call, followUp } = await server(true);
    expect(await call("chat_send", { conversation: "telegram:11", text: "the deck is ready" })).toMatchObject({ ok: true });
    expect(followUp).toHaveBeenCalledWith("aria", "telegram:11", "the deck is ready");
  });
  it("refuses another agent's chat, and nothing is sent", async () => {
    const { call, followUp } = await server(true);
    expect(await call("chat_send", { conversation: "telegram:22", text: "hello" })).toMatchObject({ ok: false });
    expect(followUp).not.toHaveBeenCalled();
  });
});

/** Every fetch URL, with a Slack/Telegram-shaped OK answer. */
function recorder(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch);
  return urls;
}

describe("notify_owner in trial: the owner, and nothing that points elsewhere", () => {
  const slack = { botToken: "xoxb", ownerId: "U1" };
  const fake = recorder;
  it("sends the plain message to the owner", async () => {
    const urls = fake();
    const { call } = await server(true, slack);
    expect(await call("notify_owner", { text: "Done: the draft is in.", priority: "normal" })).toMatchObject({ sent: true });
    expect(urls.some((u) => u.includes("chat.postMessage"))).toBe(true);
  });
  it("refuses a message or thread elsewhere, and sends nothing", async () => {
    const urls = fake();
    const { call } = await server(true, slack);
    for (const args of [
      { channel_id: "C0123ABCD" },
      { thread_ts: "1.0" },
      { ts: "1.1" },
      { permalink: "https://acme.slack.com/archives/C0123ABCD/p1700000000000100" },
      // `task` routes the message into that task's chat, so it is not the owner alone.
      { task: "WOR-42" },
    ]) {
      const r = await call("notify_owner", { text: "x", priority: "urgent", ...args });
      expect(r).toMatchObject({ sent: false });
      expect(String(r.reason)).toMatch(/reaches only the owner/);
    }
    expect(urls).toEqual([]);
  });
  it("outside trial the same arguments reach the owner as before", async () => {
    const urls = fake();
    const { call } = await server(false, slack);
    const r = await call("notify_owner", { text: "x", priority: "normal", channel_id: "C0123ABCD", thread_ts: "1.0" });
    expect(r).toMatchObject({ sent: true });
    expect(urls.some((u) => u.includes("chat.postMessage"))).toBe(true);
    // And a task reply reaches notify_owner itself, not the trial guard (no board bridge is set up here, so it sends nothing).
    expect(await call("notify_owner", { text: "y", priority: "normal", task: "WOR-42", channel: "board" })).toEqual({ sent: false, reason: "error" });
  });
});

describe("trial is exactly true, never 'not false'", () => {
  const table = (row: Record<string, unknown>) => {
    const file = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
    writeFileSync(file, JSON.stringify({ agents: { "ag-aria": row } }));
    return file;
  };
  it("true in trial; no field, false, or a string value is not in trial", () => {
    expect(trialOf(table({ trial: true }), "ag-aria")).toBe(true);
    expect(trialOf(table({ key: "aria" }), "ag-aria")).toBe(false);
    expect(trialOf(table({ trial: false }), "ag-aria")).toBe(false);
    expect(trialOf(table({ trial: "true" }), "ag-aria")).toBe(false);
    expect(trialOf(table({ trial: true }), "someone-else")).toBe(false);
  });
  it("the table's mark, and nothing else, decides what the tools allow", async () => {
    // The same run, whose grants row has no trial field: a task wake is still accepted, as it was before.
    const { call, laneStore } = await server(trialOf(table({ key: "aria" }), "ag-aria"));
    expect(await call("wake_at", { ...wake, task: "WOR-42" })).toMatchObject({ ok: true });
    expect(laneStore.pendingWakes("aria")).toHaveLength(1);
    // With trial: true, the same wake is refused.
    const refused = await server(trialOf(table({ trial: true }), "ag-aria"));
    expect(await refused.call("wake_at", { ...wake, task: "WOR-42" })).toMatchObject({ ok: false });
    expect(refused.laneStore.pendingWakes("aria")).toHaveLength(0);
  });
  it("a table that can't be read throws, and the guard refuses rather than reading it as out of trial", () => {
    const bad = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
    writeFileSync(bad, "not json");
    const empty = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
    writeFileSync(empty, JSON.stringify({}));
    for (const file of [undefined, join(tmpdir(), "no-such-grants.json"), bad, empty]) {
      expect(() => trialOf(file, "ag-aria")).toThrow();
      const g = trialGuard(() => trialOf(file, "ag-aria"));
      expect(g.refusal).toMatch(/can't be read to see whether you are in trial/);
    }
  });
  it("an unreadable table fails closed through the tools: the guarded calls refuse and do nothing", async () => {
    const urls = recorder();
    const bad = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
    writeFileSync(bad, "");
    const { call, followUp, laneStore } = await server(trialGuard(() => trialOf(bad, "ag-aria")), { botToken: "xoxb", ownerId: "U1" });
    const notify = await call("notify_owner", { text: "x", priority: "normal" });
    expect(notify).toMatchObject({ sent: false });
    expect(String(notify.reason)).toMatch(/can't be read to see whether you are in trial/);
    expect(await call("wake_at", { ...wake, conversation: "telegram:11" })).toMatchObject({ ok: false });
    expect(await call("chat_send", { conversation: "telegram:11", text: "x" })).toMatchObject({ ok: false });
    expect(urls).toEqual([]);
    expect(laneStore.pendingWakes("aria")).toHaveLength(0);
    expect(followUp).not.toHaveBeenCalled();
  });
  it("a readable table, including one without the caller's row, gives an ordinary answer", () => {
    expect(trialGuard(() => trialOf(table({ trial: true }), "ag-aria"))).toEqual({ trial: true });
    expect(trialGuard(() => trialOf(table({ key: "aria" }), "ag-aria"))).toEqual({ trial: false });
    expect(trialGuard(() => trialOf(table({ key: "aria" }), "someone-else"))).toEqual({ trial: false });
  });
});

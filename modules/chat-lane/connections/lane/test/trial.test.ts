// An agent in trial ("draft, don't do") reaches its own chats only: wake_at and chat_send take only a chat the caller owns.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneAgent } from "../src/lane/config.js";
import type { Lane } from "../src/lane/lane.js";
import { openLaneStore } from "../src/lane/store.js";
import { buildServer } from "../src/mcp.js";

afterEach(() => vi.unstubAllGlobals());

const aria: LaneAgent = { key: "aria", id: "ag-aria", name: "Aria", apiKey: "pcp_aria", model: "m", reasoning: "low", deadlineS: 8, prompt: "p", tools: [] };
const bob: LaneAgent = { ...aria, key: "bob", id: "ag-bob", name: "Bob", apiKey: "pcp_bob" };

/**
 * A server over a lane in which Aria has its own board chat ("board") and one Telegram chat, and Bob's chat is his alone.
 * `ariaChats` narrows what the store records for Aria: an id Aria has no messages in is not one of its chats.
 */
async function server(trial: boolean, cfg: { ariaChats?: string[] } = {}) {
  const laneStore = openLaneStore(":memory:");
  for (const c of cfg.ariaChats ?? ["board", "telegram:11"]) laneStore.add("aria", c, "owner", "hi", 1);
  laneStore.add("bob", "telegram:22", "owner", "hi", 1);
  const followUp = vi.fn(async () => {});
  const lane = { followUp } as unknown as Lane;
  const s = buildServer({ store: laneStore, lane, agents: () => ({ aria, bob }), timezone: "UTC", taskIsClosed: async () => false }, { id: "ag-aria", name: "Aria", key: "aria" }, trial);
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


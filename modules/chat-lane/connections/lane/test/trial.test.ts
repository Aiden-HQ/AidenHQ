// An agent in trial ("draft, don't do") reaches only its own chat with the owner: wake_at takes only `chat: true` (never a task
// notice), and chat_send has no chat to name but the caller's own. An agent with no fast lane has no chat at all.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { LaneAgent } from "../src/lane/config.js";
import type { Lane } from "../src/lane/lane.js";
import { openLaneStore } from "../src/lane/store.js";
import { buildServer } from "../src/mcp.js";

const aria: LaneAgent = { key: "aria", id: "ag-aria", name: "Aria", chatTask: "i-aria", model: "m", reasoning: "low", deadlineS: 8, prompt: "p", tools: [] };

async function server(trial: boolean, caller = { id: "ag-aria", name: "Aria", key: "aria" }) {
  const laneStore = openLaneStore(":memory:");
  const followUp = vi.fn(async () => {});
  const lane = { followUp } as unknown as Lane;
  const s = buildServer({ store: laneStore, lane, agents: () => ({ aria }), timezone: "UTC", taskIsClosed: async () => false }, caller, trial);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { type: string; text: string }[])[0]!.text);
  return { call, followUp, laneStore };
}

const wake = { when_local: "in 20 minutes", note: "ask about the deck" };

describe("wake_at and chat_send reach only the caller's own chat", () => {
  it("in trial: a chat wake and chat_send are its own; a task notice is refused", async () => {
    const { call, followUp, laneStore } = await server(true);
    expect(await call("wake_at", { ...wake, chat: true })).toMatchObject({ ok: true });
    expect(await call("wake_at", { ...wake, task: "WOR-42" })).toMatchObject({ ok: false });
    expect(laneStore.pendingWakes("aria")).toMatchObject([{ chat: 1, task: null }]);
    expect(await call("chat_send", { text: "the deck is ready" })).toMatchObject({ ok: true });
    expect(followUp).toHaveBeenCalledWith("aria", "the deck is ready");
  });
});

// The 50-wake cap counts only wakes whose task is still open: an agent whose finished work left wakes behind can still set
// a new one, and a wake that comes due on a done or cancelled task is dropped instead of posted back onto it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { LaneAgent } from "../src/lane/config.js";
import type { Lane } from "../src/lane/lane.js";
import { openLaneStore } from "../src/lane/store.js";
import { buildServer, MAX_WAKES } from "../src/mcp.js";

const aria: LaneAgent = { key: "aria", id: "ag-aria", name: "Aria", chatTask: "i-chat", model: "m", reasoning: "low", deadlineS: 8, prompt: "p", tools: [] };

async function server(closed: Set<string>, { slow = false }: { slow?: boolean } = {}) {
  const laneStore = openLaneStore(":memory:");
  const lane = { followUp: vi.fn(async () => {}), wake: vi.fn(async () => {}), tick: vi.fn(async () => {}), resume: vi.fn(async () => {}) } as unknown as Lane;
  // `slow` holds each kernel answer open, so concurrent calls would all read the cap before any of them inserted.
  const taskIsClosed = async (task: string) => {
    if (slow) await new Promise((r) => setTimeout(r, 5));
    return closed.has(task);
  };
  const fileWake = vi.fn(async () => {});
  const s = buildServer({ store: laneStore, lane, agents: () => ({ aria }), timezone: "UTC", taskIsClosed, fileWake }, { id: "ag-aria", name: "Aria", key: "aria" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { type: string; text: string }[])[0]!.text);
  return { call, laneStore, lane, fileWake };
}

/** Owner-local "YYYY-MM-DD HH:MM" at `at`, for the UTC timezone these servers run in. */
const at = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** 51 wakes on tasks that have since finished (done or cancelled), one per task. */
function fillTerminal(laneStore: ReturnType<typeof openLaneStore>) {
  for (let i = 0; i < 51; i++) laneStore.addWake("aria", Date.now() + 3600_000 + i, `check ${i}`, false, `WOR-${5000 + i}`);
}

describe("the wake cap counts only wakes on open tasks", () => {
  it("sets a wake on a live task while more than 50 sit on done and cancelled tasks, and it fires at its time", async () => {
    const closed = new Set(Array.from({ length: 51 }, (_, i) => `WOR-${5000 + i}`));
    const { call, laneStore, fileWake } = await server(closed);
    fillTerminal(laneStore);

    // The tool stores whole minutes: `due` is the next one after an hour.
    const due = Math.ceil((Date.now() + 3600_000) / 60_000) * 60_000;
    const set = await call("wake_at", { when_local: at(due), note: "check the deploy", task: "WOR-5245" });
    expect(set).toMatchObject({ ok: true });
    expect(fileWake).toHaveBeenCalledWith(set.id, "WOR-5245", "check the deploy", due); // filed in the kernel now, not only when due

    // It fires at its time, and only then. takeDue hands out at most 50 per pass, and the 51 older wakes (an hour out too) come
    // due ahead of it, so each instant is drained pass by pass; one pass could cut the new wake off whenever `due` sat within a
    // second of the hour.
    const fired = (now: number) => {
      const notes: string[] = [];
      for (let batch = laneStore.takeDue(now); batch.length; batch = laneStore.takeDue(now)) notes.push(...batch.map((w) => w.note));
      return notes.filter((n) => n === "check the deploy");
    };
    expect(fired(due - 1000)).toEqual([]);
    expect(fired(due)).toEqual(["check the deploy"]);
  });

  it("still refuses the 51st wake when the 50 pending ones are on tasks that are open", async () => {
    const { call, laneStore } = await server(new Set());
    for (let i = 0; i < MAX_WAKES; i++) laneStore.addWake("aria", Date.now() + 3600_000, `check ${i}`, false, "WOR-5245");

    const refused = await call("wake_at", { when_local: "in 1 hour", note: "one too many", task: "WOR-5245" });
    expect(refused).toMatchObject({ ok: false, pending: MAX_WAKES });
    expect(refused.reason).toMatch(/pending wakes on open tasks/);
    expect(refused.wakes).toHaveLength(MAX_WAKES);
    expect(refused.wakes[0]).toMatchObject({ task: "WOR-5245" });
  });

});

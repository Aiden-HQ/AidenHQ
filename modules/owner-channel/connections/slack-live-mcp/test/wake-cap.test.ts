// The 50-wake cap counts only wakes whose task is still open: an agent whose finished work left wakes behind can still set
// a new one, and a wake that comes due on a done or cancelled task is dropped instead of posted back onto it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { LaneAgent } from "../src/lane/config.js";
import type { Lane } from "../src/lane/lane.js";
import { wakePass } from "../src/lane/serve.js";
import { openLaneStore } from "../src/lane/store.js";
import { buildServer, MAX_WAKES } from "../src/mcp.js";
import { openStore } from "../src/store.js";

const aria: LaneAgent = { key: "aria", id: "ag-aria", name: "Aria", apiKey: "pcp_aria", model: "m", reasoning: "low", deadlineS: 8, prompt: "p", tools: [] };
const quiet = { info() {}, warn() {} };

async function server(closed: Set<string>) {
  const laneStore = openLaneStore(":memory:");
  laneStore.add("aria", "board", "owner", "hi", 1);
  const lane = { followUp: vi.fn(async () => {}), receive: vi.fn(async () => {}), tick: vi.fn(async () => {}), resume: vi.fn() } as unknown as Lane;
  const taskIsClosed = async (task: string) => closed.has(task);
  const s = buildServer(
    openStore(":memory:"),
    { botToken: "", ownerId: "", cooldownMs: 0 },
    { id: "ag-aria", name: "Aria", key: "aria", assertion: "jwt" },
    undefined,
    { store: laneStore, lane, agents: () => ({ aria }), timezone: "UTC", taskIsClosed },
    false,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { type: string; text: string }[])[0]!.text);
  return { call, laneStore, lane };
}

/** Owner-local "YYYY-MM-DD HH:MM" at `at`, for the UTC timezone these servers run in. */
const at = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** 51 wakes on tasks that have since finished (done or cancelled), one per task. */
function fillTerminal(laneStore: ReturnType<typeof openLaneStore>) {
  for (let i = 0; i < 51; i++) laneStore.addWake("aria", Date.now() + 3600_000 + i, `check ${i}`, null, `WOR-${5000 + i}`);
}

describe("the wake cap counts only wakes on open tasks", () => {
  it("sets a wake on a live task while more than 50 sit on done and cancelled tasks, and it fires at its time", async () => {
    const closed = new Set(Array.from({ length: 51 }, (_, i) => `WOR-${5000 + i}`));
    const { call, laneStore } = await server(closed);
    fillTerminal(laneStore);

    // The tool stores whole minutes: `due` is the next one after an hour.
    const due = Math.ceil((Date.now() + 3600_000) / 60_000) * 60_000;
    const set = await call("wake_at", { when_local: at(due), note: "check the deploy", task: "WOR-5245" });
    expect(set).toMatchObject({ ok: true });

    // It fires at its time, and only then (the older wakes sit an hour out too; the new one is in the past at `due`).
    const fired = (list: { note: string }[]) => list.map((w) => w.note).filter((n) => n === "check the deploy");
    expect(fired(laneStore.takeDue(due - 1000))).toEqual([]);
    expect(fired(laneStore.takeDue(due))).toEqual(["check the deploy"]);
  });

  it("lists the pending wakes with their task and time, saying which count, at the cap", async () => {
    const closed = new Set(Array.from({ length: 51 }, (_, i) => `WOR-${5000 + i}`));
    const { call, laneStore } = await server(closed);
    fillTerminal(laneStore);

    const list = await call("wake_list");
    expect(list).toMatchObject({ pending: 0, cap: MAX_WAKES });
    expect(list.wakes).toHaveLength(51);
    expect(list.wakes[0]).toMatchObject({ task: "WOR-5000", counts: false });
    expect(list.wakes[0].due_local).toMatch(/^\w{3} \d{1,2} \w{3} \d{2}:\d{2} \(UTC\)$/);
  });

  it("still refuses the 51st wake when the 50 pending ones are on tasks that are open", async () => {
    const { call, laneStore } = await server(new Set());
    for (let i = 0; i < MAX_WAKES; i++) laneStore.addWake("aria", Date.now() + 3600_000, `check ${i}`, null, "WOR-5245");

    const refused = await call("wake_at", { when_local: "in 1 hour", note: "one too many", task: "WOR-5245" });
    expect(refused).toMatchObject({ ok: false, pending: MAX_WAKES });
    expect(refused.reason).toMatch(/pending wakes on open tasks/);
    expect(refused.wakes).toHaveLength(MAX_WAKES);
    expect(refused.wakes[0]).toMatchObject({ task: "WOR-5245" });
  });

  it("drops a wake that comes due on a finished task, and posts one for a task still open", async () => {
    const { laneStore } = await server(new Set(["WOR-5244"]));
    const now = Date.now();
    laneStore.addWake("aria", now - 2000, "superseded check", null, "WOR-5244");
    laneStore.addWake("aria", now - 1000, "the real check", null, "WOR-5245");
    const noticeOnTask = vi.fn(async () => {});

    await wakePass({ store: laneStore, lane: { tick: async () => {} } as unknown as Lane, agents: () => ({ aria }), taskIsClosed: async (t) => t === "WOR-5244", noticeOnTask, log: quiet });

    expect(noticeOnTask).toHaveBeenCalledTimes(1);
    expect(noticeOnTask).toHaveBeenCalledWith("WOR-5245", "[wake] the real check");
    expect(laneStore.pendingWakes("aria")).toEqual([]);
  });
});

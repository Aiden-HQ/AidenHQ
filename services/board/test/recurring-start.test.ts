import pino from "pino";
import { expect, it, vi } from "vitest";
import type { Paperclip } from "../src/paperclip.js";
import { recurringTick } from "../src/recurring-start.js";
import { Store } from "../src/store.js";

const log = pino({ level: "silent" });
const DEF = { id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "Weekly team update", description: "Repos: acme/api.", status: "todo", priority: "high", assigneeUserId: "user-1", assigneeAgentId: null, labels: [], labelIds: [] };

it("a due run gets its task on Today and the Researcher's routine, once; a failed start is handed out again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  try {
    const runs: { path: string; body: any }[] = [];
    let fail = true;
    const pc = {
      me: async () => "user-1",
      labels: async () => [{ id: "l-todo", name: "todo", color: "#000" }],
      issue: async () => DEF,
      addComment: vi.fn(async () => ({ id: "c" })),
      createIssue: async () => ({ ...DEF, id: "22222222-2222-2222-2222-222222222101", identifier: "PEN-101" }),
      routines: async () => [{ id: "rt-1", title: "Run recurring task", status: "active" }],
      request: async (_m: string, path: string, body: unknown) => {
        if (fail) throw new Error("Paperclip down");
        runs.push({ path, body });
        return {};
      },
    } as unknown as Paperclip;
    const store = new Store(":memory:");
    store.setRecurring(DEF.id, { cadence: { kind: "weekly", weekday: "monday", interval: 1 }, time: "07:00", anchor: "2026-10-01" }, ["acme/api"], new Date(Date.now() - 1000).toISOString());
    const deps = { pc, store, timezone: "Europe/Madrid", log };

    await recurringTick(deps);
    expect(runs).toEqual([]);
    fail = false;
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await recurringTick(deps);
    expect(runs).toEqual([
      { path: "/api/routines/rt-1/run", body: { source: "api", variables: expect.objectContaining({ definition: "PEN-1", task: "PEN-101", timezone: "Europe/Madrid", previous: "none (first run)" }) } },
    ]);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await recurringTick(deps);
    expect(runs).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

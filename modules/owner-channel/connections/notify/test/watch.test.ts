import { describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store.js";
import { tick, type Job } from "../src/watch.js";

const NOW = Date.parse("2026-11-09T08:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const job = (state: string, min: number, error?: string): Job => ({ agent: "A", task: "I", state, ended_at: at(min), error });
const api = async (p: string): Promise<any> => (p.startsWith("/api/agents/") ? { name: "Fleet Engineer" } : { identifier: "WOR-9" });

describe("watch", () => {
  it("repeated failed jobs alert once an hour; a successful job after it says recovered once", async () => {
    const store = openStore(":memory:");
    const notify = vi.fn(async (_text: string, _kind: "alert" | "done") => true);
    let recent = [job("failed", -2), job("timeout", -3), job("lost", -4), job("cancelled", -5)];
    const work = async () => ({ recent });
    await tick({ work, api, notify, store, now: NOW });
    await tick({ work, api, notify, store, now: NOW + 5 * 60_000 });
    expect(notify.mock.calls).toEqual([["⚠️ Agents are failing: 3 failed jobs in 15 minutes, e.g. Fleet Engineer/WOR-9", "alert"]]);
    recent = [job("done", 10), ...recent];
    await tick({ work, api, notify, store, now: NOW + 20 * 60_000 });
    await tick({ work, api, notify, store, now: NOW + 22 * 60_000 });
    expect(notify.mock.calls.map((c) => c[0]).slice(1)).toEqual(["✅ Agents recovered"]);
  });

});

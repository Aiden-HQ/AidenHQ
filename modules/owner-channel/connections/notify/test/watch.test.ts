import { describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store.js";
import { tick, type Job } from "../src/watch.js";

const NOW = Date.parse("2026-11-09T08:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const job = (state: string, min: number, error?: string): Job => ({ agent: "A", task: "I", state, ended_at: at(min), error });
const api = async (p: string): Promise<any> => (p.startsWith("/api/agents/") ? { name: "Fleet Engineer" } : { identifier: "WOR-9" });

describe("watch", () => {
  it("repeated failures and a later recovery send the owner nothing", async () => {
    const store = openStore(":memory:");
    const notify = vi.fn(async (_text: string, _kind: "alert" | "done") => true);
    let recent = [job("failed", -2), job("timeout", -3), job("lost", -4), job("cancelled", -5)];
    const work = async () => ({ recent });
    await tick({ work, api, notify, store, now: NOW });
    await tick({ work, api, notify, store, now: NOW + 5 * 60_000 });
    recent = [job("done", 10), ...recent];
    await tick({ work, api, notify, store, now: NOW + 20 * 60_000 });
    await tick({ work, api, notify, store, now: NOW + 22 * 60_000 });
    expect(notify.mock.calls).toEqual([]);
  });

  it("a 402 failure alerts once an hour", async () => {
    const store = openStore(":memory:");
    const notify = vi.fn(async (_text: string, _kind: "alert" | "done") => true);
    let recent = [job("failed", -1, "402 Payment Required: insufficient credits")];
    const work = async () => ({ recent });
    await tick({ work, api, notify, store, now: NOW });
    await tick({ work, api, notify, store, now: NOW + 5 * 60_000 });
    expect(notify.mock.calls).toEqual([
      ["⚠️ Agents are failing: out of OpenRouter credits (402) (1 failed jobs, e.g. Fleet Engineer/WOR-9)", "alert"],
    ]);
    recent = [job("failed", 60, "402 Payment Required: insufficient credits")];
    await tick({ work, api, notify, store, now: NOW + 61 * 60_000 });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

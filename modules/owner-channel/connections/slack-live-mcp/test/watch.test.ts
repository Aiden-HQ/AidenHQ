import { describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store.js";
import { tick } from "../src/watch.js";

const NOW = Date.parse("2026-11-09T08:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function world(over: { runs?: any[]; comments?: any[]; status?: string } = {}) {
  const w = { runs: over.runs ?? [], comments: over.comments ?? [], status: over.status ?? "in_review" };
  const api = async (p: string): Promise<any> => {
    if (p === "/api/companies") return [{ id: "C", name: "work", status: "active" }, { id: "P", name: "personal", status: "active" }];
    if (p.endsWith("/agents")) return [{ id: "A", name: "Fleet Engineer" }];
    if (p.includes("heartbeat-runs")) return w.runs;
    if (p.startsWith("/api/issues/I/comments")) return w.comments;
    if (p.startsWith("/api/issues/")) return { identifier: "WOR-9" };
    if (p.includes("/issues"))
      return [{ id: "I", identifier: "WOR-9", status: w.status, assigneeAgentId: "A", createdAt: ago(600), updatedAt: ago(1), description: "Delegated by Chief of Staff (agent) from WOR-1." }];
    throw new Error(p);
  };
  return { w, api };
}
const failedRun = (min: number, error = "unexpected status 402 Payment Required: Insufficient credits") => ({ id: `r${min}`, status: "failed", agentId: "A", issueId: "I", finishedAt: ago(min), error, errorCode: "adapter_failed" });

describe("watch", () => {
  it("alerts once per cause per hour, then once on recovery", async () => {
    const store = openStore(":memory:");
    const notify = vi.fn(async (_text: string) => true);
    const { w, api } = world({ runs: [failedRun(3), failedRun(4)] });
    await tick({ api, notify, store, now: NOW });
    await tick({ api, notify, store, now: NOW + 5 * 60_000 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("⚠️ Agents are failing: out of OpenRouter credits (402) (2 failed runs, e.g. Fleet Engineer/WOR-9)");
    await tick({ api, notify, store, now: NOW + 61 * 60_000 }); // failures aged out of the window, nothing new
    w.runs = [{ id: "ok", status: "succeeded", finishedAt: new Date(NOW + 62 * 60_000).toISOString() }];
    await tick({ api, notify, store, now: NOW + 63 * 60_000 });
    await tick({ api, notify, store, now: NOW + 65 * 60_000 });
    expect(notify.mock.calls.map((c) => c[0]).slice(1)).toEqual(["✅ Agents recovered"]);
  });

  it("pages about an app only after 30 minutes or 3 incidents in a day, then says it recovered", async () => {
    const store = openStore(":memory:");
    const notify = vi.fn(async (_text: string) => true);
    const { api } = world();
    let incident: { opened_at: number; kind: string; detail: string } | undefined = { opened_at: NOW - 5 * 60_000, kind: "unhealthy", detail: "health check failing" };
    const apps = async () => [{ name: "demo", incident }];
    await tick({ api, notify, store, apps, now: NOW });
    expect(notify).not.toHaveBeenCalled();
    await tick({ api, notify, store, apps, now: NOW + 30 * 60_000 });
    expect(notify).toHaveBeenCalledWith("⚠️ DevOps Engineer couldn't fix demo: health check failing");
    incident = undefined;
    await tick({ api, notify, store, apps, now: NOW + 40 * 60_000 });
    expect(notify).toHaveBeenLastCalledWith("✅ demo recovered");
  });
});

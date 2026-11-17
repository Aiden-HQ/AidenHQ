import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { descendants, featureCost, recentFeatures, unattributed } from "../src/feature-cost.js";
import type { Issue, Paperclip } from "../src/paperclip.js";
import { Store, type RunUsage } from "../src/store.js";
import { card, fakeRecords } from "./fake-records.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const task = (n: number, parentId: string | null, o: Partial<Issue> = {}): Issue => ({
  id: `id-${n}`, identifier: `WOR-${n}`, title: `Task ${n}`, description: "", status: "done", priority: "medium", assigneeUserId: null, assigneeAgentId: "eng", assigneeAdapterOverrides: null,
  createdAt: "2026-11-16T10:00:00.000Z", updatedAt: "2026-11-16T12:00:00.000Z", completedAt: "2026-11-16T12:00:00.000Z", parentId, ...o,
});
// Feature 1: root, two children, one grandchild. Feature 2 is still open. WOR-9 is a top-level task with nothing delegated.
const root = task(1, null);
const pool = [root, task(2, "id-1", { completedAt: "2026-11-16T14:00:00.000Z" }), task(3, "id-1"), task(4, "id-2", { completedAt: "2026-11-16T16:00:00.000Z" }), task(5, null, { status: "in_progress", completedAt: null, createdAt: "2026-11-17T08:00:00.000Z" }), task(6, "id-5", { status: "in_progress", completedAt: null }), task(9, null)];
const run = (issueId: string | null, run: string, usd: number, o: Partial<RunUsage> = {}): RunUsage => ({ issueId, run, engineer: 0, calls: 2, usd, first: "2026-11-16T10:30:00.000Z", last: "2026-11-16T10:40:00.000Z", ...o });
const usage = [
  run("id-1", "r1", 0.5),
  run("WOR-2", "r2", 0.25), // an identifier, as some records carry
  run("id-4", "r3", 1, { engineer: 1, first: "2026-11-16T15:00:00.000Z", last: "2026-11-16T15:30:00.000Z" }),
  run("id-4", "r4", 0.5, { engineer: 1, first: "2026-11-16T15:40:00.000Z", last: "2026-11-16T15:50:00.000Z" }),
  run("id-6", "r5", 3),
  run(null, "r6", 7), // names no task
  run("id-9", "r7", 99),
];
const merge = (id: string, o = {}) => card({ id: `A-${id}`, issueId: id, identifier: id, action: "merge", outcome: "applied", state: "used", usedAt: "2026-11-16T17:00:00.000Z", ...o });
const approvals = [merge("id-4"), merge("WOR-3", { usedAt: "2026-11-16T18:00:00.000Z" }), merge("id-4", { id: "A-failed", outcome: "failed" }), merge("id-6")];

describe("feature cost roll-up", () => {
  it("sums a nested tree: spend, jobs and their time, merges, and elapsed to the last merge, never guessing a call with no task", async () => {
    const { tasks } = await descendants(root, async (id) => pool.filter((i) => i.parentId === id));
    expect(tasks.map((t) => t.identifier)).toEqual(["WOR-2", "WOR-3", "WOR-4"]);
    expect(featureCost(root, tasks, usage, approvals, NOW)).toMatchObject({ identifier: "WOR-1", tasks: 4, usd: 2.25, calls: 8, jobs: 2, jobMs: 40 * 60_000, prs: 2, running: false, elapsedMs: 8 * 36e5 });
    expect(unattributed(usage)).toEqual({ usd: 7, calls: 2 });
  });

  it("lists the window's top-level tasks that have delegated work; an open one runs to now", async () => {
    const r = await recentFeatures([...pool, task(7, null, { createdAt: "2026-10-01T00:00:00.000Z" }), task(8, "id-7", { createdAt: "2026-10-01T00:00:00.000Z" })], usage, approvals, NOW);
    expect(r.features.map((f) => [f.identifier, f.usd, f.running])).toEqual([["WOR-5", 3, true], ["WOR-1", 2.25, false]]);
    expect(r.features[0]!.elapsedMs).toBe(4 * 36e5);
    expect(r.unattributed.usd).toBe(7);
  });
});

describe("feature cost in the board", () => {
  const store = new Store(":memory:");
  const at = new Date().toISOString();
  store.addUsage({ key: "u1", at, component: "agent", model: "m", input: 1, cached: 0, output: 1, costUsd: 0.4, issueId: "id-1" });
  store.addUsage({ key: "u2", at, component: "Engineer jobs", model: "m", input: 1, cached: 0, output: 1, costUsd: 0.6, issueId: "id-2", runKey: "job-a" });
  store.addUsage({ key: "u3", at, component: "agent", model: "m", input: 1, cached: 0, output: 1, costUsd: 5 });
  const pc = {
    me: async () => "me-1", agents: async () => [{ id: "eng", name: "Engineer", status: "idle", adapterType: "codex_local", adapterConfig: {} }], labels: async () => [], company: async () => ({ issuePrefix: "WOR" }),
    openIssues: async () => [], closedSince: async () => [root, task(2, "id-1")], liveRuns: async () => [], recentRuns: async () => [],
    issue: async (ref: string) => [root, task(2, "id-1")].find((i) => i.id === ref || i.identifier === ref) ?? Promise.reject(new Error("404")),
    children: async (id: string) => (id === "id-1" ? [task(2, "id-1")] : []),
  } as unknown as Paperclip;
  let app: ReturnType<typeof createApp>;
  let port = 0;
  beforeAll(async () => {
    app = createApp({ paperclip: pc, store, records: fakeRecords([merge("id-2")]), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const get = (path: string) =>
    new Promise<any>((resolve, reject) => {
      request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: "localhost:3120", "x-aidenhq-board": "1" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode} ${text}`))));
      }).end();
    });

  it("serves a task's strip (null without children) and the sortable 14-day list with the unattributed spend", async () => {
    expect((await get("/api/issues/WOR-1/feature-cost")).cost).toMatchObject({ identifier: "WOR-1", tasks: 2, usd: 1, jobs: 1, prs: 1 });
    expect((await get("/api/issues/WOR-2/feature-cost")).cost).toBeNull();
    const l = await get("/api/costs/features");
    expect(l.features).toMatchObject([{ identifier: "WOR-1", usd: 1 }]);
    expect(l.unattributed).toEqual({ usd: 5, calls: 1 });
  });
});

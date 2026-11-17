import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const agents = [
  { id: "keeper", name: "Roadmap Keeper", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:roadmap-keeper", module: "instance" } },
  { id: "gone", name: "Old Agent", status: "terminated", adapterType: "codex_local", metadata: { setupKey: "aidenhq:old-agent", module: "instance" } },
];
const issue = (n: number, o: Record<string, unknown> = {}) => ({
  id: `i${n}`, identifier: `WOR-${n}`, title: `Task ${n}`, description: null, status: "in_progress", priority: "medium",
  assigneeUserId: null, assigneeAgentId: "keeper", assigneeAdapterOverrides: null, createdAt: "2026-11-01T00:00:00Z",
  updatedAt: `2026-11-01T00:00:${String(n % 60).padStart(2, "0")}Z`, ...o,
});
// 35 finished tasks, WOR-1 the oldest.
const closed = Array.from({ length: 35 }, (_, k) => issue(k + 1, { status: "done", updatedAt: new Date(Date.UTC(2026, 10, 1, 0, k)).toISOString() }));
const pc = {
  me: async () => "owner-user",
  company: async () => ({ issuePrefix: "WOR" }),
  agents: async () => agents,
  routines: async () => [],
  labels: async () => [{ id: "chat-label", name: "chat", color: "#0ea5e9" }],
  openIssues: async () => [
    issue(100), // its last run failed: needs the owner
    issue(101),
    issue(102, { labelIds: ["chat-label"] }),
    issue(103, { assigneeAgentId: "someone-else" }),
  ],
  closedFor: async () => [...closed].reverse(),
  liveRuns: async () => [],
  recentRuns: async () => [{ id: "r1", status: "failed", agentId: "keeper", issueId: "i100", startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:01:00Z", error: "boom" }],
  lastRuns: async () => new Map(),
} as unknown as Paperclip;

describe("agent page routes", () => {
  const app = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const get = (path: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: "localhost:3120" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      req.end();
    });

  it("returns the profile by key", async () => {
    const { status, body } = await get("/api/agents/by-key/roadmap-keeper");
    expect(status).toBe(200);
    expect(body.profile.name).toBe("Roadmap Keeper");
    expect(body.profile.source).toBeNull();
  });

  it("404s an unknown or terminated agent", async () => {
    for (const key of ["nobody", "old-agent"]) {
      const r = await get(`/api/agents/by-key/${key}`);
      expect([r.status, r.body]).toEqual([404, { error: "no such agent" }]);
      expect((await get(`/api/agents/by-key/${key}/tasks?view=open`)).status).toBe(404);
    }
  });

  it("splits open tasks and leaves chats and other agents' tasks out", async () => {
    const { body } = await get("/api/agents/by-key/roadmap-keeper/tasks?view=open");
    expect(body.needs.map((r: any) => r.identifier)).toEqual(["WOR-100"]);
    expect(body.ongoing.map((r: any) => r.identifier)).toEqual(["WOR-101"]);
  });

  it("pages history, newest first, and searches", async () => {
    const first = (await get("/api/agents/by-key/roadmap-keeper/tasks?view=history")).body;
    expect(first.rows).toHaveLength(30);
    expect(first.rows[0].identifier).toBe("WOR-35");
    expect(first.next).toBe(first.rows[29].updatedAt);
    const second = (await get(`/api/agents/by-key/roadmap-keeper/tasks?view=history&before=${encodeURIComponent(first.next)}`)).body;
    expect(second.rows.map((r: any) => r.identifier)).toEqual(["WOR-5", "WOR-4", "WOR-3", "WOR-2", "WOR-1"]);
    expect(second.next).toBeNull();
    const found = (await get("/api/agents/by-key/roadmap-keeper/tasks?view=history&q=wor-7")).body;
    expect(found.rows.map((r: any) => r.identifier)).toEqual(["WOR-7"]);
  });
});

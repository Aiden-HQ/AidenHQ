import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const agents = [
  { id: "cos", name: "Aiden", status: "error", metadata: { engine: "codex", setupKey: "aidenhq:chief-of-staff", module: "core", department: { id: "leadership", name: "Leadership", order: 0 } } },
  { id: "keeper", name: "Roadmap Keeper", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:roadmap-keeper", module: "instance" } },
  { id: "napper", name: "Napper", status: "paused", metadata: { engine: "codex", setupKey: "aidenhq:napper", module: "instance" } },
  { id: "gone", name: "Slack Scout", status: "terminated", metadata: { engine: "codex", setupKey: "aidenhq:slack-scout", module: "core" } },
];
const pc = {
  agents: async () => agents,
  routines: async () => [{ id: "r1", title: "Prepare daily brief", status: "active", assigneeAgentId: "cos", triggers: [{ kind: "schedule", enabled: true, nextRunAt: "2026-11-14T04:45:00Z" }] }],
  // The roster route never touches run history (the slow part): these fail the test if called.
  lastRuns: async () => Promise.reject(new Error("roster read run history")),
  recentRuns: async () => Promise.reject(new Error("roster read run history")),
} as unknown as Paperclip;

describe("GET /api/agents/roster", () => {
  let signedIn = true;
  // Paperclip never runs agents: its status is a leftover. The kernel's jobs say Aiden is working, Roadmap Keeper failed its last 3 and Napper is paused.
  const work = { job: async () => null, task: async () => [], activity: async () => ({ running: [{ agent: "cos", started_at: "2026-11-14T04:00:00Z" }], queued: [], failing: [{ agent: "keeper", error: "The job failed: boom" }] }) };
  const app = createApp({ paperclip: pc, work, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => (signedIn ? { accountId: "owner", role: "admin" as const } : null) });
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

  it("lists the fleet with departments, portraits keys and schedules, without run history", async () => {
    signedIn = true;
    const { status, body } = await get("/api/agents/roster");
    expect(status).toBe(200);
    expect(body.roster.map((a: any) => [a.name, a.system, a.department.id, a.key])).toEqual([
      ["Aiden", true, "leadership", "chief-of-staff"],
      ["Roadmap Keeper", false, "general", "roadmap-keeper"],
      ["Napper", false, "general", "napper"],
    ]);
    expect(body.roster.map((a: any) => [a.state, a.stateNote])).toEqual([["working", undefined], ["failing", "The job failed: boom"], ["paused", undefined]]);
    expect(body.roster[0].schedules).toEqual([{ title: "Prepare daily brief", paused: false, nextRunAt: "2026-11-14T04:45:00Z" }]);
    expect(body.roster[0].lastRunAt).toBeNull();
  });

  it("needs a signed-in admin", async () => {
    signedIn = false;
    expect((await get("/api/agents/roster")).status).toBe(401);
  });
});

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
  me: async () => "owner",
  labels: async () => [],
  company: async () => ({ issuePrefix: "WOR" }),
  issueSummary: async (id: string) => ({ id, identifier: "WOR-7", title: "Write the brief", description: null, originKind: "manual" }),
  // Paperclip's heartbeat runs are dead (the kernel is the only job ledger): any read of them fails the test.
  request: async (_method: string, path: string) => {
    requests.push(path);
    throw new Error(`unexpected Paperclip read: ${path}`);
  },
} as unknown as Paperclip;
const requests: string[] = [];

describe("GET /api/agents/roster", () => {
  let signedIn = true;
  // Paperclip never runs agents: its status is a leftover. The kernel's jobs say Aiden is working, Roadmap Keeper failed its last 3 and Napper is paused.
  const work = { job: async () => null, task: async () => [], activity: async () => ({
    running: [{ id: "j1", agent: "cos", task: "t7", state: "running", started_at: "2026-11-14T04:00:00Z", ended_at: null }],
    recent: [{ id: "j0", agent: "keeper", task: "t8", state: "failed", started_at: "2026-11-14T03:00:00Z", ended_at: new Date().toISOString(), error: "The job failed: boom" }],
    queued: [],
    failing: [{ agent: "keeper", error: "The job failed: boom" }],
  }) };
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

  it("shows a running kernel job in Now and a just-ended one as the last run, reading no Paperclip run", async () => {
    signedIn = true;
    const { body } = await get("/api/agents");
    expect(body.sessions.map((s: any) => [s.agentId, s.state, s.startedAt, s.run.identifier])).toEqual([["cos", "working", "2026-11-14T04:00:00Z", "WOR-7"]]);
    expect(body.finished.map((f: any) => [f.agentId, f.status, f.detail])).toEqual([["keeper", "failed", "The job failed: boom"]]);
    expect(body.roster.map((a: any) => [a.name, a.lastRunAt, a.lastRunStatus])).toEqual([["Aiden", "2026-11-14T04:00:00Z", "running"], ["Roadmap Keeper", "2026-11-14T03:00:00Z", "failed"], ["Napper", null, null]]);
    expect(requests).toEqual([]);
  });

  it("needs a signed-in admin", async () => {
    signedIn = false;
    expect((await get("/api/agents/roster")).status).toBe(401);
  });
});

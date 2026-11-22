import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const calls: string[] = [];
const pc = {
  agents: async () => [{ id: "keeper", name: "Roadmap Keeper", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:roadmap-keeper", module: "roadmap-keeper", tier: "local" } }],
  pauseAgent: async (id: string) => void calls.push(`pause ${id}`),
  resumeAgent: async (id: string) => void calls.push(`resume ${id}`),
} as unknown as Paperclip;

describe("POST /api/agents/by-key/:key/pause", () => {
  let role: "admin" | "member" | null = "admin";
  const work = { job: async () => null, task: async () => [], agent: async () => [], activity: async () => ({ running: [], recent: [], queued: [], parked: [], failing: [] }), stop: async (what: object, account: string) => (calls.push(`stop ${JSON.stringify(what)} by ${account}`), []) };
  const app = createApp({ work, paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => (role ? { accountId: "owner", role: role as "admin" } : null) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const post = (path: string, body: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3120" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  it("pauses and resumes", async () => {
    calls.length = 0;
    expect((await post("/api/agents/by-key/roadmap-keeper/pause", { paused: true })).body).toEqual({ status: "paused" });
    expect((await post("/api/agents/by-key/roadmap-keeper/pause", { paused: false })).body.status).toBe("idle");
    expect(calls).toEqual(["pause keeper", "resume keeper"]);
    expect((await post("/api/agents/by-key/nobody/pause", { paused: true })).status).toBe(404);
  });

  it("pausing with stop also stops its running jobs, as the signed-in admin", async () => {
    calls.length = 0;
    await post("/api/agents/by-key/roadmap-keeper/pause", { paused: true, stop: true });
    expect(calls).toEqual(["pause keeper", 'stop {"agent":"keeper"} by owner']);
  });

  it("refuses a signed-out or non-admin caller", async () => {
    calls.length = 0;
    role = null;
    expect((await post("/api/agents/by-key/roadmap-keeper/pause", { paused: true })).status).toBe(401);
    role = "member";
    expect((await post("/api/agents/by-key/roadmap-keeper/pause", { paused: true })).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

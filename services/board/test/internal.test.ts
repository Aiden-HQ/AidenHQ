import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// The grants table setup writes: the Research Assistant may change the board; the Scout holds the tool but not the role.
const grantsFile = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
writeFileSync(grantsFile, JSON.stringify({ agents: { ra: { key: "assistant", roles: ["board-writer", "fleet-read"], tools: { paperclip_tasks: ["task_schedule"] } }, scout: { key: "scout", roles: [], tools: { paperclip_tasks: ["task_schedule"] } } } }));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

describe("internal listener", () => {
  const TOKEN = "t".repeat(64);
  const store = new Store(":memory:");
  const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "T", description: "", status: "todo", priority: "medium", assigneeUserId: "me-1", assigneeAgentId: null, assigneeAdapterOverrides: null, createdAt: "", updatedAt: "" };
  const pc = {
    me: async () => "me-1",
    agents: async () => [],
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async () => issue,
    companyId: "co",
    // An agent's own credential: here, its id.
    agentMe: async (key: string) => (["ra", "scout"].includes(key) ? { id: key, name: key, companyId: "co" } : Promise.reject(new Error("401"))),
  } as unknown as Paperclip;
  const app = createApp({ paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  // fetch() always sends its own Host header; the guard is tested with the names the bridge uses.
  const call = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  afterAll(() => app.close());

  // The tasks bridge: the internal token plus the calling agent's own credential.
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call("POST", path, body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-agent-key": "ra", ...headers });


  it("needs the token and an allowed host", async () => {
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { authorization: "" })).status).toBe(401);
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { host: "evil:3122" })).status).toBe(403);
  });

  it("the token alone changes nothing: the caller must be an agent granted the tool and the board-writer role, or the runner", async () => {
    const refused = async (path: string, body: unknown, headers: Record<string, string>) => (await (await post(path, body, headers)).json()) as { error: string };
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, { "x-agent-key": "" })).error).toBe("missing agent credential");
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, { "x-agent-key": "forged" })).error).toMatch(/^only an agent granted task_schedule/);
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, { "x-agent-key": "scout" })).error).toMatch(/with the board-writer role/);
    expect((await refused("/internal/issues/PEN-1/recurring", { action: "stop" }, {})).error).toMatch(/^only an agent granted task_recurring/); // not granted
    expect((await refused("/internal/recurring/claim", {}, {})).error).toBe("only the runner claims recurring runs");
    expect((await refused("/internal/runner/activity", {}, {})).error).toBe("only the runner reports its jobs");
  });

  it("serves only /internal/ routes: not the user's API or the page", async () => {
    expect((await post("/api/issues", { title: "x" })).status).toBe(404);
    expect((await call("GET", "/", undefined, { host: "board:3122", authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it("fleet_status answers with detector.open and detector.recovered readable, even behind long lists", async () => {
    const big = "t".repeat(200);
    const row = (k: number) => ({ id: `i${k}`, identifier: `PEN-${k}`, title: big, status: "blocked", priority: "medium", assigneeUserId: null, assigneeAgentId: "a1", assigneeAdapterOverrides: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
    store.setMeta("fleet_ops_detector", JSON.stringify({
      open: { "routine:daily-brief": { reason: "routine daily brief: its last 3 runs failed", at: "2026-11-13T10:00:00Z", fired: true } },
      recovered: [{ key: "source:slack", reason: "source src_slack: last good pass 20 min ago", at: "2026-11-13T11:00:00Z", fired: true }],
    }));
    (pc as any).request = async (m: string, path: string) => (path.includes("/issues?") ? Array.from({ length: 500 }, (_, k) => row(k)) : []);
    // The summary's own reads (a failed one is allowed to be null, but it must not outlive the stub above).
    (pc as any).closedSince = async () => [];
    (pc as any).recentRuns = async () => [];
    try {
      // The body as it goes over the wire, not the object a caller happened to build.
      const res = await post("/internal/fleet/status", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { detector: unknown; truncated?: string[] } & Record<string, unknown>;
      const text = JSON.stringify(body);
      expect(text.length).toBeLessThanOrEqual(24_000);
      expect(body.detector).toEqual({
        open: { "routine:daily-brief": { reason: "routine daily brief: its last 3 runs failed", at: "2026-11-13T10:00:00Z", fired: true } },
        recovered: [{ key: "source:slack", reason: "source src_slack: last good pass 20 min ago", at: "2026-11-13T11:00:00Z", fired: true }],
      });
      expect(Object.keys(body)[0]).toBe("detector");
      expect(body.truncated?.some((t) => /^(stuck|agents): \d+ of 500$/.test(t))).toBe(true);
    } finally {
      delete (pc as any).request;
      delete (pc as any).closedSince;
      delete (pc as any).recentRuns;
      store.delMeta("fleet_ops_detector");
    }
  });

  it("schedules a move on the user's task, and rejects bad dates", async () => {
    const ok = await post("/internal/issues/PEN-1/schedule", { date: "2099-01-01" });
    expect(ok.status).toBe(400);
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await post("/internal/issues/PEN-1/schedule", { date });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identifier: "PEN-1", scheduled: { date, bucket: "today", position: "top" } });
    expect(store.schedules().get(issue.id)?.date).toBe(date);
  });
});

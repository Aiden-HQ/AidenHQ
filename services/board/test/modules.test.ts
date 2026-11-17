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
import { moduleStates } from "../src/modules.js";

describe("moduleStates", () => {
  it("tells core, chosen, dependency and off apart", () => {
    const e = (name: string, enabled: boolean, chosen = false) => ({ name, description: "", enabled, chosen, requires: [], agents: [] });
    const rows = moduleStates(JSON.stringify([e("kernel", true), e("jira", true, true), e("fleet-ops", true), e("design", false)]));
    expect(rows.map((r) => r.state)).toEqual(["core", "on", "dependency", "off"]);
    const remote = moduleStates(JSON.stringify([{ ...e("twin", true, true), marketplace: "acme", tier: "conformant" }]))[0];
    expect([rows[0]!.marketplace, rows[0]!.tier, remote!.marketplace, remote!.tier]).toEqual(["aidenhq", "official", "acme", "conformant"]);
  });
});

describe("GET /api/modules/:name", () => {
  const dir = mkdtempSync(join(tmpdir(), "mods-"));
  const file = join(dir, "modules.json");
  const e = (name: string, extra: object = {}) => ({ name, description: `${name} module`, enabled: true, chosen: true, requires: [], agents: [], ...extra });
  writeFileSync(file, JSON.stringify([e("kernel"), e("jira", { agents: ["tracker"], requires: ["core"], connections: ["jira-mcp"], pinned: "a".repeat(40) }), e("core", { chosen: false }), e("design", { enabled: false, chosen: false })]));
  process.env.BOARD_MODULES_FILE = file;
  const agents = [{ id: "a1", name: "Tracker", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:tracker", module: "jira" } }];
  const pc = { agents: async () => agents, routines: async () => [], openIssues: async () => [{ id: "i1", identifier: "WOR-1", title: "Sync", status: "in_progress", assigneeAgentId: "a1", updatedAt: "2026-11-17T00:00:00Z", labels: [] }], liveRuns: async () => [], recentRuns: async () => [], labels: async () => [], me: async () => "u", company: async () => ({ issuePrefix: "WOR" }) } as unknown as Paperclip;
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

  it("a module with agents: its profiles, ongoing work, pin and what needs it", async () => {
    const { status, body } = await get("/api/modules/jira");
    expect(status).toBe(200);
    expect(body.module.pinned).toBe("aaaaaaa");
    expect(body.agents.map((a: any) => a.key)).toEqual(["tracker"]);
    expect(body.ongoing.map((t: any) => t.identifier)).toEqual(["WOR-1"]);
    expect(body.authority.connections).toEqual(["jira-mcp"]);
    expect(body.requires).toEqual(["core"]);
    expect((await get("/api/modules/core")).body.neededBy).toEqual(["jira"]);
  });

  it("a module with none, and an unknown name", async () => {
    const none = (await get("/api/modules/design")).body;
    expect([none.agents, none.ongoing]).toEqual([[], []]);
    expect((await get("/api/modules/nope")).status).toBe(404);
  });
});

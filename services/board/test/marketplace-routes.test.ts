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

const dir = mkdtempSync(join(tmpdir(), "mkt-"));
writeFileSync(join(dir, "modules.json"), JSON.stringify([
  { name: "kernel", description: "The kernel", enabled: true },
  { name: "channel-acme", description: "Chat on Acme", enabled: false, agents: [], connections: ["acme"], marketplace: "aidenhq", tier: "official", setup_flow: { title: "Acme token" } },
  { name: "notes", description: "Keeps notes", enabled: true, agents: ["scribe"], connections: [], apps: ["notes-app"], marketplace: "acme-agents", tier: "declared", revision: "a".repeat(40), source: { url: "https://github.com/acme/agents.git" } },
]));
writeFileSync(join(dir, "paperclip.yaml"), [
  "mcp_servers:",
  "  acme: { url: http://acme, tools: { read: [list], write: [post], destructive: [wipe] } }",
  "agents:",
  "  scribe: { module: notes, enabled_tools: { acme: [list, post] } }",
].join("\n"));
process.env.BOARD_MODULES_FILE = join(dir, "modules.json");
process.env.BOARD_PAPERCLIP_CONFIG = join(dir, "paperclip.yaml");

describe("browse, marketplaces and grants routes", () => {
  const app = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
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

  it("browse filters by q and kind and names what a module adds", async () => {
    expect((await get("/api/modules/browse")).body.modules.map((m: any) => m.name)).toEqual(["channel-acme", "notes"]);
    expect((await get("/api/modules/browse?q=chat")).body.modules.map((m: any) => m.name)).toEqual(["channel-acme"]);
    const apps = (await get("/api/modules/browse?kind=apps")).body.modules;
    expect(apps.map((m: any) => [m.name, m.installed, m.adds[0]])).toEqual([["notes", true, "1 agent: scribe"]]);
    expect((await get("/api/modules/browse?kind=channels")).body.modules[0].setupFlow).toEqual({ title: "Acme token" });
  });

  it("lists marketplaces with pinned sha and module count", async () => {
    const { marketplaces } = (await get("/api/marketplaces")).body;
    expect(marketplaces.find((m: any) => m.name === "acme-agents")).toEqual({ name: "acme-agents", source: "https://github.com/acme/agents.git", sha: "a".repeat(40), modules: 1, newer: false });
  });

  it("an agent's grants carry each tool's class", async () => {
    const { status, body } = await get("/api/agents/by-key/scribe/grants");
    expect(status).toBe(200);
    expect(body.connections).toEqual([{ id: "acme", module: "channel-acme", tools: [{ name: "list", class: "read", granted: true, default: true }, { name: "post", class: "write", granted: true, default: true }, { name: "wipe", class: "destructive", granted: false, default: false }] }]);
    expect((await get("/api/agents/by-key/nobody/grants")).status).toBe(404);
  });
});

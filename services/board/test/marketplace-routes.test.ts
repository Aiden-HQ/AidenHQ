import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createResolver } from "../src/marketplace.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "mkt-"));
writeFileSync(join(dir, "modules.json"), JSON.stringify([
  { name: "kernel", description: "The kernel", enabled: true, requires: [], agents: [] },
  { name: "channel-acme", description: "Chat on Acme", enabled: false, requires: [], agents: [], connections: ["acme"], marketplace: "aidenhq", tier: "official", setup_flow: { title: "Acme token" } },
  { name: "notes", description: "Keeps notes", enabled: true, requires: [], agents: ["scribe"], connections: [], apps: ["notes-app"], marketplace: "acme-agents", tier: "declared", revision: "a".repeat(40), source: { url: "https://github.com/acme/agents.git" } },
]));
writeFileSync(join(dir, "paperclip.yaml"), [
  "mcp_servers:",
  "  acme: { url: http://acme, tools: { read: [list], write: [post], destructive: [wipe] } }",
  "agents:",
  "  scribe: { module: notes, enabled_tools: { acme: [list, post] } }",
].join("\n"));
process.env.BOARD_MODULES_FILE = join(dir, "modules.json");
process.env.BOARD_PAPERCLIP_CONFIG = join(dir, "paperclip.yaml");

const asked: string[] = [];
const fakeGithub = async (url: string) => {
  asked.push(url);
  if (url.includes("/repos/acme/private/")) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => [{ sha: "b".repeat(40), commit: { committer: { date: "2026-11-01T00:00:00Z" } } }] };
};

describe("browse, marketplaces and grants routes", () => {
  const app = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", fetch: fakeGithub as unknown as typeof fetch, session: () => ({ accountId: "owner", role: "admin" as const }) });
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

  it("browse is not taken for a module's own page, and that page is still reached", async () => {
    expect((await get("/api/modules/browse")).body.modules).toBeDefined();
    const missing = await get("/api/modules/nope");
    expect([missing.status, missing.body.error]).toEqual([404, "no such module"]);
  });

  it("lists marketplaces with pinned sha and module count", async () => {
    const { marketplaces } = (await get("/api/marketplaces")).body;
    expect(marketplaces.find((m: any) => m.name === "acme-agents")).toEqual({ name: "acme-agents", source: "https://github.com/acme/agents.git", sha: "a".repeat(40), modules: 1, newer: true, latest: { sha: "b".repeat(40), date: "2026-11-01T00:00:00Z" } });
  });

  it("an agent's grants carry each tool's class", async () => {
    const { status, body } = await get("/api/agents/by-key/scribe/grants");
    expect(status).toBe(200);
    expect(body.connections).toEqual([{ id: "acme", module: "channel-acme", tools: [{ name: "list", class: "read", granted: true, default: true }, { name: "post", class: "write", granted: true, default: true }, { name: "wipe", class: "destructive", granted: false, default: false }] }]);
    expect((await get("/api/agents/by-key/nobody/grants")).status).toBe(404);
  });

  it("resolve gives the commit to pin, or says the repository can't be read", async () => {
    const post = (repo: string) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/marketplaces/resolve", headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1" } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ repo }));
      });
    expect(await post("acme/agents")).toEqual({ status: 200, body: { sha: "b".repeat(40), date: "2026-11-01T00:00:00Z" } });
    expect((await post("acme/private")).status).toBe(422);
  });
});

it("the resolver asks for commits until seven days ago, and caches", async () => {
  const urls: string[] = [];
  const now = Date.parse("2026-11-17T12:00:00Z");
  const resolve = createResolver((async (u: string) => (urls.push(u), { ok: true, json: async () => [{ sha: "c".repeat(40), commit: { author: { date: "2026-11-09T00:00:00Z" } } }] })) as unknown as typeof fetch, () => now);
  expect(await resolve("acme/x")).toEqual({ sha: "c".repeat(40), date: "2026-11-09T00:00:00Z" });
  await resolve("acme/x");
  expect(urls).toEqual([`https://api.github.com/repos/acme/x/commits?until=${encodeURIComponent("2026-11-10T12:00:00Z")}&per_page=1`]);
});

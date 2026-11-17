import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handbook, history } from "../src/agent-handbook.js";

const sha = (t: string) => createHash("sha1").update(`blob ${Buffer.byteLength(t)}\0${t}`).digest("hex");
function dirs(moduleText: string, files: Record<string, string>, fork?: string) {
  const root = mkdtempSync(join(tmpdir(), "hb-"));
  const modules = join(root, "modules");
  const instance = join(root, "instance");
  mkdirSync(join(modules, "ops", "agents", "scout"), { recursive: true });
  writeFileSync(join(modules, "ops", "agents", "scout", "AGENTS.md"), moduleText);
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(instance, f, ".."), { recursive: true });
    writeFileSync(join(instance, f), t);
  }
  mkdirSync(instance, { recursive: true });
  writeFileSync(join(instance, "instance.yaml"), fork ? `overrides:\n  agents:\n    scout:\n      handbook_fork: ${fork}\n` : "modules: []\n");
  return { modules, instance };
}

describe("handbook", () => {
  const upstream = "---\nname: scout\n---\nBe brief.\n";
  it("module agent: the module's text, the owner's rules, no fork", () => {
    const h = handbook({ key: "scout", module: "ops", revision: "abc1234", compiled: "x", dirs: dirs(upstream, { "agents/scout.md": "Reply in French." }) });
    expect(h).toMatchObject({ kind: "module", main: { text: "Be brief.", source: "module", module: "ops", revision: "abc1234" }, rules: "Reply in French.", fork: null });
  });
  it("forked: the fork's text, and whether the module moved on", () => {
    const d = dirs(upstream, { "agents/scout/AGENTS.md": "My copy." }, sha(upstream));
    expect(handbook({ key: "scout", module: "ops", compiled: null, dirs: d }).fork).toEqual({ base: sha(upstream), moduleMovedOn: false });
    const moved = dirs(upstream + "More.\n", { "agents/scout/AGENTS.md": "My copy." }, sha(upstream));
    const h = handbook({ key: "scout", module: "ops", compiled: null, dirs: moved });
    expect(h.main).toMatchObject({ text: "My copy.", source: "fork" });
    expect(h.fork).toMatchObject({ moduleMovedOn: true, moduleText: "Be brief.\nMore." });
  });
  it("instance agent: its own file is the whole handbook", () => {
    const h = handbook({ key: "scout", module: "instance", compiled: null, dirs: dirs(upstream, { "agents/scout/AGENTS.md": "Mine." }) });
    expect(h).toMatchObject({ kind: "instance", main: { text: "Mine.", source: "instance" }, rules: "Mine.", fork: null });
  });
  it("without mounts: splits the compiled text at Instance rules", () => {
    const h = handbook({ key: "scout", module: "ops", compiled: "Be brief.\n\n## Instance rules\n\nFrench.\n", dirs: {} });
    expect(h).toMatchObject({ main: { text: "Be brief." }, rules: "French." });
  });
  it("history says why it is empty when the repo isn't readable", async () => {
    expect((await history("scout", undefined)).rows).toEqual([]);
  });
});

import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

describe("handbook routes", () => {
  const d = dirs("---\nx: y\n---\nBe brief.\n", { "agents/scout.md": "French." });
  Object.assign(process.env, { BOARD_MODULES_DIR: d.modules, BOARD_INSTANCE_DIR: d.instance });
  const pc = {
    me: async () => "owner",
    company: async () => ({ issuePrefix: "WOR" }),
    agents: async () => [{ id: "a1", name: "Scout", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:scout", module: "ops" } }],
    routines: async () => [],
    request: async () => ({ content: "Be brief.\n\n## Instance rules\n\nFrench.\n" }),
  } as unknown as Paperclip;
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

  it("serves the handbook and 404s an unknown agent", async () => {
    const r = await get("/api/agents/by-key/scout/handbook");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "module", main: { text: "Be brief.", source: "module" }, rules: "French." });
    expect(r.body.compiled).toContain("## Instance rules");
    expect((await get("/api/agents/by-key/nobody/handbook")).status).toBe(404);
    expect((await get("/api/agents/by-key/nobody/handbook/history")).status).toBe(404);
    expect((await get("/api/agents/by-key/scout/handbook/history")).body.rows).toEqual([]);
  });
});

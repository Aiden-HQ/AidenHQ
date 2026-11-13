import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// The compiled config as scripts/modules.mjs writes it (paperclip.yaml, modules.json) and the grants table setup writes.
const dir = mkdtempSync(join(tmpdir(), "settings-"));
const files = { compiled: join(dir, "paperclip.yaml"), catalog: join(dir, "modules.json"), grants: join(dir, "grants.json") };
writeFileSync(
  files.compiled,
  stringify({
    owner_name: "Sam",
    settings: { owner_name: { value: "Sam", set: true }, autonomy: { value: "off", set: false }, spend_caps: { value: "on", set: false }, heartbeat_hours: { value: 6, set: true } },
    mcp_servers: {
      glean: { url: "http://glean-mcp:8085/mcp", bearer_token_env_var: "AIDENHQ_GLEAN_MCP_TOKEN", setup: "Set GLEAN_MCP_URL.", tools: { read: ["search"], write: [] } },
      apps: { url: "http://apps-mcp:8090/mcp", tools: { read: ["app_list"], write: ["app_deploy"] } },
      paperclip_tasks: { command: "node", tools: { read: ["task_get"], write: ["task_comment"] } },
    },
    agents: {
      "chief-of-staff": { name: "Aiden", module: "core", adapter: "codex_local", model: "~deepseek/deepseek-flash-latest", heartbeat: true, enabled_tools: { apps: ["app_list"], paperclip_tasks: ["task_get", "task_comment"] } },
      devops: { name: "DevOps", module: "core", adapter: "codex_local", model: "m", enabled_tools: { apps: ["app_list", "app_deploy"], glean: ["search"] } },
    },
    routines: { "daily-brief": { title: "Prepare daily brief", agent: "chief-of-staff", schedules: [{ cron: "30 8 * * 1-5", timezone: "Europe/London", label: "weekday morning" }] } },
  }),
);
writeFileSync(
  files.catalog,
  JSON.stringify([
    { name: "core", enabled: true, connections: ["apps", "paperclip_tasks"], revision: "a".repeat(40), settings: { autonomy: { default: "off", values: ["off", "tier0", "full"], doc: "Tiered approvals." }, spend_caps: { default: "on", values: ["on", "off"] }, heartbeat_hours: { default: 4 } } },
    { name: "glean", enabled: true, connections: ["glean"], settings: {} },
    { name: "grafana", enabled: true, connections: [], settings: {}, setup: "Set GRAFANA_URL." },
  ]),
);
writeFileSync(files.grants, JSON.stringify({ autonomy: "full", agents: { "id-1": { key: "chief-of-staff", caps: { run_usd: 2, task_usd: 10, day_usd: 60 }, graded: false }, "id-2": { key: "devops", graded: true } } }));
writeFileSync(join(dir, "revs.jsonl"), JSON.stringify({ at: "2026-11-13T06:00:00Z", agent: "devops", product_sha: "a".repeat(40), instance_sha: "b".repeat(40) }) + "\n");

const pc = { me: async () => "me-1", agents: async () => [], labels: async () => [], company: async () => ({ issuePrefix: "WOR" }) } as unknown as Paperclip;
const app = createApp({
  paperclip: pc,
  store: new Store(":memory:"),
  log: pino({ level: "silent" }),
  allowedHosts: ["localhost:3120"],
  staticDir: "/nonexistent",
  timezone: "Europe/London",
  session: (req) => (req.headers.cookie === "signed-in" ? { accountId: "owner", role: "admin" as const } : null),
  glean: { status: async () => ({ state: "missing", configured: false, since: "2026-11-13T00:00:00Z", detail: "GLEAN_MCP_URL not set" }) } as never,
});
let port = 0;
beforeAll(async () => {
  process.env.BOARD_PAPERCLIP_CONFIG = files.compiled;
  process.env.BOARD_MODULES_FILE = files.catalog;
  process.env.AIDENHQ_GRANTS_FILE = files.grants;
  process.env.APPS_INTERNAL_TOKEN_FILE = `${import.meta.dirname}/fixtures/apps_token`;
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  port = (app.address() as AddressInfo).port;
});
afterAll(() => (app.close(), vi.unstubAllGlobals()));
const get = (path: string, cookie = "signed-in") =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: "localhost:3120", cookie } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject);
    req.end();
  });

describe("settings routes", () => {
  it("need a signed-in admin", async () => {
    expect((await get("/api/settings", "")).status).toBe(401);
    expect((await get("/api/settings/connections", "")).status).toBe(401);
  });

  it("show each setting with its source and live value, each agent's model, schedules and caps, and the instance's versions", async () => {
    const r = await get("/api/settings");
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text);
    const autonomy = d.settings.find((s: { key: string }) => s.key === "autonomy");
    // Compiled off (the default) but the grants table says full: the board shows both, so a half-done apply is visible.
    expect(autonomy).toMatchObject({ module: "core", value: "off", set: false, live: "full", values: ["off", "tier0", "full"], doc: "Tiered approvals.", switch: false });
    expect(d.settings.find((s: { key: string }) => s.key === "spend_caps")).toMatchObject({ switch: true, value: "on" });
    expect(d.settings.find((s: { key: string }) => s.key === "spend_caps").live).toBeUndefined(); // no gateway: unknown, not "on"
    const aiden = d.agents.find((a: { key: string }) => a.key === "chief-of-staff");
    expect(aiden).toMatchObject({ name: "Aiden", heartbeatHours: 6, caps: { day_usd: 60, run_usd: 2 }, routines: [{ key: "daily-brief", schedules: [{ label: "weekday morning" }] }] });
    expect(d.instance).toMatchObject({ product: "a".repeat(40), instance: "b".repeat(40), lastChangeAt: "2026-11-13T06:00:00Z", boardTimezone: "Europe/London" });
  });

  it("list every connection with who is granted it (read or write), its health and setup, the runner's services and the sources; no secrets", async () => {
    vi.stubGlobal("fetch", async (url: URL | string) => {
      const u = String(url);
      if (u.startsWith("http://glean-mcp")) return new Response(JSON.stringify({ ok: false, state: "missing", detail: "GLEAN_MCP_URL not set" }), { status: 503 });
      if (u.startsWith("http://apps-mcp:8090/healthz")) return new Response('{"ok":true}');
      if (u.includes("/internal/sources")) return new Response(JSON.stringify({ sources: [{ source: "slack", last_ok: new Date().toISOString(), failing: false }] }));
      throw new Error(`unexpected ${u}`);
    });
    const r = await get("/api/settings/connections");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/AIDENHQ_GLEAN_MCP_TOKEN|bearer|apps-token/i);
    const d = JSON.parse(r.text);
    const by = (n: string) => d.connections.find((c: { name: string }) => c.name === n);
    expect(by("apps")).toMatchObject({ module: "core", probe: { ok: true }, grants: [{ agent: "chief-of-staff", access: "read" }, { agent: "devops", access: "write" }] });
    expect(by("apps").probe.lastOkAt).toBeTruthy();
    expect(by("glean")).toMatchObject({ module: "glean", setup: "Set GLEAN_MCP_URL.", probe: { ok: false, state: "missing" }, signIn: { configured: false } });
    expect(by("paperclip_tasks")).toMatchObject({ transport: "built in", probe: null });
    expect(by("grafana")).toMatchObject({ kind: "service", setup: "Set GRAFANA_URL." });
    expect(d.sources).toEqual([expect.objectContaining({ name: "src_slack", failing: false, stale: false })]);
  });
});

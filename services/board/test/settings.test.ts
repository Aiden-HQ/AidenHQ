import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { stringify } from "yaml";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";

// The compiled config as scripts/modules.ts writes it (paperclip.yaml, modules.json) and the grants table setup writes.
const dir = mkdtempSync(join(tmpdir(), "settings-"));
const files = { compiled: join(dir, "paperclip.yaml"), catalog: join(dir, "modules.json"), grants: join(dir, "grants.json") };
writeFileSync(
  files.compiled,
  stringify({
    owner_name: "Sam",
    settings: { owner_name: { value: "Sam", set: true }, autonomy: { value: "off", set: false }, example_flag: { value: "on", set: false }, heartbeat_hours: { value: 6, set: true } },
    mcp_servers: {
      glean: { url: "http://glean-mcp:8085/mcp", bearer_token_env_var: "AIDENHQ_GLEAN_MCP_TOKEN", setup: "Set GLEAN_MCP_URL.", tools: { read: ["search"], write: [] } },
      apps: { url: "http://apps-mcp:8090/mcp", tools: { read: ["app_list"], write: ["app_deploy"] } },
      paperclip_tasks: { command: "node", tools: { read: ["task_get"], write: ["task_comment"] } },
    },
    agents: {
      "chief-of-staff": { name: "Aiden", module: "core", engine: "codex-openrouter", model: "~deepseek/deepseek-flash-latest", heartbeat: true, enabled_tools: { apps: ["app_list"], paperclip_tasks: ["task_get", "task_comment"] } },
      devops: { name: "DevOps", module: "core", engine: "codex-openrouter", model: "m", enabled_tools: { apps: ["app_list", "app_deploy"], glean: ["search"] } },
    },
    routines: { "daily-brief": { title: "Prepare daily brief", agent: "chief-of-staff", schedules: [{ cron: "30 8 * * 1-5", timezone: "Europe/London", label: "weekday morning" }] } },
  }),
);
writeFileSync(
  files.catalog,
  JSON.stringify([
    { name: "core", enabled: true, connections: ["apps", "paperclip_tasks"], revision: "a".repeat(40), settings: { autonomy: { default: "off", values: ["off", "tier0", "full"], doc: "Tiered approvals." }, example_flag: { default: "on", values: ["on", "off"] }, heartbeat_hours: { default: 4 } } },
    { name: "glean", enabled: true, connections: ["glean"], settings: {} },
    { name: "grafana", enabled: true, connections: [], settings: {}, setup: "Set GRAFANA_URL." },
  ]),
);
writeFileSync(files.grants, JSON.stringify({ autonomy: "full", agents: { "id-1": { key: "chief-of-staff", graded: false }, "id-2": { key: "devops", graded: true } } }));
writeFileSync(join(dir, "revs.jsonl"), JSON.stringify({ at: "2026-11-13T06:00:00Z", agent: "devops", product_sha: "a".repeat(40), instance_sha: "b".repeat(40) }) + "\n");

const pc = { me: async () => "me-1", agents: async () => [], labels: async () => [], company: async () => ({ issuePrefix: "WOR" }) } as unknown as Paperclip;
const kernelProbes = {
  apps: { ok: true, status: 200, checkedAt: "2026-11-19T00:00:00Z" },
  glean: { ok: false, status: 503, state: "missing", detail: "GLEAN_MCP_URL not set", checkedAt: "2026-11-19T00:00:00Z" },
};
const app = createApp({
  paperclip: pc,
  records: { ...fakeRecords(), connectionHealth: async () => kernelProbes },
  store: new Store(":memory:"),
  log: pino({ level: "silent" }),
  allowedHosts: ["localhost:3120"],
  staticDir: "/nonexistent",
  timezone: "Europe/London",
  session: (req) => (req.headers.cookie === "signed-in" ? { accountId: "owner", role: "admin" as const } : null),
  signIns: [{ id: "glean", label: "Glean", connect: "/glean/connect", callback: "/callback", missing: "m", stopped: "s", fields: [], auth: { status: async () => ({ state: "missing", configured: false, since: "2026-11-13T00:00:00Z", detail: "GLEAN_MCP_URL not set" }), offers: async () => false } as never }],
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
afterAll(() => app.close());
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

  it("show each setting with its source and live value, each agent's model, schedules, and the instance's versions", async () => {
    const r = await get("/api/settings");
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text);
    const autonomy = d.settings.find((s: { key: string }) => s.key === "autonomy");
    // Compiled off (the default) but the grants table says full: the board shows both, so a half-done apply is visible.
    expect(autonomy).toMatchObject({ module: "core", value: "off", set: false, live: "full", values: ["off", "tier0", "full"], doc: "Tiered approvals.", switch: false });
    expect(d.settings.find((s: { key: string }) => s.key === "example_flag")).toMatchObject({ switch: true, value: "on" });
    expect(d.settings.find((s: { key: string }) => s.key === "example_flag").live).toBeUndefined(); // read only at compile: nothing live to show
    const aiden = d.agents.find((a: { key: string }) => a.key === "chief-of-staff");
    expect(aiden).toMatchObject({ name: "Aiden", heartbeatHours: 6, routines: [{ key: "daily-brief", schedules: [{ label: "weekday morning" }] }] });
    expect(d.instance).toMatchObject({ product: "a".repeat(40), instance: "b".repeat(40), lastChangeAt: "2026-11-13T06:00:00Z", boardTimezone: "Europe/London" });
  });

});

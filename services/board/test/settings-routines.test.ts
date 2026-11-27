import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { stringify } from "yaml";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";

// A scheduled, a paused, an applied event and an unapplied event routine on one agent: what Settings shows for each.
const dir = mkdtempSync(join(tmpdir(), "settings-routines-"));
const compiled = join(dir, "paperclip.yaml");
const grants = join(dir, "grants.json");
const catalog = join(dir, "modules.json");
const event = (resource: string) => ({ connection: "linear", resource, filter: { kind: ["issue"] } });
writeFileSync(
  compiled,
  stringify({
    agents: { aiden: { name: "Aiden", module: "core", engine: "codex-openrouter", model: "m" } },
    routines: {
      brief: { title: "Brief", agent: "aiden", schedules: [{ cron: "0 9 * * 1-5" }] },
      digest: { title: "Digest", agent: "aiden", schedules: [{ cron: "0 18 * * 5" }] },
      issues: { title: "Issues", agent: "aiden", event: event("team-1") },
      later: { title: "Later", agent: "aiden", event: event("team-2") },
    },
  }),
);
writeFileSync(catalog, "[]");
writeFileSync(grants, JSON.stringify({ agents: {}, routine_keys: { r1: "brief", r2: "digest", r3: "issues", r4: "later" }, routine_events: { r3: { key: "issues", agent: "a", ...event("team-1") } } }));

const trigger = { enabled: true, nextRunAt: "2026-11-25T09:00:00.000Z" };
const pc = {
  me: async () => "me-1",
  agents: async () => [{ id: "ag1", status: "idle", metadata: { setupKey: "aidenhq:aiden" } }],
  labels: async () => [],
  company: async () => ({ issuePrefix: "WOR" }),
  routines: async () => [
    { id: "r1", title: "Brief", status: "active", triggers: [trigger] },
    { id: "r2", title: "Digest", status: "paused", triggers: [trigger] },
    { id: "r3", title: "Issues", status: "active", triggers: [] },
    { id: "r4", title: "Later", status: "active", triggers: [] },
    { id: "r5", title: "Repeats: WOR-9", status: "paused", assigneeAgentId: "ag1", triggers: [{ kind: "schedule", label: "repeats", enabled: true, nextRunAt: trigger.nextRunAt }] },
  ],
} as unknown as Paperclip;
const store = new Store(":memory:");
store.setRecurring("issue-9", { routineId: "r5", cadence: { kind: "weekly", weekday: "monday", interval: 1 }, time: "09:00", anchor: 1, repos: [] });
const app = createApp({ paperclip: pc, records: fakeRecords(), store, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "Europe/London", session: () => ({ accountId: "owner", role: "admin" as const }), signIns: [] });
let port = 0;
beforeAll(async () => {
  process.env.BOARD_PAPERCLIP_CONFIG = compiled;
  process.env.BOARD_MODULES_FILE = catalog;
  process.env.AIDENHQ_GRANTS_FILE = grants;
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  port = (app.address() as AddressInfo).port;
});
afterAll(() => app.close());

it("joins each routine's next run, pause and wake source", async () => {
  const text = await new Promise<string>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/settings", headers: { host: "localhost:3120" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve(t));
    });
    req.on("error", reject);
    req.end();
  });
  const rows = Object.fromEntries(JSON.parse(text).agents[0].routines.map((r: { key: string }) => [r.key, r]));
  expect(rows.brief).toMatchObject({ next: trigger.nextRunAt, paused: false });
  expect(rows.digest.paused).toBe(true);
  expect(rows.digest.next).toBeUndefined();
  expect(rows.issues.wakes).toMatchObject({ connection: "linear", resource: "team-1" });
  expect(rows.later.wakes).toBe("not_applied");
  expect(JSON.parse(text).agents[0].recurring).toEqual([expect.objectContaining({ title: "Repeats: WOR-9", task: "WOR-9", paused: true })]);
  expect(JSON.parse(text).agents[0].recurring[0].next).toBeUndefined();
});

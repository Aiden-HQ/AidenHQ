// A settings change from the board: refused unless it checks out, otherwise filed as the owner's own task with no assignee,
// the typed change handed to the kernel, which writes it (docs/design/settings-changes.md).
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { changesOf, stageOf } from "../src/settings-change.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";

const dir = mkdtempSync(join(tmpdir(), "settings-change-"));
writeFileSync(
  join(dir, "paperclip.yaml"),
  stringify({
    settings: { glean_mcp_url: { value: "", set: false }, grading: { value: "on", set: false }, maintainer_repos: { value: [{ repo: "acme/product" }], set: true } },
    agents: { "chief-of-staff": { name: "Aiden", module: "chief-of-staff", engine: "codex-openrouter", model: "openrouter/a" }, "fleet-engineer": { name: "Platform Engineer", engine: "codex-openrouter", profile: "engineer" }, helper: { name: "Helper", module: "helper", tier: "local" }, "team-eng": { name: "Engineer", profile: "engineer", team: { name: "engineering", members: ["kai"] } }, kai: { name: "Kai", profile: "engineer", member_of: "team-eng" } },
    mcp_servers: { crm: { tools: { read: ["crm_find"], write: ["crm_update"] } } },
    routines: { digest: { title: "Digest" } },
  }),
);
writeFileSync(join(dir, "modules.json"), JSON.stringify([{ name: "glean", enabled: true, settings: { glean_mcp_url: { default: "", type: "url", host: "*.glean.com" } } }, { name: "core", enabled: true, settings: { grading: { default: "on", values: ["on", "off"] }, ignore_repos: { default: [], pattern: "^[\\w.-]+/[\\w.-]+$" } } }]));
process.env.BOARD_PAPERCLIP_CONFIG = join(dir, "paperclip.yaml");
process.env.BOARD_MODULES_FILE = join(dir, "modules.json");
writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: { pe: { key: "fleet-engineer", roles: ["platform-engineer"], tools: {} } } }));
process.env.AIDENHQ_GRANTS_FILE = join(dir, "grants.json");

const created: Record<string, any>[] = [];
const pc = {
  me: async () => "owner-user",
  agents: async () => [{ id: "pe", name: "Platform Engineer", status: "idle", metadata: { engine: "openrouter", setupKey: "aidenhq:fleet-engineer" } }],
  labels: async () => [{ id: "l1", name: "settings-change", color: "#000" }],
  company: async () => ({ issuePrefix: "WOR" }),
  createIssue: async (b: Record<string, any>) => (created.push(b), { id: "i1", identifier: "WOR-9", ...b }),
  // The list cuts descriptions short; the task itself has the whole one.
  labelled: async () => created.map((b) => ({ id: "i1", identifier: "WOR-9", title: b.title, status: "in_progress", createdAt: new Date().toISOString(), description: b.description.slice(0, 40), descriptionTruncated: true })),
  issue: async () => ({ id: "i1", identifier: "WOR-9", title: created.at(-1)!.title, status: "in_progress", createdAt: new Date().toISOString(), description: created.at(-1)!.description }),
} as unknown as Paperclip;

describe("POST /api/settings/change", () => {
  let session: { accountId: string; role: "admin" | "user" } | null = { accountId: "owner", role: "admin" };
  const store = new Store(":memory:");
  const records = fakeRecords();
  const app = createApp({ paperclip: pc, store, records, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => session });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const post = (body: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const text = JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/settings/change", headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1" } }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : null }));
      });
      req.on("error", reject);
      req.end(text);
    });

  it("refuses a URL that fails the check, an unknown setting and a heartbeat on a runner agent", async () => {
    expect(await post({ changes: [{ kind: "setting", key: "glean_mcp_url", value: "https://evil.example.com/mcp" }] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("glean.com") } });
    expect(await post({ changes: [{ kind: "setting", key: "glean_mcp_url", value: "https://acme.glean.com/mcp?token=x" }] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("credentials") } });
    expect((await post({ changes: [{ kind: "setting", key: "nope", value: "x" }] })).status).toBe(400);
    expect((await post({ changes: [{ kind: "setting", key: "grading", value: "maybe" }] })).status).toBe(400);
    expect((await post({ changes: [{ kind: "agent", agent: "fleet-engineer", field: "heartbeat", value: 4 }] })).status).toBe(400);
    // An empty entry in a list fails the setting's pattern the same way compile checks it (`[]` empties the list).
    expect(await post({ changes: [{ kind: "setting", key: "ignore_repos", value: ["acme/probe", ""] }] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("must match") } });
    // A setting holding entries would lose them to a flat list: instance.yaml only.
    expect(await post({ changes: [{ kind: "setting", key: "maintainer_repos", value: ["acme/product"] }] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("instance.yaml") } });
    expect(created).toHaveLength(0);
  });

  it("refuses new kinds that name nothing real, or the wrong kind of agent", async () => {
    for (const ch of [
      { kind: "grants", agent: "chief-of-staff", connection: "crm", tools: ["crm_drop"] },
      { kind: "grants", agent: "helper", connection: "crm", tools: ["crm_find"] },
      { kind: "handbook", agent: "helper", text: "x" },
      { kind: "unfork", agent: "chief-of-staff" },
      { kind: "routine", routine: "nope", field: "model", value: "x/y" },
      { kind: "pin", name: "glean", sha: "main" },
      { kind: "marketplace", op: "add", name: "acme", sha: "a".repeat(40) },
      // A team member has no heartbeat of its own.
      { kind: "agent", agent: "kai", field: "heartbeat", value: 4 },
    ]) expect((await post({ changes: [ch] })).status, JSON.stringify(ch)).toBe(400);
    expect(created).toHaveLength(0);
  });

  it("files the owner's own task with no assignee, and hands the typed change to the kernel", async () => {
    const url = "https://acme-be.glean.com/mcp/default";
    const changes = [{ kind: "setting", key: "glean_mcp_url", value: url }, { kind: "agent", agent: "chief-of-staff", field: "reasoning_effort", value: "high" }, { kind: "grants", agent: "chief-of-staff", connection: "crm", tools: ["crm_find"] }];
    const r = await post({ changes });
    expect(r).toMatchObject({ status: 200, body: { identifier: "WOR-9" } });
    const t = created.at(-1)!;
    expect(t).toMatchObject({ labelIds: ["l1"], status: "todo" });
    expect(t.assigneeAgentId).toBeUndefined();
    expect(changesOf(t.description)?.map((c) => c.kind)).toEqual(["setting", "agent", "grants"]);
    expect(store.meta("settings-change:i1")).toBe(JSON.stringify(changes));
    expect(records.settings).toEqual([{ task: "i1", changes }]);
  });

  it("asks the module's validate hook first: its refusal is the field's error and nothing is filed", async () => {
    const asked: unknown[] = [];
    const was = records.validate;
    records.validate = async (module, settings) => (asked.push([module, settings]), { ok: false, errors: [{ field: "glean_mcp_url", message: "that workspace isn't reachable" }] });
    const before = created.length;
    const r = await post({ changes: [{ kind: "setting", key: "glean_mcp_url", value: "https://acme-be.glean.com/mcp/default" }] });
    records.validate = was;
    expect(r).toMatchObject({ status: 422, body: { error: "glean_mcp_url: that workspace isn't reachable", errors: [{ field: "glean_mcp_url", message: "that workspace isn't reachable" }] } });
    expect(asked).toEqual([["glean", { glean_mcp_url: "https://acme-be.glean.com/mcp/default" }]]);
    expect(created).toHaveLength(before);
  });

  it("lists a filed change with where it stands", async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: "/api/settings/changes", headers: { host: "localhost:3120" } }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(r.status).toBe(200);
    expect(r.body.changes[0]).toMatchObject({ identifier: "WOR-9", stage: "working", items: [{ kind: "setting", key: "glean_mcp_url" }, { kind: "agent", field: "reasoning_effort" }, { kind: "grants", connection: "crm" }] });
  });

  it("needs a signed-in admin", async () => {
    session = { accountId: "u", role: "user" };
    expect((await post({ changes: [{ kind: "setting", key: "autonomy", value: "tier0" }] })).status).toBe(403);
    session = { accountId: "owner", role: "admin" };
  });
  it("a local agent's rules are its whole handbook: accepted; its grants are its module.yaml's: refused; a routine's status is the live controls'", async () => {
    expect(await post({ changes: [{ kind: "grants", agent: "helper", connection: "crm", tools: ["crm_find"] }] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("module.yaml") } });
    expect((await post({ changes: [{ kind: "routine", routine: "digest", field: "status", value: "paused" }] })).status).toBe(400);
    const before = created.length;
    expect((await post({ changes: [{ kind: "rules", agent: "helper", text: "# Helper\n\nYou help." }] })).status).toBe(200);
    expect(created).toHaveLength(before + 1);
  });
});

describe("where a settings change stands", () => {
  const card = (over: Record<string, unknown>) => ({ id: "A-1", action: "apply" as const, state: "pending" as const, outcome: null, tier: 2 as const, outcomeText: null, ...over });
  it("follows the task, then its apply card", () => {
    expect(stageOf("in_progress", [], new Date().toISOString()).stage).toBe("working");
    expect(stageOf("in_progress", [], new Date(Date.now() - 3_600_000).toISOString()).stage).toBe("failed");
    expect(stageOf("in_progress", undefined, new Date(Date.now() - 3_600_000).toISOString()).stage).toBe("working");
    expect(stageOf("in_progress", [card({})], new Date().toISOString())).toMatchObject({ stage: "waiting", tier: 2 });
    expect(stageOf("done", [card({ state: "running" })], new Date().toISOString()).stage).toBe("applying");
    expect(stageOf("done", [card({ state: "approved" })], new Date().toISOString()).stage).toBe("applying");
    expect(stageOf("done", [card({ state: "used", outcome: "applied" })], new Date().toISOString()).stage).toBe("applied");
    // A `used` record with no outcome is an end, not a live edit: only a claimed (`running`) record is in flight.
    expect(stageOf("done", [card({ state: "used" })], new Date().toISOString()).stage).toBe("closed");
    expect(stageOf("done", [card({ state: "rejected" })], new Date().toISOString()).stage).toBe("rejected");
  });
});

// A settings change from the board: refused unless it checks out, otherwise filed as the owner's task for the Platform
// Engineer with the exact instance.yaml lines (docs/design/settings-changes.md).
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

const dir = mkdtempSync(join(tmpdir(), "settings-change-"));
writeFileSync(
  join(dir, "paperclip.yaml"),
  stringify({
    settings: { glean_mcp_url: { value: "", set: false }, grading: { value: "on", set: false } },
    agents: { "chief-of-staff": { name: "Aiden", adapter: "codex_local", model: "openrouter/a" }, "fleet-engineer": { name: "Platform Engineer", adapter: "opencode_local", dispatch: "runner" } },
  }),
);
writeFileSync(join(dir, "modules.json"), JSON.stringify([{ name: "glean", enabled: true, settings: { glean_mcp_url: { default: "", type: "url", host: "*.glean.com" } } }, { name: "core", enabled: true, settings: { grading: { default: "on", values: ["on", "off"] } } }]));
process.env.BOARD_PAPERCLIP_CONFIG = join(dir, "paperclip.yaml");
process.env.BOARD_MODULES_FILE = join(dir, "modules.json");
writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: { pe: { key: "fleet-engineer", roles: ["platform-engineer"], tools: {} } } }));
process.env.AIDENHQ_GRANTS_FILE = join(dir, "grants.json");

const created: Record<string, any>[] = [];
const pc = {
  me: async () => "owner-user",
  agents: async () => [{ id: "pe", name: "Platform Engineer", status: "idle", adapterType: "opencode_local", metadata: { setupKey: "aidenhq:fleet-engineer" } }],
  labels: async () => [{ id: "l1", name: "settings-change", color: "#000" }],
  company: async () => ({ issuePrefix: "WOR" }),
  createIssue: async (b: Record<string, any>) => (created.push(b), { id: "i1", identifier: "WOR-9", ...b }),
  // The list cuts descriptions short; the task itself has the whole one.
  labelled: async () => created.map((b) => ({ id: "i1", identifier: "WOR-9", title: b.title, status: "in_progress", createdAt: new Date().toISOString(), description: b.description.slice(0, 40), descriptionTruncated: true })),
  issue: async () => ({ id: "i1", identifier: "WOR-9", title: created.at(-1)!.title, status: "in_progress", createdAt: new Date().toISOString(), description: created.at(-1)!.description }),
} as unknown as Paperclip;

describe("POST /api/settings/change", () => {
  let session: { accountId: string; role: "admin" | "user" } | null = { accountId: "owner", role: "admin" };
  const app = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => session });
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
    expect(created).toHaveLength(0);
  });

  it("files the owner's task for the Platform Engineer with the exact lines", async () => {
    const url = "https://acme-be.glean.com/mcp/default";
    const r = await post({ changes: [{ kind: "setting", key: "glean_mcp_url", value: url }, { kind: "agent", agent: "chief-of-staff", field: "reasoning_effort", value: "high" }] });
    expect(r).toMatchObject({ status: 200, body: { identifier: "WOR-9" } });
    const t = created.at(-1)!;
    expect(t).toMatchObject({ assigneeAgentId: "pe", labelIds: ["l1"], status: "todo" });
    expect(t.description).toContain(`settings:\n  glean_mcp_url: "${url}"\noverrides:\n  agents:\n    chief-of-staff:\n      reasoning_effort: "high"`);
    // No source marker: the runner's ownRequest takes an owner-made task's description as the request.
    expect(t.description).not.toMatch(/<!--\s*source:/);
    expect(changesOf(t.description)?.map((c) => c.kind)).toEqual(["setting", "agent"]);
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
    expect(r.body.changes[0]).toMatchObject({ identifier: "WOR-9", stage: "working", items: [{ kind: "setting", key: "glean_mcp_url" }, { kind: "agent", field: "reasoning_effort" }] });
  });

  it("needs a signed-in admin", async () => {
    session = { accountId: "u", role: "user" };
    expect((await post({ changes: [{ kind: "setting", key: "autonomy", value: "tier0" }] })).status).toBe(403);
    session = { accountId: "owner", role: "admin" };
  });
});

describe("where a settings change stands", () => {
  const card = (over: Record<string, unknown>) => ({ id: "A-1", action: "apply" as const, state: "pending" as const, outcome: null, tier: 2 as const, outcomeText: null, ...over });
  it("follows the task, then its apply card", () => {
    expect(stageOf("in_progress", []).stage).toBe("working");
    expect(stageOf("in_progress", [card({})])).toMatchObject({ stage: "waiting", tier: 2 });
    expect(stageOf("done", [card({ state: "used" })]).stage).toBe("applying");
    expect(stageOf("done", [card({ state: "used", outcome: "applied" })]).stage).toBe("applied");
    expect(stageOf("done", [card({ state: "rejected" })]).stage).toBe("rejected");
  });
});

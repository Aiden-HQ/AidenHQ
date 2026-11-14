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

// The Researcher may change the board, but never a memory inbox (the grants table names it): only memory_note writes there.
const INBOX = "22222222-2222-2222-2222-222222222222";
const grantsFile = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
writeFileSync(grantsFile, JSON.stringify({ agents: { ra: { key: "assistant", roles: ["board-writer"], tools: { paperclip_tasks: ["task_schedule", "task_merge"] } }, scout: { key: "scout", roles: [], tools: {}, memory_inbox: INBOX } } }));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

describe("memory inboxes on the internal listener", () => {
  const TOKEN = "t".repeat(64);
  const task = (id: string, identifier: string) => ({ id, identifier, title: "T", description: "", status: "todo", priority: "medium", assigneeUserId: "me-1", assigneeAgentId: null, createdAt: "", updatedAt: "" });
  const issues = [task("11111111-1111-1111-1111-111111111111", "PEN-1"), task(INBOX, "PEN-2")];
  const pc = {
    me: async () => "me-1",
    agents: async () => [],
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref),
    companyId: "co",
    agentMe: async (key: string) => (key === "ra" ? { id: key, name: key, companyId: "co" } : Promise.reject(new Error("401"))),
  } as unknown as Paperclip;
  const app = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const post = (path: string, body: unknown) =>
    new Promise<{ status: number; error?: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-agent-key": "ra" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, error: JSON.parse(text || "{}").error }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  it("refuses schedule and merge on an inbox, as the source or the target", async () => {
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    for (const [path, body] of [["/internal/issues/PEN-2/schedule", { date }], ["/internal/issues/PEN-2/merge", { into: "PEN-1" }], ["/internal/issues/PEN-1/merge", { into: "PEN-2" }]] as const) {
      const r = await post(path, body);
      expect(r.status, path).toBe(403);
      expect(r.error).toMatch(/memory inbox/);
    }
    expect((await post("/internal/issues/PEN-1/schedule", { date })).status).toBe(200);
  });
});

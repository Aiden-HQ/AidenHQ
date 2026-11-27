// The board's own placement is the one truth for a task's bucket: an agent's placement through the internal listener (a second
// app on the same store) shows on the Tasks page and the owner MCP's `tasks` (both read GET /api/board) at once, not after the
// page cache (swr.ts) happens to expire.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { asAgent } from "./caller.js";

const grantsFile = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
writeFileSync(grantsFile, JSON.stringify({ agents: { scout: { key: "scout", roles: [], tools: { paperclip_tasks: ["task_schedule"] } } } }));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

const TOKEN = "t".repeat(64);
const at = "2026-11-20T10:00:00.000Z";
const issue: Issue = { id: "i1", identifier: "WOR-1", title: "Reply to Dana", description: "", status: "todo", priority: "medium", assigneeUserId: "me", assigneeAgentId: null, assigneeAdapterOverrides: null, createdByAgentId: "scout", createdAt: at, updatedAt: at };
const pc = {
  me: async () => "me",
  agents: async () => [{ id: "scout", name: "Scout", status: "idle", metadata: {} }],
  labels: async () => [],
  company: async () => ({ issuePrefix: "WOR" }),
  projects: async () => [],
  issue: async () => issue,
  openIssues: async () => [issue],
  openListed: async () => ({ issues: [issue], incomplete: false }),
  closedListed: async () => ({ issues: [], incomplete: false }),
  comments: async () => [],
  routines: async () => [],
  issueSummary: async () => issue,
  companyId: "co",
} as unknown as Paperclip;

describe("agent placement reaches the board's pages", () => {
  const store = new Store(":memory:");
  const common = { paperclip: pc, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC" };
  const board = createApp({ ...common, allowedHosts: ["localhost:3120"], session: () => ({ accountId: "owner", role: "admin" as const }) });
  const internal = createApp({ ...common, allowedHosts: ["board:3122"], mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40) });
  const port = (a: typeof board) => (a.address() as AddressInfo).port;
  beforeAll(async () => {
    await Promise.all([board, internal].map((a) => new Promise<void>((r) => a.listen(0, "127.0.0.1", r))));
    await board.sweep();
  });
  afterAll(() => void (board.close(), internal.close()));
  const send = (app: typeof board, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: port(app), method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const bucketsOf = async () => Object.fromEntries(Object.entries((await send(board, "GET", "/api/board", { host: "localhost:3120", "x-aidenhq-board": "1" })).json.buckets as Record<string, Issue[]>).map(([b, l]) => [b, l.map((t) => t.identifier)]));

  it("lists a task placed by an agent under its new bucket straight away", async () => {
    expect((await bucketsOf()).triage).toEqual(["WOR-1"]);
    const placed = await send(internal, "POST", "/internal/issues/WOR-1/schedule", { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...asAgent("scout") }, { bucket: "today", reason: "Dana waits on a reply" });
    expect(placed.status).toBe(200);
    expect(await bucketsOf()).toMatchObject({ triage: [], today: ["WOR-1"] });
  });

  it("does not join a board read that began before the placement", async () => {
    await send(internal, "POST", "/internal/issues/WOR-1/schedule", { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...asAgent("scout") }, { bucket: "tomorrow", reason: "moved again" }).catch(() => {});
    store.move("i1", "later");
    const slow = bucketsOf();
    store.events.emit("board");
    expect((await bucketsOf()).later).toEqual(["WOR-1"]);
    await slow;
  });
});

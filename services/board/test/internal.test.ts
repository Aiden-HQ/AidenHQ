import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { asAgent } from "./caller.js";
import { card, fakeRecords } from "./fake-records.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// The grants table setup writes: the Researcher may change the board; the Scout holds the tool but not the role.
const grantsFile = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
writeFileSync(grantsFile, JSON.stringify({ agents: { ra: { key: "assistant", roles: ["board-writer", "fleet-read"], tools: { paperclip_tasks: ["task_schedule", "task_file_upload"] } }, engy: { key: "engineer", roles: [], tools: { paperclip_tasks: ["task_approvals"] } }, scout: { key: "scout", roles: [], tools: { paperclip_tasks: ["task_schedule", "task_file_upload"] } }, beta: { key: "beta", roles: [], tools: { paperclip_tasks: ["task_file_upload"] } } } }));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

describe("internal listener", () => {
  const TOKEN = "t".repeat(64);
  const store = new Store(":memory:");
  const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "T", description: "", status: "todo", priority: "medium", assigneeUserId: "me-1", assigneeAgentId: null, assigneeAdapterOverrides: null, createdAt: "", updatedAt: "" };
  const pc = {
    me: async () => "me-1",
    agents: async () => ["ra", "scout", "beta", "engy"].map((id) => ({ id, name: id })),
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async () => issue,
    companyId: "co",
  } as unknown as Paperclip;
  const app = createApp({ paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  // fetch() always sends its own Host header; the guard is tested with the names the bridge uses.
  const call = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  afterAll(() => app.close());

  // The tasks bridge: the internal token plus the kernel's caller assertion.
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call("POST", path, body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...asAgent("ra"), ...headers });


  it("needs the token and an allowed host", async () => {
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { authorization: "" })).status).toBe(401);
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { host: "evil:3122" })).status).toBe(403);
  });

  it("the token alone changes nothing: the caller must be an agent granted the tool and the board-writer role", async () => {
    const refused = async (path: string, body: unknown, headers: Record<string, string>) => (await (await post(path, body, headers)).json()) as { error: string };
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, { "x-aidenhq-caller": "" })).error).toBe("missing caller assertion");
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, asAgent("forged"))).error).toMatch(/^only an agent granted task_schedule/);
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, asAgent("scout"))).error).toMatch(/with the board-writer role/);
    expect((await refused("/internal/issues/PEN-1/recurring", { action: "stop" }, {})).error).toMatch(/^only an agent granted task_recurring/); // not granted
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, asAgent("ra", { aud: "ops" }))).error).toMatch(/^refused: the caller assertion is for ops/);
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, asAgent("ra", { exp: 1 }))).error).toMatch(/expired/);
  });

  it("a task's approval read includes the Tier 0 merge card the publish rule waits on", async () => {
    // A merge the fleet files for a green PR in the agents org is Tier 0: a read that drops it would tell the run no merge
    // card exists, and nothing would wake the task.
    // The merge card is older than 60 newer routine cards on the same task: the read still returns it.
    const inner = fakeRecords([
      card({ id: "k-0000000000000001", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 0, state: "used", outcome: "applied", outcomeText: "merged-prs: []", createdAt: "2026-11-10T10:00:00.000Z" }),
      card({ id: "k-0000000000000002", issueId: "another-task", identifier: "PEN-9", action: "merge", tier: 0, state: "pending" }),
      ...Array.from({ length: 60 }, (_, i) => card({ id: `k-00000000000002${String(i).padStart(2, "0")}`, issueId: issue.id, identifier: issue.identifier, action: "conn.tool", tier: 0, state: "used", outcome: "applied", createdAt: `2026-11-2${i % 4}T10:00:00.000Z` })),
    ]);
    // The kernel's read is newest first and capped: 60 newer routine cards sit ahead of this task's merge card.
    const seen: { tier0?: boolean; strict?: boolean }[] = [];
    const records: typeof inner = {
      ...inner,
      list: async (state, o = {}) => {
        seen.push(o);
        const all = await inner.list(state, { ...o, limit: 1000 });
        return all.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, o.limit ?? 100);
      },
    };
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port2 = (board.address() as AddressInfo).port;
    const get = (issueParam: string) =>
      new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: port2, method: "GET", path: `/internal/approvals?issue=${issueParam}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
        });
        req.on("error", reject);
        req.end();
      });
    const other9 = { ...issue, id: "another-task", identifier: "PEN-9", title: "Other" };
    const resolve = (pc as any).issue;
    (pc as any).issue = async (ref: string) => (ref === other9.identifier || ref === other9.id ? other9 : issue);
    try {
      const mine = (await (await get(issue.identifier)).json()) as { approvals: { id: string }[] };
      expect(mine.approvals.map((a) => a.id)).toContain("k-0000000000000001");
      expect(seen.at(-1)).toMatchObject({ tier0: true, strict: true });
      // Another task's card is never in this task's read, whatever its tier.
      const other = (await (await get("PEN-9")).json()) as { approvals: { id: string }[] };
      expect(other.approvals.map((a) => a.id)).toEqual(["k-0000000000000002"]);
    } finally {
      (pc as any).issue = resolve;
      board.close();
    }
  });

  it("a failed task or records lookup is an error, never an empty card list", async () => {
    const failing = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records: { ...fakeRecords([]), list: async () => { throw new Error("the kernel answered 503"); } } });
    await new Promise<void>((r) => failing.listen(0, "127.0.0.1", r));
    const port3 = (failing.address() as AddressInfo).port;
    const get = (path: string) =>
      new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: port3, method: "GET", path, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
        });
        req.on("error", reject);
        req.end();
      });
    const resolve = (pc as any).issue;
    try {
      // The kernel's records endpoint is down: not a task with no cards.
      (pc as any).issue = async () => issue;
      expect((await get(`/internal/approvals?issue=${issue.identifier}`)).status).toBeGreaterThanOrEqual(500);
      // The task lookup itself failed: the same, rather than an empty list.
      (pc as any).issue = async () => { throw new Error("the control plane answered 502"); };
      expect((await get("/internal/approvals?issue=PEN-1")).status).toBeGreaterThanOrEqual(500);
    } finally {
      (pc as any).issue = resolve;
      failing.close();
    }
  });

  it("serves only /internal/ routes: not the user's API or the page", async () => {
    expect((await post("/api/issues", { title: "x" })).status).toBe(404);
    expect((await call("GET", "/", undefined, { host: "board:3122", authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it("attaches a file to the caller's own task only, and lists it back", async () => {
    const mine = { ...issue, id: "33333333-3333-3333-3333-333333333333", identifier: "PEN-3", assigneeUserId: null, assigneeAgentId: "ra" };
    (pc as any).issue = async (ref: string) => (ref === mine.identifier || ref === mine.id ? mine : issue);
    const files: any[] = [];
    (pc as any).attachments = async (id: string) => files.filter((f) => f.issueId === id);
    (pc as any).addAttachment = async (issueId: string, name: string, type: string, data: Buffer) => {
      const a = { id: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001", issueId, originalFilename: name, contentType: type, byteSize: data.length, createdAt: "2026-11-19T00:00:00Z" };
      files.push(a);
      return a;
    };
    try {
      const body = { name: "../report.md", type: "text/markdown", data: Buffer.from("# Report\n").toString("base64") };
      const ok = await post("/internal/issues/PEN-3/files", body, asAgent("ra"));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ file: { name: "report.md", type: "text/markdown", size: 9, textOf: null } });
      expect(files.map((f) => f.originalFilename)).toEqual(["report.md"]);
      // Another agent's task, and one with no agent on it: refused, and no bytes are stored.
      expect((await post("/internal/issues/PEN-3/files", body, asAgent("beta"))).status).toBe(403);
      expect((await post("/internal/issues/PEN-1/files", body, asAgent("beta"))).status).toBe(403);
      expect((await post("/internal/issues/PEN-3/files", { ...body, name: "big.bin", data: Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64") }, asAgent("ra"))).status).toBe(400);
      expect(files).toHaveLength(1);
    } finally {
      (pc as any).issue = async () => issue;
      delete (pc as any).attachments;
      delete (pc as any).addAttachment;
    }
  });

});

import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { asAgent } from "./caller.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// The grants table setup writes: the Researcher may change the board; the Scout holds the tool but not the role.
const grantsFile = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
writeFileSync(grantsFile, JSON.stringify({ agents: { ra: { key: "assistant", roles: ["board-writer", "fleet-read"], tools: { paperclip_tasks: ["task_schedule", "task_file_upload"] } }, scout: { key: "scout", roles: [], tools: { paperclip_tasks: ["task_schedule", "task_file_upload"] } }, beta: { key: "beta", roles: [], tools: { paperclip_tasks: ["task_file_upload"] } } } }));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

describe("internal listener", () => {
  const TOKEN = "t".repeat(64);
  const store = new Store(":memory:");
  const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "T", description: "", status: "todo", priority: "medium", assigneeUserId: "me-1", assigneeAgentId: null, assigneeAdapterOverrides: null, createdAt: "", updatedAt: "" };
  const pc = {
    me: async () => "me-1",
    agents: async () => ["ra", "scout", "beta"].map((id) => ({ id, name: id })),
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

  it("serves only /internal/ routes: not the user's API or the page", async () => {
    expect((await post("/api/issues", { title: "x" })).status).toBe(404);
    expect((await call("GET", "/", undefined, { host: "board:3122", authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it("fleet_status answers whole JSON behind long lists, with the cut notice first", async () => {
    const big = "t".repeat(200);
    const row = (k: number) => ({ id: `i${k}`, identifier: `PEN-${k}`, title: big, status: "blocked", priority: "medium", assigneeUserId: null, assigneeAgentId: "a1", assigneeAdapterOverrides: null, createdAt: "2026-11-13T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z" });
    (pc as any).request = async (m: string, path: string) => (path.includes("/issues?") ? Array.from({ length: 500 }, (_, k) => row(k)) : []);
    // The summary's own reads (a failed one is allowed to be null, but it must not outlive the stub above).
    (pc as any).closedSince = async () => [];
    try {
      // The body as it goes over the wire, not the object a caller happened to build.
      const res = await post("/internal/fleet/status", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { truncated?: string[] } & Record<string, unknown>;
      expect(JSON.stringify(body).length).toBeLessThanOrEqual(24_000);
      expect(Object.keys(body)[0]).toBe("truncated");
      expect(body.truncated?.some((t) => /^(stuck|agents): \d+ of 500$/.test(t))).toBe(true);
    } finally {
      delete (pc as any).request;
      delete (pc as any).closedSince;
    }
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
      expect(await ok.json()).toMatchObject({ file: { name: "report.md", type: "text/markdown", size: 9, by: "agent", textOf: null } });
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

  it("schedules a move on the user's task, and rejects bad dates", async () => {
    const ok = await post("/internal/issues/PEN-1/schedule", { date: "2099-01-01" });
    expect(ok.status).toBe(400);
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await post("/internal/issues/PEN-1/schedule", { date });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identifier: "PEN-1", scheduled: { date, bucket: "today", position: "top" } });
    expect(store.schedules().get(issue.id)?.date).toBe(date);
  });
});

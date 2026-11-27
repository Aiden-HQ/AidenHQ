// Every admin is an owner (owner decision 2026-11-12): any signed-in admin writes as the owner through the kernel, in the
// owner's chats too (their decisions are taken on the kernel's approval page, stamped there). The board records which account
// wrote what and shows "by <name>" on what an admin other than the owner wrote or decided, and tells the kernel the account
// with each write. Real Paperclip client over a fake fetch standing for the kernel's /v1/cp routes; the kernel's accounts
// routes stood in for (kernel.ts): each admin holds a board session the kernel handed off.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { card, fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel, type FakeAccount } from "./kernel.js";

const CO = "00000000-0000-4000-8000-000000000001";
const KEY = "the-boards-kernel-key";
const chatLabel = { id: "33333333-3333-3333-3333-333333333333", name: "chat", color: "#0ea5e9" };
const base = { status: "todo", priority: "medium", assigneeAdapterOverrides: null, createdAt: "2026-11-12T08:00:00.000Z", updatedAt: "2026-11-12T08:00:00.000Z", description: "Ship the pricing page." };
const issue = (n: number, extra: Record<string, unknown>) => ({ ...base, id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, identifier: `WOR-${n}`, title: `Task ${n}`, ...extra });
const issues = [
  issue(1, { assigneeUserId: "me", assigneeAgentId: null, createdByUserId: "me", createdByAgentId: null }), // the owner's task
  issue(3, { assigneeUserId: null, assigneeAgentId: "aiden", createdByUserId: "me", createdByAgentId: null, labels: [chatLabel] }), // the owner's chat
];
// Aiden is a teammate (compiled config, keyed by the grants table): only a teammate takes the owner's chats.
const cfg = mkdtempSync(join(tmpdir(), "admins-"));
writeFileSync(join(cfg, "paperclip.yaml"), "agents:\n  chief-of-staff: { name: Aiden, teammate: { job: Chief of staff, sample: Ask me, staff: [], controls: [], face: null } }\n");
writeFileSync(join(cfg, "grants.json"), JSON.stringify({ agents: { aiden: { key: "chief-of-staff" } } }));
process.env.BOARD_PAPERCLIP_CONFIG = join(cfg, "paperclip.yaml");
process.env.AIDENHQ_GRANTS_FILE = join(cfg, "grants.json");
const agents = [{ id: "aiden", name: "Aiden", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:chief-of-staff" } }];

/** Every write the kernel got, with the credential and the admin it came with; comments are kept per task. */
const writes: { key: string; account?: string; method: string; path: string; body: any }[] = [];
const comments = new Map<string, any[]>();
let made = 0;
const fakeFetch = (async (url: URL, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const headers = init.headers as Record<string, string>;
  // Reads at /v1/cp/read/<path>, writes at /v1/cp/owner/<path> (kernel/src/cp.ts createBoardCp).
  const lane = /^\/v1\/cp\/(read|owner)(\/.*)$/.exec(url.pathname);
  if (!lane || (lane[1] === "read") !== (method === "GET")) return new Response("{}", { status: 403 });
  const path = lane[2]!;
  const key = String(headers.authorization).replace(/^Bearer /, "");
  const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
  const find = (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref);
  if (key !== KEY) return new Response("{}", { status: 401 });
  const commentsOf = /^\/api\/issues\/([^/]+)\/comments$/.exec(path);
  if (method !== "GET") {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    writes.push({ key, account: headers["x-aidenhq-account"], method, path, body });
    if (commentsOf) {
      const c = { id: `comment-${++made}`, body: body.body, authorType: "user", authorUserId: "me", createdAt: new Date().toISOString() };
      comments.set(commentsOf[1]!, [...(comments.get(commentsOf[1]!) ?? []), c]);
      return json(c);
    }
    return json({ ...find(decodeURIComponent(path.split("/")[3]!)), ...body });
  }
  if (path === "/api/cli-auth/me") return json({ userId: "me" });
  if (path === `/api/companies/${CO}`) return json({ issuePrefix: "WOR" });
  if (path === `/api/companies/${CO}/agents`) return json(agents);
  if (path === `/api/companies/${CO}/labels`) return json([chatLabel]);
  if (path === `/api/companies/${CO}/issues`) return json(url.searchParams.get("parentId") ? [] : issues);
  if (commentsOf) return json(comments.get(commentsOf[1]!) ?? []);
  const one = /^\/api\/issues\/([^/]+)$/.exec(path);
  if (one) return find(decodeURIComponent(one[1]!)) ? json(find(decodeURIComponent(one[1]!))) : new Response("{}", { status: 404 });
  return json([]); // attachments, runs, routines
}) as typeof fetch;

describe("every admin writes as the owner, with their name on it", () => {
  const log = pino({ level: "silent" });
  const store = new Store(":memory:");
  const records = fakeRecords();
  let app: ReturnType<typeof createApp>;
  let port = 0;
  let kernel: Awaited<ReturnType<typeof fakeKernel>>;
  beforeAll(async () => {
    kernel = await fakeKernel();
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    app = createApp({ paperclip: new Paperclip("http://paperclip", CO, KEY, fakeFetch), store, records, log, staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"], mode: "lan" });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });

  /** A browser holding a ready admin's board session (the kernel handed it off). */
  function admin(account: FakeAccount) {
    const cookie = `aidenhq-board=${kernel.session(account)}`;
    return (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const headers: Record<string, string> = { host: "localhost:3121", cookie, ...(method !== "GET" ? { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3121" } : {}) };
        const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
        });
        req.on("error", reject);
        req.end(body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body));
      });
  }

  it("another admin's comment goes in as the owner through the kernel, in the owner's chat too, labelled with their name", async () => {
    const owner = { id: "u-owner", email: "owner@example.com", name: "Owner", role: "admin" as const, owner: true };
    const me = admin(owner);
    const ann = admin({ id: "u-ann", email: "ann@example.com", name: "Ann", role: "admin", owner: false });
    const annId = "u-ann";

    expect((await me("POST", "/api/issues/WOR-1/comments", { body: "Looks good" })).status).toBe(200);
    expect((await ann("POST", "/api/issues/WOR-1/comments", { body: "Ship it Friday" })).status).toBe(200);
    expect(writes.at(-1)).toMatchObject({ key: KEY, account: annId, body: { body: "Ship it Friday" } });
    expect(store.authoredBy(`comment-${made}`)).toBe(annId);
    const view = (await me("GET", "/api/issues/WOR-1")).json;
    expect(view.comments.map((c: { body: string; by?: string }) => [c.body, c.by])).toEqual([["Looks good", undefined], ["Ship it Friday", "Ann"]]);

    // The owner's chat is every admin's: Ann posts there and the conversation shows whose words they were.
    expect((await ann("POST", "/api/issues/WOR-3/comments", { body: "Check the pricing page" })).status).toBe(200);
    const chat = (await me("GET", "/api/chats/WOR-3")).json;
    expect(chat.messages.find((m: { text: string }) => m.text === "Check the pricing page")).toMatchObject({ kind: "owner", by: "Ann" });
    // And her edits go through like the owner's.
    expect((await ann("PATCH", "/api/issues/WOR-1", { title: "Pricing page" })).status).toBe(200);
    expect(writes.at(-1)).toMatchObject({ key: KEY, account: annId, method: "PATCH", body: { title: "Pricing page" } });

    // A typed "approve WOR-1" is only a message now: cards are decided on the kernel's approval page, which stamps the admin
    // (account:<id>). The board names who decided; the owner's own decisions carry no label.
    records.cards.push(card({ id: "A1", issueId: issues[0]!.id, identifier: "WOR-1" }), card({ id: "A2", state: "rejected", decidedBy: `account:${annId}` }), card({ id: "A3", state: "rejected", decidedBy: `account:${owner.id}` }));
    const typed = await ann("POST", "/api/issues/WOR-1/comments", { body: "approve WOR-1" });
    expect(typed.json.approval).toBeUndefined();
    const listed = (await me("GET", "/api/approvals")).json.approvals;
    expect(listed.find((a: { id: string }) => a.id === "A2")).toMatchObject({ state: "rejected", decidedByName: "Ann" });
    expect(listed.find((a: { id: string }) => a.id === "A3").decidedByName).toBeUndefined();
  });
});

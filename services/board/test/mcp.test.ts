// The AidenHQ MCP end to end: a bearer from the (fake) kernel, JSON-RPC over the board's own /mcp, the real route handlers
// behind every tool. Tools act as the account, writes ask the kernel afresh about the bearer, a foreign Origin is refused.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createApp } from "../src/app.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { card, fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel } from "./kernel.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-"));
writeFileSync(join(dir, "paperclip.yaml"), stringify({ settings: { grading: { value: "on", set: false } }, agents: {}, mcp_servers: {}, routines: {} }));
writeFileSync(join(dir, "modules.json"), JSON.stringify([{ name: "core", enabled: true, settings: { grading: { default: "on", values: ["on", "off"] } } }]));
process.env.BOARD_PAPERCLIP_CONFIG = join(dir, "paperclip.yaml");
process.env.BOARD_MODULES_FILE = join(dir, "modules.json");

const CO = "00000000-0000-4000-8000-000000000001";
const KEY = "the-boards-kernel-key";
const chatLabel = { id: "33333333-3333-3333-3333-333333333333", name: "chat", color: "#0ea5e9" };
const issues: Record<string, unknown>[] = [];
const mk = (n: number, extra: Record<string, unknown>) => ({ status: "todo", priority: "medium", createdAt: "2026-11-12T08:00:00.000Z", updatedAt: "2026-11-12T08:00:00.000Z", description: "", id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, identifier: `WOR-${n}`, ...extra });
const agents = [{ id: "aiden", name: "Aiden", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:chief-of-staff" } }];
const fakeFetch = (async (url: URL, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const lane = /^\/v1\/cp\/(read|owner)(\/.*)$/.exec(url.pathname)!;
  const path = lane[2]!;
  const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
  const find = (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref);
  if (method === "POST" && path === `/api/companies/${CO}/issues`) {
    const made = mk(7 + issues.length, { ...JSON.parse(String(init.body)), labels: [chatLabel] });
    issues.push(made);
    return json(made);
  }
  if (method !== "GET") return json({});
  if (path === "/api/cli-auth/me") return json({ userId: "me" });
  if (path === `/api/companies/${CO}`) return json({ issuePrefix: "WOR" });
  if (path === `/api/companies/${CO}/agents`) return json(agents);
  if (path === `/api/companies/${CO}/labels`) return json([chatLabel]);
  if (path === `/api/companies/${CO}/issues`) return json(url.searchParams.get("parentId") ? [] : issues);
  const one = /^\/api\/issues\/([^/]+)$/.exec(path);
  if (one) return find(decodeURIComponent(one[1]!)) ? json(find(decodeURIComponent(one[1]!))) : new Response("{}", { status: 404 });
  return json([]);
}) as typeof fetch;

describe("mcp end to end", () => {
  const owner = { id: "u-owner", email: "owner@example.com", name: "Owner", role: "admin" as const, owner: true };
  const records = fakeRecords([card({ id: "k-0000000000000001", digest: "a".repeat(40) }), card({ id: "k-0000000000000002", digest: "b".repeat(40), identifier: "WOR-2" })]);
  let app: ReturnType<typeof createApp>, port = 0, kernel: Awaited<ReturnType<typeof fakeKernel>>, token = "";
  beforeAll(async () => {
    kernel = await fakeKernel();
    kernel.mcp.digests.set("k-0000000000000001", "a".repeat(40));
    kernel.mcp.digests.set("k-0000000000000002", "c".repeat(40)); // changed since it was read
    token = kernel.mcp.token(owner);
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "https://admin.example.com" });
    app = createApp({ paperclip: new Paperclip("http://paperclip", CO, KEY, fakeFetch), store: new Store(":memory:"), records, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, adminUrl: "https://admin.example.com", allowedHosts: ["board.example.com"], mode: "lan" });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });

  const http = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, any>; json: any }>((resolve, reject) => {
      const h = { host: "board.example.com", "x-forwarded-proto": "https", accept: "application/json, text/event-stream", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
      const r = request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, json: t ? JSON.parse(t) : undefined }));
      });
      r.on("error", reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  let id = 0;
  const rpc = (method: string, params: unknown, bearer: string | null = token, headers: Record<string, string> = {}) =>
    http("POST", "/mcp", { jsonrpc: "2.0", id: ++id, method, params }, { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers });
  const call = (name: string, args: unknown, bearer: string | null = token) => rpc("tools/call", { name, arguments: args }, bearer);

  it("points a client without a bearer at the authorization server", async () => {
    const r = await rpc("tools/list", {}, null);
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toContain('resource_metadata="https://board.example.com/.well-known/oauth-protected-resource"');
    const meta = await http("GET", "/.well-known/oauth-protected-resource");
    expect(meta.json).toMatchObject({ resource: "https://board.example.com/mcp", authorization_servers: ["https://admin.example.com"] });
  });

  it("lists fourteen tools, nine of them read-only, each with an output schema", async () => {
    const { json } = await rpc("tools/list", {});
    const tools = json.result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint?: boolean }; outputSchema: unknown }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["approvals", "apps", "ask", "change_settings", "connect", "costs", "create_task", "decide", "fleet", "get_task", "modules", "status", "tasks", "update_task"]);
    expect(tools.filter((t) => t.annotations.readOnlyHint)).toHaveLength(9);
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort()).toEqual(["change_settings", "decide"]);
    expect(tools.every((t) => t.outputSchema)).toBe(true);
  });

  it("status answers with structured content the schema accepts, and cards come with their digest", async () => {
    const { json } = await call("status", {});
    expect(json.result.isError).toBeFalsy();
    expect(json.result.structuredContent).toMatchObject({ approvals_pending: 2, approvals: [{ id: "k-0000000000000001", digest: "a".repeat(40) }, { id: "k-0000000000000002" }] });
  });

  it("change_settings files a change as the account and says where it stands", async () => {
    const { json } = await call("change_settings", { changes: [{ kind: "setting", key: "grading", value: "off" }] });
    expect(json.result.isError).toBeFalsy();
    expect(json.result.structuredContent).toMatchObject({ task: expect.stringMatching(/^WOR-/), record: "k-0000000000000001", tier: 1, state: "review" });
    expect(records.settings.at(-1)!.changes).toEqual([{ kind: "setting", key: "grading", value: "off" }]);
  });

  it("decide returns one outcome per card: a card that changed fails alone", async () => {
    const { json } = await call("decide", { cards: [{ id: "k-0000000000000001", digest: "a".repeat(40), decision: "approve" }, { id: "k-0000000000000002", digest: "b".repeat(40), decision: "approve" }] });
    const { outcomes } = json.result.structuredContent;
    expect(outcomes[0]).toMatchObject({ id: "k-0000000000000001", ok: true, state: "approved" });
    expect(outcomes[1]).toMatchObject({ ok: false, error: expect.stringContaining("call approvals again") });
    // The kernel was told the bearer, never an account.
    expect(kernel.calls.filter((c) => c.path === "/v1/owner/decide").at(-1)!.body).not.toHaveProperty("by");
  });

  it("refuses a page's cross-origin request, and accepts a CLI with no Origin", async () => {
    expect((await rpc("tools/list", {}, token, { origin: "https://evil.example" })).status).toBe(403);
    expect((await rpc("tools/list", {}, token, { origin: "https://board.example.com" })).status).toBe(200);
    expect((await rpc("tools/list", {})).status).toBe(200);
  });

  it("ask returns the chat id and 'still working' when the agent is silent, and waits no longer than asked", async () => {
    const t0 = Date.now();
    const { json } = await call("ask", { text: "What is on my plate?", wait_seconds: 1 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(json.result.structuredContent).toMatchObject({ chat: expect.stringMatching(/^WOR-/), replied: false, reply: null });
    expect(json.result.content[0].text).toContain("still working");
    // The wait is capped by the schema (the transport stays under Cloudflare's 100 s).
    const ask = (await rpc("tools/list", {})).json.result.tools.find((t: { name: string }) => t.name === "ask");
    expect(ask.inputSchema.properties.wait_seconds).toMatchObject({ maximum: 50, default: 20 });
  });

  it("a revoked grant ends the next write, even inside the read cache's few seconds", async () => {
    const t = kernel.mcp.token(owner);
    expect((await call("status", {}, t)).status).toBe(200); // read: now cached
    kernel.mcp.revoke(t);
    const write = await call("update_task", { id: "WOR-9", action: "stop" }, t);
    expect(write.status).toBe(401);
    expect(write.headers["www-authenticate"]).toContain("invalid_token");
  });

  it("refuses a token minted for another resource", async () => {
    const other = kernel.mcp.token(owner, "Claude Code", "https://other.example.com/mcp");
    expect((await rpc("tools/list", {}, other)).status).toBe(401);
  });

  it("lists an admin's Claude apps on the account routes and revokes one", async () => {
    const cookie = `__Host-aidenhq-board=${kernel.session(owner)}`;
    const get = await http("GET", "/api/accounts/mcp-clients", undefined, { cookie });
    expect(get.json.grants.map((g: { client: string }) => g.client)).toContain("Claude Code");
    const grant = get.json.grants[0].id;
    expect((await http("POST", `/api/accounts/mcp-clients/${grant}/revoke`, {}, { cookie, "x-aidenhq-board": "1", origin: "https://board.example.com" })).json).toEqual({ ok: true });
    expect((await http("GET", "/api/accounts/mcp-clients", undefined, { cookie })).json.grants.map((g: { id: string }) => g.id)).not.toContain(grant);
  });
});

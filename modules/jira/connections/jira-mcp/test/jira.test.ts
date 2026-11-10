import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuthorize } from "../src/agent-auth.js";
import { createApp, NOT_CONNECTED } from "../src/app.js";
import { EXPOSED, READ_TOOLS, SCOPES, WRITE_TOOLS } from "../src/policy.js";
import { SignIn } from "../src/signin.js";
import { TokenStore } from "../src/tokens.js";

const log = pino({ level: "silent" });
const tmp = () => mkdtempSync(join(tmpdir(), "jira-mcp-"));
const listen = async (s: HttpServer) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

// A stub of Atlassian's remote MCP server: Bearer "at" only; two sites; the tools AidenHQ uses plus ones it must hide.
const calls: { name: string; args: Record<string, unknown> }[] = [];
const UPSTREAM_TOOLS = [...EXPOSED, "getAccessibleAtlassianResources", "discover", "executeWrite", "deleteJiraIssue", "editJiraIssue"];
const upstream = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer at") return void res.writeHead(401, { "www-authenticate": "Bearer" }).end();
  const server = new Server({ name: "atlassian", version: "1" }, { capabilities: { tools: {} } });
  // Paginated, 4 tools a page, like ?tools=all.
  server.setRequestHandler(ListToolsRequestSchema, async (r) => {
    const at = Number(r.params?.cursor ?? 0);
    return {
      tools: UPSTREAM_TOOLS.slice(at, at + 4).map((name) => ({ name, description: name, inputSchema: { type: "object" as const, properties: { cloudId: { type: "string" }, jql: { type: "string" } }, required: ["cloudId"] } })),
      ...(at + 4 < UPSTREAM_TOOLS.length ? { nextCursor: String(at + 4) } : {}),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const args = (r.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: r.params.name, args });
    if (r.params.name === "getAccessibleAtlassianResources")
      return { content: [{ type: "text", text: JSON.stringify([{ id: "initech-id", url: "https://initech.atlassian.net", name: "initech" }, { id: "acme-id", url: "https://acme.atlassian.net", name: "acme" }]) }] };
    return { content: [{ type: "text", text: JSON.stringify({ tool: r.params.name, cloudId: args.cloudId }) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => void server.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

// Paperclip's /api/agents/me: the run key names the agent; the grants table gives the Assistant Jira reads only.
const paperclip = createServer((req, res) => {
  const id = { "Bearer assistant-key": "a1", "Bearer writer-key": "w1" }[String(req.headers.authorization)];
  if (!id) return void res.writeHead(401).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, name: id }));
});

let base = "";
let state = "";
let up = "";
let app: HttpServer;

beforeAll(async () => {
  up = await listen(upstream);
  const pc = await listen(paperclip);
  state = tmp();
  const grantsFile = join(tmp(), "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ agents: { a1: { key: "assistant", tools: { jira: READ_TOOLS } }, w1: { key: "writer", tools: { jira: EXPOSED } } } }));
  app = createApp({
    upstreamUrl: `${up}/v2/mcp?tools=all`, siteUrl: "https://acme.atlassian.net", stateDir: state, inboundToken: "pc", authToken: "board", log,
    authorize: makeAuthorize({ connection: "jira", paperclipUrl: pc, grantsFile }),
  });
  base = await listen(app);
});
afterAll(() => { app.close(); upstream.close(); paperclip.close(); });

let id = 0;
async function rpc(method: string, params: unknown, agentKey = "assistant-key") {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer pc", "x-agent-key": agentKey, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return (await res.json()) as { result: { tools?: { name: string; inputSchema: { properties?: object; required?: string[] }; annotations?: object }[]; isError?: boolean; content?: { text: string }[] } };
}
const text = (r: Awaited<ReturnType<typeof rpc>>) => r.result.content?.[0]?.text ?? "";

describe("jira-mcp", () => {
  it("names the same tools as modules/jira/module.yaml", () => {
    const yaml = readFileSync(join(__dirname, "../../../module.yaml"), "utf8");
    const list = (k: string) => new RegExp(`${k}: \\[([^\\]]*)\\]`).exec(yaml)![1]!.split(",").map((s) => s.trim()).filter(Boolean);
    expect(list("read")).toEqual(READ_TOOLS);
    expect(list("write")).toEqual(WRITE_TOOLS);
  });

  it("not signed in: starts, lists the tools, and every call says how to connect", async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ ok: false, state: "missing" });
    expect((await rpc("tools/list", {})).result.tools!.map((t) => t.name)).toEqual(EXPOSED);
    const r = await rpc("tools/call", { name: "searchJiraIssuesUsingJql", arguments: { jql: "project = POS" } });
    expect(r.result.isError).toBe(true);
    expect(text(r)).toBe(NOT_CONNECTED);
    const status = await fetch(`${base}/auth/status`, { headers: { authorization: "Bearer board" } });
    expect(await status.json()).toMatchObject({ configured: true, state: "missing" });
    expect((await fetch(`${base}/auth/status`)).status).toBe(401);
  });

  it("signed in: exposes only Jira/Confluence tools without cloudId, and pins calls to the configured site", async () => {
    writeFileSync(join(state, "token.json"), JSON.stringify({ access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3_600_000, client_id: "c", token_endpoint: `${up}/token` }));
    const tools = (await rpc("tools/list", {})).result.tools!;
    expect(tools.map((t) => t.name)).toEqual(EXPOSED);
    for (const t of tools) {
      expect(t.inputSchema.properties).not.toHaveProperty("cloudId");
      expect(t.inputSchema.required ?? []).not.toContain("cloudId");
    }
    expect(tools.find((t) => t.name === "getJiraIssue")!.annotations).toMatchObject({ readOnlyHint: true });

    // An agent-supplied cloudId (another site) is overwritten with Acme's.
    const r = await rpc("tools/call", { name: "listJiraIssueChangelogs", arguments: { issueIdOrKey: "POS-1", cloudId: "initech-id" } });
    expect(JSON.parse(text(r))).toEqual({ tool: "listJiraIssueChangelogs", cloudId: "acme-id" });
    expect(calls.at(-1)).toEqual({ name: "listJiraIssueChangelogs", args: { issueIdOrKey: "POS-1", cloudId: "acme-id" } });
  });

  it("refuses hidden upstream tools (gateway, delete) even for an agent granted them by name", async () => {
    for (const name of ["discover", "executeWrite", "deleteJiraIssue", "getAccessibleAtlassianResources"]) {
      const r = await rpc("tools/call", { name, arguments: {} }, "writer-key");
      expect(r.result.isError).toBe(true);
    }
  });

  it("refuses a write tool to an agent granted only reads (agent-auth), and allows it with a grant", async () => {
    const before = calls.length;
    const r = await rpc("tools/call", { name: "addOrEditJiraIssueComment", arguments: { issueIdOrKey: "POS-1", body: "hi" } });
    expect(text(r)).toMatch(/assistant isn't granted addOrEditJiraIssueComment on jira/);
    expect(calls.length).toBe(before);
    const ok = await rpc("tools/call", { name: "addOrEditJiraIssueComment", arguments: { issueIdOrKey: "POS-1", body: "hi" } }, "writer-key");
    expect(JSON.parse(text(ok))).toMatchObject({ tool: "addOrEditJiraIssueComment", cloudId: "acme-id" });
    // No key at all: refused.
    expect(text(await rpc("tools/call", { name: "getJiraIssue", arguments: {} }, ""))).toMatch(/^Refused/);
  });
});

describe("sign-in", () => {
  it("follows Atlassian's discovery (v2 resource → per-resource auth server), asks only our scopes, token for the bare resource", async () => {
    const AS = "https://auth.atlassian.com/abc";
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url === "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp")
        return Response.json({ resource: "https://mcp.atlassian.com/v2/mcp", authorization_servers: [AS], scopes_supported: ["read:me", "offline_access", "read:jira:agent-interface", "write:jira:agent-interface", "delete:jira:agent-interface", "search:jira:agent-interface", "read:bitbucket:agent-interface"] });
      if (url === "https://auth.atlassian.com/.well-known/oauth-authorization-server/abc")
        return Response.json({ issuer: AS, authorization_endpoint: "https://auth.atlassian.com/authorize", token_endpoint: "https://auth.atlassian.com/oauth/token", registration_endpoint: `${AS}/dcr/register` });
      if (url === `${AS}/dcr/register`) return Response.json({ client_id: "cid" }, { status: 201 });
      if (url === "https://auth.atlassian.com/oauth/token") return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const dir = tmp();
    const tokens = new TokenStore(join(dir, "token.json"));
    const signIn = new SignIn("https://mcp.atlassian.com/v2/mcp?tools=all", join(dir, "client.json"), tokens, fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/jira/callback");
    const q = new URL(url).searchParams;
    expect(q.get("resource")).toBe("https://mcp.atlassian.com/v2/mcp");
    expect(q.get("scope")!.split(" ").sort()).toEqual(["offline_access", "read:jira:agent-interface", "read:me", "search:jira:agent-interface"]);
    for (const s of q.get("scope")!.split(" ")) expect(SCOPES).toContain(s);
    await signIn.finish(q.get("state")!, "code");
    expect(JSON.parse(readFileSync(join(dir, "token.json"), "utf8"))).toMatchObject({ access_token: "at", refresh_token: "rt", client_id: "cid", token_endpoint: "https://auth.atlassian.com/oauth/token", resource: "https://mcp.atlassian.com/v2/mcp" });
    expect(tokens.status().state).toBe("ok");
  });
});

describe("the site check reads Atlassian's real reply", () => {
  it("finds the cloudId under data.resources (Atlassian's shape, 2026-11)", async () => {
    const { siteCloudId } = await import("../src/policy.js");
    const text = JSON.stringify({ data: { resources: [{ cloudId: "fdd7", url: "https://acme.atlassian.net", products: [{ id: "jira", access: "read-only" }] }] } });
    expect(siteCloudId({ content: [{ type: "text", text }] }, "https://acme.atlassian.net")).toBe("fdd7");
    expect(siteCloudId({ content: [{ type: "text", text }] }, "https://initech.atlassian.net")).toBeUndefined();
  });
});

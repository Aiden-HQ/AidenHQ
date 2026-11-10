// Run identity and grants (services/shared/agent-auth.ts, copied here): the helper on its own, then github-mcp's real
// /mcp handler refusing a read-only agent's write.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuthorize } from "../src/agent-auth.js";

const READS = ["github_whoami", "github_issue_read", "github_search_issues"];
let paperclip: Server;
let paperclipUrl = "";
let launcher: Server;
let launcherUrl = "";
const liveRunTokens = new Map([["ahqc_live", "id-scout"]]);
const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
writeFileSync(grants, JSON.stringify({ agents: {
  "id-scout": { key: "open-loops", roles: [], tools: { github: READS } },
  "id-assistant": { key: "assistant", roles: [], tools: { github: [...READS, "github_issue_comment"] } },
} }));

beforeAll(async () => {
  // Paperclip's /api/agents/me: which agent a key belongs to.
  const who: Record<string, { id: string; name: string }> = { "key-scout": { id: "id-scout", name: "Open Loops" }, "key-assistant": { id: "id-assistant", name: "Assistant" }, "key-stranger": { id: "id-x", name: "Stranger" } };
  paperclip = createServer((req, res) => {
    const a = who[String(req.headers.authorization).replace("Bearer ", "")];
    res.writeHead(a ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(a ?? { error: "no" }));
  });
  await new Promise<void>((r) => paperclip.listen(0, "127.0.0.1", r));
  paperclipUrl = `http://127.0.0.1:${(paperclip.address() as { port: number }).port}`;
  // The computer launcher's /whoami: which agent a run token (issued per run inside an agent computer) belongs to.
  launcher = createServer((req, res) => {
    const id = liveRunTokens.get(String(req.headers.authorization).replace("Bearer ", ""));
    res.writeHead(id ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(id ? { agentId: id } : { error: "no" }));
  });
  await new Promise<void>((r) => launcher.listen(0, "127.0.0.1", r));
  launcherUrl = `http://127.0.0.1:${(launcher.address() as { port: number }).port}`;
});
afterAll(() => { paperclip.close(); launcher.close(); });

const req = (key?: string) => ({ headers: key ? { "x-agent-key": key } : {} }) as unknown as IncomingMessage;
const call = (name: string, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
const text = (v: { ok: boolean; body?: unknown }) => JSON.stringify((v as { body: unknown }).body);

describe("authorize", () => {
  const auth = () => makeAuthorize({ connection: "github", paperclipUrl, grantsFile: grants });
  it("lets the handshake and tool listing through without a key", async () => {
    expect((await auth()(req(), [{ jsonrpc: "2.0", id: 1, method: "initialize" }, { jsonrpc: "2.0", method: "notifications/initialized" }])).ok).toBe(true);
    expect((await auth()(req(), { jsonrpc: "2.0", id: 2, method: "tools/list" })).ok).toBe(true);
  });
  it("passes a granted tool and refuses one outside the grant", async () => {
    const a = auth();
    const ok = await a(req("key-scout"), call("github_issue_read"));
    expect(ok).toMatchObject({ ok: true, caller: { key: "open-loops", id: "id-scout" } });
    const no = await a(req("key-scout"), call("github_issue_comment", 7));
    expect(no).toMatchObject({ ok: false, status: 200, body: { id: 7, result: { isError: true } } });
    expect(text(no)).toContain("open-loops isn't granted github_issue_comment on github");
    expect((await a(req("key-assistant"), call("github_issue_comment"))).ok).toBe(true);
  });
  it("refuses a batch that hides a refused call behind a listing", async () => {
    const v = await auth()(req("key-scout"), [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, call("github_issue_comment", 2)]);
    expect(v.ok).toBe(false);
    expect((v as { body: unknown[] }).body).toHaveLength(2);
  });
  it("fails closed: no key, unknown key, an agent without grants, no table, no connection name", async () => {
    expect(text(await auth()(req(), call("github_whoami")))).toContain("no agent key");
    expect(text(await auth()(req("forged"), call("github_whoami")))).toContain("rejected by Paperclip (401)");
    expect(text(await auth()(req("key-stranger"), call("github_whoami")))).toContain("Stranger has no grants");
    expect(text(await makeAuthorize({ connection: "github", paperclipUrl, grantsFile: "/nonexistent/grants.json" })(req("key-scout"), call("github_whoami")))).toContain("grants are not set up yet");
    expect(text(await makeAuthorize({ connection: "", paperclipUrl, grantsFile: grants })(req("key-scout"), call("github_whoami")))).toContain("connection name");
  });
  it("resolves a computer's run token through the launcher, uncached, and refuses it once revoked", async () => {
    const a = makeAuthorize({ connection: "github", paperclipUrl, grantsFile: grants, launcherUrl });
    expect(await a(req("ahqc_live"), call("github_issue_read"))).toMatchObject({ ok: true, caller: { key: "open-loops", id: "id-scout" } });
    expect(text(await a(req("ahqc_live"), call("github_issue_comment")))).toContain("open-loops isn't granted github_issue_comment");
    liveRunTokens.delete("ahqc_live");
    expect(text(await a(req("ahqc_live"), call("github_issue_read")))).toContain("run token rejected by the computer launcher (401)");
    expect(text(await auth()(req("ahqc_other"), call("github_issue_read")))).toContain("doesn't know where the computer launcher is");
  });
  it("never treats a missing agent key as the host: dropping the header doesn't skip grants", async () => {
    expect(text(await auth()(req(), call("github_issue_comment")))).toContain("no agent key");
  });
});

describe("github-mcp over HTTP", () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const post = async (key: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-agent-key": key }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { result?: { isError?: boolean; content?: { text: string }[] } } };
  };
  beforeAll(async () => {
    Object.assign(process.env, { PORT: String(port), AIDENHQ_CONNECTION: "github", PAPERCLIP_URL: paperclipUrl, AIDENHQ_GRANTS_FILE: grants, GITHUB_TOKEN_FILE: "/nonexistent/github_token", LOG_LEVEL: "silent" });
    await import("../src/main.js");
    await new Promise((r) => setTimeout(r, 200));
  });

  it("refuses a read-only agent's write, and lets its read reach GitHub", async () => {
    const refused = await post("key-scout", { ...call("github_issue_comment"), params: { name: "github_issue_comment", arguments: { url: "o/r#1", body: "hi" } } });
    expect(refused.status).toBe(200);
    expect(refused.body.result?.isError).toBe(true);
    expect(refused.body.result?.content?.[0]?.text).toBe("Refused: open-loops isn't granted github_issue_comment on github.");
    // A granted read passes the check and fails only at GitHub (no token here): proof it got past authorize.
    const read = await post("key-scout", call("github_whoami"));
    expect(read.body.result?.content?.[0]?.text).toContain("github_auth_unavailable");
  });
});

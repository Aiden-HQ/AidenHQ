// The kernel clears a connection's down state only on an answer marked as served by its sign-in (vendor/needs.ts SIGNED_IN).
// The mark is `_meta` on the tool's result: it must reach the client through McpServer.registerTool, as main.ts's tools answer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "bun:test";
import { servedSignedIn, signedIn } from "../src/vendor/needs.js";

it("a registered tool's signed-in mark reaches the client; an unmarked success (github_issue_link) carries none", async () => {
  const server = new McpServer({ name: "t", version: "0" });
  server.registerTool("read", { inputSchema: {} }, async () => signedIn({ content: [{ type: "text" as const, text: "ok" }], structuredContent: { _aidenhq: { objects: [] } } }));
  server.registerTool("link", { inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "https://github.com/o/r/issues/new" }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  expect(servedSignedIn(await client.callTool({ name: "read", arguments: {} }))).toBe(true);
  expect(servedSignedIn(await client.callTool({ name: "link", arguments: {} }))).toBe(false);
  await client.close();
});

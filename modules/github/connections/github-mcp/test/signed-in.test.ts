// The kernel clears a connection's down state only on an answer marked as served by its sign-in (vendor/needs.ts SIGNED_IN),
// and clears an org's sso/restricted rows only for the orgs that answer proved (PROVED_ORGS). The marks are `_meta` on the
// tool's result: they must reach the client through McpServer.registerTool, as main.ts's tools answer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import { provedOrgs, servedSignedIn, signedIn } from "../src/vendor/needs.js";

it("a registered tool's signed-in mark reaches the client; an unmarked success (github_issue_link) carries none", async () => {
  const server = new McpServer({ name: "t", version: "0" });
  server.registerTool("read", { inputSchema: {} }, async () => signedIn({ content: [{ type: "text" as const, text: "ok" }], structuredContent: { _aidenhq: { objects: [] } } }, { orgs: ["acme"] }));
  server.registerTool("link", { inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "https://github.com/o/r/issues/new" }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const read = await client.callTool({ name: "read", arguments: {} });
  expect(servedSignedIn(read)).toBe(true);
  expect(provedOrgs(read)).toEqual(["acme"]);
  const link = await client.callTool({ name: "link", arguments: {} });
  expect(servedSignedIn(link)).toBe(false);
  expect(provedOrgs(link)).toEqual([]);
  await client.close();
});

it("PROVED_ORGS is set only when the call proved an org, never as an empty list", () => {
  expect(signedIn({ content: [] }, { orgs: [] })._meta).toEqual({ "aidenhq/signed_in": true });
  expect(signedIn({ content: [] }, { account: "a@x.com", orgs: ["a", "b"] })._meta).toEqual({ "aidenhq/signed_in": "a@x.com", "aidenhq/proved_orgs": ["a", "b"] });
});

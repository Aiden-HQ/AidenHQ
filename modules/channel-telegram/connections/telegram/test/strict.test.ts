import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { buildServer } from "../src/mcp.js";
import { openStore } from "../src/store.js";

it("a misspelled field is an error the agent sees, never silently dropped (the Architect once sent \"questions:\")", async () => {
  const server = buildServer(openStore(":memory:"), { cooldownMs: 0 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const r = await client.callTool({ name: "notify_owner", arguments: { text: "hi", priority: "normal", channel: "board", "questions:": [] } });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toMatch(/questions:/);
});


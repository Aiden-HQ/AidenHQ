import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { buildServer } from "../src/mcp.js";
import { openStore } from "../src/store.js";

it("slack_owner returns the paired owner's id, and null before anyone pairs", async () => {
  const cfg = { botToken: "", ownerId: "", cooldownMs: 0 };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(openStore(":memory:"), cfg).connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const owner = async () => JSON.parse(((await client.callTool({ name: "slack_owner", arguments: {} })).content as { text: string }[])[0]!.text);
  expect(await owner()).toEqual({ user_id: null });
  cfg.ownerId = "U1";
  expect(await owner()).toEqual({ user_id: "U1" });
});

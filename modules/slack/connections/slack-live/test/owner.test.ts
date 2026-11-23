import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { buildServer } from "../src/mcp.js";
import { ownerReader } from "../src/signin.js";
import { openStore } from "../src/store.js";

it("slack_owner returns the sign-in's user id (from slack-mcp) without a bot, the paired account once paired, null before either", async () => {
  let signedIn = false;
  const seen: string[] = [];
  const fakeMcp = (async (url: string, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
    return signedIn ? new Response(JSON.stringify({ user_id: "U1", team_id: "T1" })) : new Response("{}", { status: 409 });
  }) as typeof fetch;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cfg = { botToken: "", ownerId: "" };
  await buildServer(openStore(":memory:"), cfg, ownerReader("http://slack-mcp:8082", "k", fakeMcp)).connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const owner = async () => JSON.parse(((await client.callTool({ name: "slack_owner", arguments: {} })).content as { text: string }[])[0]!.text);
  expect(await owner()).toEqual({ user_id: null });
  signedIn = true;
  expect(await owner()).toEqual({ user_id: "U1" });
  expect(seen[0]).toBe("http://slack-mcp:8082/internal/owner Bearer k");
  cfg.ownerId = "U2"; // paired: the bot's owner decides (/aiden, a bound thread's "forget")
  expect(await owner()).toEqual({ user_id: "U2" });
});

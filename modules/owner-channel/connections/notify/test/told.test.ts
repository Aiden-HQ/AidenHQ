// The ledger of what the owner was told: written once per message that reached them or waits for the digest; notify_recent reads it.
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { queueBatch } from "../src/attention.js";
import { buildServer } from "../src/mcp.js";
import { notify, retry, type Deps } from "../src/notify.js";
import { openStore } from "../src/store.js";

it("delivered, queued and retried messages are in notify_recent; dropped ones are not", async () => {
  let up = true;
  const d: Deps = {
    store: openStore(":memory:"),
    transports: ["slack"],
    send: async () => { if (!up) throw new Error("down"); return { sent: true }; },
    attention: { mode: "observe", blocked: ["muted"], dailyCap: 40, digestHours: [9], timezone: "UTC" },
  };
  const who = (key: string) => ({ id: key, name: key, key, assertion: "jwt", roles: [] as string[] });
  await notify(d, { kind: "alert", text: "Prod is down", task: "WOR-1" }, who("ops")); // delivered
  await notify(d, { kind: "alert", text: "Prod is down", task: "WOR-1" }, who("ops")); // duplicate: nothing
  await notify(d, { kind: "fyi", text: "Routine news" }, who("scout")); // digest: queued
  await notify(d, { kind: "fyi", text: "Silenced" }, who("muted")); // blocked: nothing
  queueBatch(d.store, d.attention!, { text: "Kernel batch line" }); // kernel digest line: queued
  up = false;
  await notify(d, { kind: "alert", text: "Later news", dedupe_key: "k" }, who("late")); // waits for a channel: nothing yet
  expect(d.store.recentTold(3, 50)).toHaveLength(3);
  up = true;
  await retry(d);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(d).connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  const r = await client.callTool({ name: "notify_recent", arguments: {} });
  const rows = JSON.parse((r.content as { text: string }[])[0]!.text) as { source: string; task: string | null; kind: string; state: string; text: string }[];
  expect(rows.map((x) => [x.source, x.task, x.kind, x.state, x.text])).toEqual([
    ["late", null, "alert", "delivered", "Later news"],
    ["kernel", null, "fyi", "queued", "Kernel batch line"],
    ["scout", null, "fyi", "queued", "Routine news"],
    ["ops", "WOR-1", "alert", "delivered", "Prod is down"],
  ]);
});

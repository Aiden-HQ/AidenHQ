// The ledger of what the owner was told: written once per message that reached them or waits for the digest; notify_recent reads it.
import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { flushDigest, queueDigest } from "../src/attention.js";
import { buildServer } from "../src/mcp.js";
import { notify, retry, type Deps } from "../src/notify.js";
import { openStore } from "../src/store.js";
import { verifyCaller } from "../src/aidenhq-sdk/caller.js";

it("delivered, queued and retried messages are in notify_recent; dropped ones are not", async () => {
  let up = true;
  const d: Deps = {
    store: openStore(":memory:"),
    transports: ["slack"],
    send: async () => { if (!up) throw new Error("down"); return { sent: true }; },
    attention: { timezone: "UTC" },
  };
  const who = (key: string) => ({ id: key, name: key, key, assertion: "jwt", roles: [] as string[] });
  await notify(d, { kind: "alert", text: "Prod is down", task: "WOR-1" }, who("ops")); // delivered
  await notify(d, { kind: "alert", text: "Prod is down", task: "WOR-1" }, who("ops")); // duplicate: nothing
  await notify(d, { kind: "fyi", text: "Routine news" }, who("scout")); // digest: queued
  queueDigest(d.store, { agent: "AidenHQ", text: "Kernel batch line", source: "kernel", kind: "fyi" }); // kernel digest line: queued
  up = false;
  await notify(d, { kind: "alert", text: "Later news", dedupe_key: "k" }, who("late")); // waits for a channel: nothing yet
  expect(d.store.recentTold(3, 50)).toHaveLength(1); // only "Prod is down": digest lines are told when their digest goes
  up = true;
  await retry(d);
  await retry(d); // nothing left to send again

  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(d).connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  const recent = async () => {
    const r = await client.callTool({ name: "notify_recent", arguments: {} });
    const rows = JSON.parse((r.content as { text: string }[])[0]!.text) as { source: string; task: string | null; kind: string; state: string; text: string }[];
    return rows.map((x) => [x.source, x.task, x.kind, x.state, x.text.split("\n")[1]]);
  };
  const fenced = (x: string) => x;
  expect((await recent()).sort()).toEqual([
    ["kernel", null, "fyi", "queued", fenced("Kernel batch line")],
    ["late", null, "alert", "delivered", fenced("Later news")],
    ["ops", "WOR-1", "alert", "delivered", fenced("Prod is down")],
    ["scout", null, "fyi", "queued", fenced("Routine news")],
  ]);
  // Delivered only, a page at a time back through `before`.
  const page = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: "notify_recent", arguments: args })).content as { text: string }[])[0]!.text) as { source: string; cursor: string }[];
  const first = await page({ state: "delivered", limit: 1 });
  expect(first.map((r) => r.source)).toEqual(["late"]);
  expect((await page({ state: "delivered", limit: 1, before: first[0]!.cursor })).map((r) => r.source)).toEqual(["ops"]);

  // The digest goes: its lines leave the queue and enter the ledger, each as delivered with its own sender.
  const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(10, 0, 0, 0);
  expect(await flushDigest(d.store, d.attention!, async () => true, tomorrow.getTime())).toBe(true);
  expect((await recent()).map((r) => [r[0], r[3], r[4]]).sort()).toEqual([
    ["kernel", "delivered", "Kernel batch line"],
    ["late", "delivered", "Later news"],
    ["ops", "delivered", "Prod is down"],
    ["scout", "delivered", "Routine news"],
  ]);
});

it("a question keeps its options whole; long context is clipped, not the questions", async () => {
  const d: Deps = { store: openStore(":memory:"), transports: ["slack"], send: async () => ({ sent: true }) };
  await notify(d, { kind: "decision", text: "x".repeat(3000), questions: [{ question: "Ship it?", options: ["Yes", "No"] }] }, { id: "c", key: "cos", assertion: "j", roles: ["fleet-admin"] });
  const [row] = d.store.recentTold(3, 5);
  expect(Array.from(row!.text).length).toBeLessThanOrEqual(1500);
  expect(row!.text).toContain("Ship it?");
  expect(row!.text).toContain("B) No");
});

it("the board's Home reads notify_recent as the owner (the kernel's view route: kind owner, no agent)", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${b64({ alg: "EdDSA", kid: "k" })}.${b64({ agent: "", key: "", name: "owner", roles: [], tool: "owner_channel.notify_recent", aud: "owner-channel", kind: "owner", exp: Math.floor(Date.now() / 1000) + 60 })}`;
  const jwt = `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
  const caller = await verifyCaller({ headers: { "x-aidenhq-caller": jwt } }, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k" }] }, "owner-channel");
  const d: Deps = { store: openStore(":memory:"), transports: ["slack"], send: async () => ({ sent: true }) };
  await notify(d, { kind: "done", text: "Shipped the fix", task: "WOR-2" }, { id: "a1", name: "Tess", key: "open-loops", assertion: "j", roles: [] });
  // As main.ts builds it for this caller.
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(d, { id: caller.agent, name: caller.name, key: caller.key, roles: caller.roles, assertion: jwt }).connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  const r = await client.callTool({ name: "notify_recent", arguments: { state: "delivered", limit: 50, days: 1 } });
  expect(r.isError).toBeFalsy();
  expect((JSON.parse((r.content as { text: string }[])[0]!.text) as { source: string; task: string }[]).map((x) => [x.source, x.task])).toEqual([["open-loops", "WOR-2"]]);
});

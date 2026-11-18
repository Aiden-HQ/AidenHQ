// An agent in trial ("draft, don't do") reaches the owner only: notify_owner can't be pointed at another conversation.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/mcp.js";
import { openStore } from "../src/store.js";

afterEach(() => vi.unstubAllGlobals());

async function server(trial: boolean) {
  const s = buildServer(openStore(":memory:"), { cooldownMs: 0, telegramToken: "t", telegramChatId: "1" }, { id: "ag-aria", name: "Aria", key: "aria", assertion: "jwt" }, trial);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { type: string; text: string }[])[0]!.text);
  return { call };
}

/** Every fetch URL, with a Slack/Telegram-shaped OK answer. */
function recorder(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch);
  return urls;
}

describe("notify_owner in trial: the owner, and nothing that points elsewhere", () => {
  const fake = recorder;
  it("sends the plain message to the owner", async () => {
    const urls = fake();
    const { call } = await server(true);
    expect(await call("notify_owner", { text: "Done: the draft is in.", priority: "normal" })).toMatchObject({ sent: true });
    expect(urls.some((u) => u.includes("api.telegram.org"))).toBe(true);
  });
  it("refuses a message or thread elsewhere, and sends nothing", async () => {
    const urls = fake();
    const { call } = await server(true);
    for (const args of [
      { channel_id: "C0123ABCD" },
      { thread_ts: "1.0" },
      { ts: "1.1" },
      { permalink: "https://acme.slack.com/archives/C0123ABCD/p1700000000000100" },
      // `task` routes the message into that task's chat, so it is not the owner alone.
      { task: "WOR-42" },
    ]) {
      const r = await call("notify_owner", { text: "x", priority: "urgent", ...args });
      expect(r).toMatchObject({ sent: false });
      expect(String(r.reason)).toMatch(/reaches only the owner/);
    }
    expect(urls).toEqual([]);
  });
  it("outside trial the same arguments reach the owner as before", async () => {
    const urls = fake();
    const { call } = await server(false);
    const r = await call("notify_owner", { text: "x", priority: "normal", channel_id: "C0123ABCD", thread_ts: "1.0" });
    expect(r).toMatchObject({ sent: true });
    expect(urls.some((u) => u.includes("api.telegram.org"))).toBe(true);
    // And a task reply reaches notify_owner itself, not the trial guard (no board bridge is set up here, so it sends nothing).
    expect(await call("notify_owner", { text: "y", priority: "normal", task: "WOR-42", channel: "board" })).toEqual({ sent: false, reason: "error" });
  });
});

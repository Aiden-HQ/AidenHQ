import { expect, it } from "vitest";
import { relayOutbox } from "../src/urgent.js";

it("the outbox relay sends each handed-over message as the owner's Slack DM, and hands a failed one back to Telegram", async () => {
  const dms: { channel: string; text: string }[] = [], back: string[] = [];
  let ok = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => (dms.push(JSON.parse(init.body)), new Response(JSON.stringify({ ok })))) as never;
  try {
    const cfg = { botToken: "xoxb", ownerId: "U1", cooldownMs: 0 };
    expect(await relayOutbox(cfg, async () => [{ text: "*Aiden* · WOR-9\nPR merged" }], async (t) => void back.push(t))).toBe(1);
    expect(dms[0]).toMatchObject({ channel: "U1" });
    expect(dms[0]!.text).toContain("PR merged");
    ok = false;
    expect(await relayOutbox(cfg, async () => [{ text: "deploy done" }], async (t) => void back.push(t))).toBe(0);
    expect(back).toEqual(["deploy done"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

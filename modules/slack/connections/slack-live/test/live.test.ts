import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toEvent } from "../src/map.js";
import { openStore } from "../src/store.js";
import { transportSend } from "../src/send.js";

afterEach(() => vi.unstubAllGlobals());

describe("slack-live-mcp", () => {
  it("stores a redelivered envelope once", () => {
    const { payload } = JSON.parse(readFileSync(new URL("./fixtures/events_api-message.json", import.meta.url), "utf8"));
    const store = openStore(":memory:");
    const e = toEvent(payload)!;
    expect(e.permalink).toBe("https://slack.com/archives/C0FAKECH01/p1700000000000100");
    expect(store.insertEvent(e)).toBe(true);
    expect(store.insertEvent(toEvent(payload)!)).toBe(false);
    expect(store.takePending(10)).toHaveLength(1);
  });

  it("the transport: a DM to the paired owner, an alert as a STOP page; off until a bot and an owner are set up", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await transportSend({ botToken: "", ownerId: "U1" }, { kind: "done", text: "x" })).toEqual({ sent: false, off: true });
    const cfg = { botToken: "xoxb-test", ownerId: "U1" };
    expect(await transportSend(cfg, { kind: "done", text: "**PR merged** <@U9>", head: { agent: "Aiden", task: "WOR-9", issue: "i9" } })).toEqual({ sent: true });
    expect(await transportSend(cfg, { kind: "alert", text: "[C1] prod down" })).toEqual({ sent: true });
    const [dm, page] = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]!.body)));
    expect(dm).toMatchObject({ channel: "U1", text: "*Aiden* · WOR-9\n*PR merged* &lt;@U9&gt;" });
    expect(page.blocks[0].text.text).toMatch(/STOP/);
    expect(page.blocks[1].text.text).toBe("<#C1> · prod down");
  });
});

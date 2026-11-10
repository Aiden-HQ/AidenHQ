import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toEvent } from "../src/map.js";
import { openStore } from "../src/store.js";
import { notifyOwner } from "../src/urgent.js";

afterEach(() => vi.unstubAllGlobals());

describe("slack-live-mcp", () => {
  it("stores a redelivered envelope once", () => {
    const { payload } = JSON.parse(readFileSync(new URL("./fixtures/events_api-message.json", import.meta.url), "utf8"));
    const store = openStore(":memory:");
    const e = toEvent(payload, new Set())!;
    expect(e.permalink).toBe("https://slack.com/archives/C0FAKECH01/p1700000000000100");
    expect(store.insertEvent(e)).toBe(true);
    expect(store.insertEvent(toEvent(payload, new Set())!)).toBe(false);
    expect(store.takePending(10)).toHaveLength(1);
  });

  it("urgent DMs: one per thread per 60 min unless the text re-escalates", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    const cfg = { botToken: "xoxb-test", ownerId: "U1", cooldownMs: 60 * 60_000 };
    const thread = { priority: "urgent" as const, channel_id: "C1", ts: "1.1", thread_ts: "1.0" };
    expect(await notifyOwner(store, cfg, { ...thread, text: "[C1] db is slow" })).toEqual({ sent: true });
    expect(await notifyOwner(store, cfg, { ...thread, text: "[C1] db is slow again" })).toEqual({ sent: false, reason: "cooldown" });
    expect(await notifyOwner(store, cfg, { ...thread, text: "[C1] prod down" })).toEqual({ sent: true });
    expect(fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]).includes("chat.postMessage"))).toHaveLength(2);
  });
});

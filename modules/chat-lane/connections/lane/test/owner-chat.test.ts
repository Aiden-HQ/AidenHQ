// The lane's bots answer only the chat channel-telegram paired: asked from its /owner-chat, the last answer kept.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "bun:test";
import { followOwnerChat } from "../src/lane/serve.js";

describe("owner chat", () => {
  it("follows the paired chat and keeps the last one when channel-telegram is down", async () => {
    let chat: string | null = "42";
    const srv = http.createServer((req, res) => res.writeHead(req.url === "/owner-chat" ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ chat_id: chat })));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const kv = new Map<string, string>();
    const log = { info: () => {}, warn: () => {} } as never;
    const o = followOwnerChat({ telegramUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, getKv: (k) => kv.get(k), setKv: (k, v) => void kv.set(k, v), log });
    await o.refresh();
    expect(o.current()).toBe("42");
    chat = "77"; // re-paired
    await o.refresh();
    expect(o.current()).toBe("77");
    await new Promise<void>((r) => srv.close(() => r()));
    await o.refresh();
    expect(o.current()).toBe("77");
  });
});

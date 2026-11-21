import { connect, type AddressInfo } from "node:net";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";

const status = (port: number, target: string) =>
  new Promise<number>((resolve) => {
    const c = connect(port, "127.0.0.1", () => c.write(`GET ${target} HTTP/1.1\r\nHost: localhost:3120\r\nConnection: close\r\n\r\n`));
    let d = "";
    c.on("data", (x) => (d += x)).on("close", () => resolve(Number(d.split(" ")[1])));
  });

describe("request targets the URL parser rejects", () => {
  it("get 400 and the listener keeps serving", async () => {
    const work = { job: async () => null, task: async () => [], agent: async () => [], activity: async () => ({ running: [], recent: [], queued: [], parked: [], failing: [] }), stop: async () => [] };
    const app = createApp({ work, paperclip: {} as never, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => null });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const port = (app.address() as AddressInfo).port;
    for (const target of ["//[", "http://[::1", "//"]) expect(await status(port, target)).toBe(400);
    expect(await status(port, "/healthz")).toBe(200);
    app.close();
  });
});

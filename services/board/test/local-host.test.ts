import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// A board a browser opens at 127.0.0.1 moves to localhost before sign-in (the sign-in's own origin); anything else, a health
// check or probe included, is left alone.
const serve = (adminUrl: string) =>
  createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", adminUrl, allowedHosts: ["localhost:3121", "127.0.0.1:3121"], mode: "lan", session: () => ({ accountId: "o", role: "admin" as const }) });
const get = (app: ReturnType<typeof serve>, host: string, path = "/x?y=1", nav = true) =>
  new Promise<{ status: number; location?: string }>((resolve, reject) => {
    app.listen(0, "127.0.0.1", () => {
      const r = request(`http://127.0.0.1:${(app.address() as AddressInfo).port}${path}`, { headers: { host, ...(nav ? { "sec-fetch-mode": "navigate" } : {}) } }, (res) => { res.resume(); res.on("end", () => { app.close(); resolve({ status: res.statusCode!, location: res.headers.location }); }); });
      r.on("error", reject);
      r.end();
    });
  });

it("redirects a 127.0.0.1 page to localhost in local mode only", async () => {
  expect(await get(serve("http://localhost:3120"), "127.0.0.1:3121")).toEqual({ status: 308, location: "http://localhost:3121/x?y=1" });
  expect((await get(serve("https://admin.example.com"), "127.0.0.1:3121")).status).not.toBe(308);
  expect((await get(serve("http://localhost:3120"), "localhost:3121")).status).not.toBe(308);
  expect((await get(serve("http://localhost:3120"), "127.0.0.1:3121", "/x?y=1", false)).status).not.toBe(308);
});

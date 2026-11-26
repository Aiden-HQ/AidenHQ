// GET /api/faces/<key>: a module-shipped face, served only signed in, sandboxed (no script runs if opened directly), and only
// for a plain key (no path escapes the faces folder).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const root = mkdtempSync(join(tmpdir(), "faces-"));
const dir = join(root, "faces");
mkdirSync(dir);
writeFileSync(join(dir, "acme-bot.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
writeFileSync(join(root, "secret.svg"), "<svg/>");
process.env.BOARD_FACES_DIR = dir;

let signedIn = true;
const work = { job: async () => null, task: async () => [], agent: async () => [], activity: async () => ({ running: [], recent: [], queued: [], parked: [], failing: [] }), stop: async () => [] };
const app = createApp({ work, paperclip: { agents: async () => [] } as unknown as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => (signedIn ? { accountId: "owner", role: "admin" as const } : null) });
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  port = (app.address() as AddressInfo).port;
});
afterAll(() => app.close());
const get = (path: string) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: "localhost:3120", "x-aidenhq-board": "1" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });

it("serves a shipped face sandboxed, signed in only, and nothing outside the faces folder", async () => {
  const ok = await get("/api/faces/acme-bot");
  expect(ok.status).toBe(200);
  expect(ok.headers["content-type"]).toBe("image/svg+xml");
  expect(ok.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  expect(ok.body).toContain("<circle");
  expect((await get("/api/faces/nobody")).status).toBe(404);
  expect((await get("/api/faces/..%2Fsecret")).status).toBe(404);
  expect((await get("/api/faces/../secret")).status).toBe(404);
  signedIn = false;
  expect((await get("/api/faces/acme-bot")).status).toBe(401);
});

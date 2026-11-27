// A suggestion on a sign-in's card (GitHub: "code review can post as its own GitHub App", per org) is dismissed for good: the
// row stays, without its hint, action and dismiss key, for every later read and after the board restarts.
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel, type FakeAccount } from "./kernel.js";

const suggestion = (org: string) => ({ label: `Code review in ${org}`, value: "posts as you", state: "ok", hint: "Code review can post as its own GitHub App, so it doesn't share your write limit.", dismiss: `review-app:${org}`, action: { label: "Create the App", admin: "/setup/github-app" } });
const github = {
  status: async () => ({ state: "ok", configured: true, since: "", login: "sam", lines: [suggestion("acme"), suggestion("other")] }),
  scopes: async () => undefined,
  offers: async () => false,
};

describe("dismissing a sign-in card's suggestion", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-dismiss-"));
  writeFileSync(join(dir, "paperclip.yaml"), "mcp_servers:\n  github:\n    url: http://github:8086/mcp\n");
  process.env.BOARD_PAPERCLIP_CONFIG = join(dir, "paperclip.yaml");
  process.env.BOARD_MODULES_FILE = join(dir, "modules.json");
  writeFileSync(join(dir, "modules.json"), JSON.stringify([{ name: "github", enabled: true, connections: ["github"] }]));
  const closers: (() => void)[] = [];
  afterAll(() => closers.forEach((c) => c()));

  async function board() {
    const kernel = await fakeKernel();
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    const paperclip = new Paperclip("http://paperclip", "00000000-0000-4000-8000-000000000001", "k", (async () => new Response("[]")) as unknown as typeof fetch);
    const app = createApp({ paperclip, store: new Store(join(dir, "board.db")), records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"],
      signIns: [{ id: "github", label: "GitHub", connect: "/github/connect", callback: "/github/callback", mode: "device", missing: "m", stopped: "s", fields: [], auth: github as never }] });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    closers.push(() => { app.close(); kernel.close(); });
    const port = (app.address() as AddressInfo).port;
    return (method: string, path: string, body?: unknown, account: FakeAccount = { id: "u-1", email: "sam@example.com", name: "Sam", role: "admin", owner: true }) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const cookie = `aidenhq-board=${kernel.session(account)}`;
        const headers: Record<string, string> = { host: "localhost:3121", cookie, ...(method !== "GET" ? { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3121" } : {}) };
        const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
  }
  const rows = async (call: Awaited<ReturnType<typeof board>>) => (await call("GET", "/api/settings/connections")).json.connections.find((c: { name: string }) => c.name === "github").signIn.lines;

  it("keeps the row and drops only the dismissed org's suggestion, for good", async () => {
    const first = await board();
    expect((await rows(first))[0]).toMatchObject({ dismiss: "review-app:acme", hint: expect.any(String) });
    expect((await first("POST", "/api/sign-ins/github/dismiss", { key: "review-app:acme" }, { id: "u-2", email: "u@example.com", name: "U", role: "user", owner: false })).status).toBe(403);
    expect((await rows(first))[0]).toMatchObject({ dismiss: "review-app:acme" });
    expect((await first("POST", "/api/sign-ins/github/dismiss", { key: "review-app:acme" })).json).toEqual({ ok: true });
    const after = await rows(first);
    expect(after[0]).toEqual({ label: "Code review in acme", value: "posts as you", state: "ok" });
    expect(after[1]).toMatchObject({ dismiss: "review-app:other" });
    // A restarted board (same store) still serves it dismissed, on the board's own read too.
    const again = await board();
    expect((await rows(again))[0]).toEqual({ label: "Code review in acme", value: "posts as you", state: "ok" });
    expect((await again("GET", "/api/board")).json.signIns.find((x: { id: string }) => x.id === "github").status.lines[0]).not.toHaveProperty("hint");
  });
});

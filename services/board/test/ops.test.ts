// ops/setup.sh against the board, with exactly the headers its curl calls send (no Origin, no cookie):
// the first link and --reset (operator key + bearer, internal listener; --reset's link only the owner channel collects).
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccounts, type Accounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const OPERATOR = "o".repeat(40);
const TOKEN = "t".repeat(64);
const DECIDE = "d".repeat(48);

describe("ops/setup.sh with board accounts", () => {
  const log = pino({ level: "silent" });
  let accounts: Accounts;
  let lan: Server, internal: Server;
  const port = { lan: 0, internal: 0 };
  beforeAll(async () => {
    accounts = await createAccounts({ dbPath: ":memory:", hosts: ["localhost:3121"], adminUrl: "https://agents.example.ts.net:8444", ownerEmail: "owner@example.com", log });
    const common = { paperclip: {} as Paperclip, store: new Store(":memory:"), log, staticDir: "/nonexistent", timezone: "UTC", accounts, operatorKey: OPERATOR };
    lan = createApp({ ...common, allowedHosts: ["localhost:3121"], mode: "lan" });
    internal = createApp({ ...common, allowedHosts: ["127.0.0.1:3122"], mode: "internal", internalToken: TOKEN, gatewayKey: DECIDE });
    for (const [k, s] of [["lan", lan], ["internal", internal]] as const) {
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      port[k] = (s.address() as AddressInfo).port;
    }
  });
  afterAll(() => {
    lan.close();
    internal.close();
    accounts.close();
  });

  const curl = (where: keyof typeof port, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: port[where], method, path, headers }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: t ? JSON.parse(t) : undefined }));
      });
      r.on("error", reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const setup = (body: unknown) => curl("internal", "POST", "/internal/accounts/setup", { host: "127.0.0.1:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-operator-key": OPERATOR }, body);

  it("prints the owner's first link once, only for settings.owner_email; --reset sends a link only to the owner channel", async () => {
    expect((await curl("lan", "GET", "/api/session", { host: "localhost:3121" })).json.account).toBeNull();
    expect((await setup({ email: "someone@example.com", name: "X" })).status).toBe(400);
    const first = await setup({ email: "Owner@example.com", name: "Owner" });
    expect(first.status).toBe(200);
    // Admin links open on the kernel's admin listener (its front door), where the owner sets a password and enrols.
    expect(first.json.url).toMatch(/^https:\/\/agents\.example\.ts\.net:8444\/auth\/set-password\?token=/);
    expect((await setup({ email: "owner@example.com", name: "Owner" })).status).toBe(409);
    // The operator key is no session: a bare host process still reads nothing.
    expect((await curl("lan", "GET", "/api/board", { host: "localhost:3121", "x-operator-key": OPERATOR })).status).toBe(401);

    const reset = (headers: Record<string, string>) => curl("internal", "POST", "/internal/accounts/reset", { host: "127.0.0.1:3122", "content-type": "application/json", ...headers }, { email: "owner@example.com" });
    expect((await reset({ authorization: `Bearer ${TOKEN}` })).status).toBe(403); // the token alone
    const done = await reset({ authorization: `Bearer ${TOKEN}`, "x-operator-key": OPERATOR });
    expect(done.status).toBe(200);
    expect(JSON.stringify(done.json)).not.toContain("set-password");
    const links = (headers: Record<string, string>) => curl("internal", "GET", "/internal/owner/reset-links", { host: "127.0.0.1:3122", authorization: `Bearer ${TOKEN}`, ...headers });
    expect((await links({ "x-operator-key": OPERATOR })).status).toBe(403);
    const sent = await links({ "x-gateway-key": DECIDE });
    expect(sent.json.links).toEqual([{ email: "owner@example.com", url: expect.stringMatching(/\/auth\/set-password\?token=/) }]);
    expect((await links({ "x-gateway-key": DECIDE })).json.links).toEqual([]);
  });
});

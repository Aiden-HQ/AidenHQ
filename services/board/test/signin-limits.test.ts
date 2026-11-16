import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressKey, createAccounts, type Accounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { totp } from "./totp.js";

const PASSWORD = "correct horse battery staple";
const EDGE = "e".repeat(64);
const OWNER = "owner@example.com";

// Its own file: Better Auth's per-minute limit lives in memory per process and would count other files' sign-ins.
describe("board sign-in behind a front door: per-address bans, owner alerts, new-sign-in notices", () => {
  const log = pino({ level: "silent" });
  const lines: string[] = [];
  let accounts: Accounts, board: Server, base = "", totpURI = "";

  beforeAll(async () => {
    accounts = await createAccounts({ dbPath: ":memory:", hosts: ["localhost:3121"], boardUrl: "https://board.example.com", edgeSecret: EDGE, notify: (l) => lines.push(l), log });
    board = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), log, staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"], mode: "lan" });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;
    // The owner, enrolled, from the socket's address (no front door).
    const { url } = await accounts.setup(OWNER, "Owner");
    const claimed = await call("/reset-password", { token: url.split("#/set-password/").pop(), newPassword: PASSWORD });
    expect(claimed.json).toEqual({ status: true });
    const signedIn = await call("/sign-in/email", { email: OWNER, password: PASSWORD });
    const enable = await call("/two-factor/enable", { password: PASSWORD }, {}, signedIn.cookie);
    totpURI = enable.json.totpURI;
    expect((await call("/two-factor/verify-totp", { code: totp(totpURI) }, {}, signedIn.cookie)).status).toBe(200);
    lines.length = 0; // the first sign-in's notice: not what these cases look at
  });
  afterAll(() => {
    board.close();
    accounts.close();
  });

  /** One POST to Better Auth on the board listener; `from`: the front door names this client (with its secret). */
  async function call(path: string, body: unknown, extra: Record<string, string> = {}, cookie = "") {
    const headers = { host: "localhost:3121", "content-type": "application/json", origin: "http://localhost:3121", "x-aidenhq-board": "1", ...(cookie ? { cookie } : {}), ...extra };
    return new Promise<{ status: number; json: any; cookie: string }>((resolve, reject) => {
      const r = request(`${base}/api/auth${path}`, { method: "POST", headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : {}, cookie: (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ") }));
      });
      r.on("error", reject);
      r.end(JSON.stringify(body));
    });
  }
  const from = (ip: string) => ({ "x-aidenhq-client-ip": ip, "x-aidenhq-edge": EDGE });
  const guess = (email: string, extra: Record<string, string>) => call("/sign-in/email", { email, password: "wrong password!!" }, extra);

  it("bans one client behind the proxy after 20 failures across emails (its whole IPv6 /64), and never the next client", async () => {
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0DB8:0001:0002:aaaa::9".toLowerCase())).toBe("2001:db8:1:2::/64");
    for (let i = 1; i <= 20; i++) expect((await guess(`nobody${i}@example.com`, from(`2001:db8:1:2::${i.toString(16)}`))).status).toBe(401);
    const banned = await guess("nobody@example.com", from("2001:db8:1:2:ffff::9"));
    expect([banned.status, banned.json.code]).toEqual([429, "BANNED"]);
    // Banned on the owner's real password too, while a second client behind the same proxy signs in.
    expect((await call("/sign-in/email", { email: OWNER, password: PASSWORD }, from("2001:db8:1:2::1"))).status).toBe(429);
    expect((await guess("nobody@example.com", from("198.51.100.20"))).status).toBe(401);
    expect((await call("/sign-in/email", { email: OWNER, password: PASSWORD }, from("198.51.100.21"))).json.twoFactorRedirect).toBe(true);
  });

  it("never locks the owner for strangers' failures from many addresses, and tells the owner once", async () => {
    // 32 failures, 4 from each of 8 addresses (under the 5-per-address lockout, under the ban).
    for (let a = 0; a < 8; a++) for (let i = 0; i < 4; i++) expect((await guess(OWNER, from(`203.0.113.${10 + a}`))).status).toBe(401);
    const alerts = lines.filter((l) => l.includes("Sign-in attempts"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(`for ${OWNER}`);
    expect(alerts[0]).toContain("from 8 addresses");
    expect((await guess(OWNER, from("203.0.113.30"))).status).toBe(401);
    expect(lines.filter((l) => l.includes("Sign-in attempts"))).toHaveLength(1); // once an hour, not per failure
    // The owner, from his own address, signs all the way in; the new device's session tells him, with time and address.
    const step1 = await call("/sign-in/email", { email: OWNER, password: PASSWORD }, from("192.0.2.44"));
    expect(step1.json.twoFactorRedirect).toBe(true);
    expect(lines.some((l) => l.includes("New board sign-in"))).toBe(false); // the password step opens no session
    expect((await call("/two-factor/verify-totp", { code: totp(totpURI, 1) }, from("192.0.2.44"), step1.cookie)).status).toBe(200);
    const notice = lines.find((l) => l.includes("New board sign-in"));
    expect(notice).toMatch(new RegExp(`${OWNER} from 192\\.0\\.2\\.44 at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC`));
  });

  it("ignores a named address, X-Forwarded-For and CF-Connecting-IP without the front door's secret", async () => {
    const forged = (i: number) => ({ "x-aidenhq-client-ip": `10.7.0.${i}`, "x-aidenhq-edge": "not the secret", "x-forwarded-for": `10.8.0.${i}`, "cf-connecting-ip": `10.9.0.${i}` });
    // Five failures from "five addresses" are one pair, the socket's: it locks, and only there.
    for (let i = 0; i < 5; i++) expect((await guess(OWNER, forged(i))).status).toBe(401);
    expect((await call("/sign-in/email", { email: OWNER, password: PASSWORD }, forged(9))).status).toBe(403);
    expect((await call("/sign-in/email", { email: OWNER, password: PASSWORD }, from("192.0.2.45"))).json.twoFactorRedirect).toBe(true);
  });
});

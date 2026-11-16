import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccounts, type Accounts } from "../src/accounts.js";
import { addressKey } from "../src/auth-rules.js";
import { adminListener } from "./admin.js";
import { totp } from "./totp.js";

const PASSWORD = "correct horse battery staple";
const EDGE = "e".repeat(64);
const OWNER = "owner@example.com";

// Its own file: Better Auth's per-minute limit lives in memory per process and would count other files' sign-ins.
describe("admin sign-in (the kernel's admin listener, auth-rules) behind a front door: per-address bans, owner alerts, new-sign-in notices", () => {
  const log = pino({ level: "silent" });
  const lines: string[] = [];
  let accounts: Accounts, admin: Awaited<ReturnType<typeof adminListener>>, base = "", totpURI = "";

  beforeAll(async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "limits-")), "auth.db");
    accounts = await createAccounts({ dbPath, hosts: ["127.0.0.1:3129"], adminUrl: "https://admin.example.com", log });
    admin = await adminListener(dbPath, ["localhost:3120"], { edgeSecret: EDGE, notify: (l) => lines.push(l) });
    base = admin.base;
    // The owner, enrolled, from the socket's address (no front door).
    const { url } = await accounts.setup(OWNER, "Owner");
    const claimed = await call("/reset-password", { token: url.split("token=").pop(), newPassword: PASSWORD });
    expect(claimed.json).toEqual({ status: true });
    const signedIn = await call("/sign-in/email", { email: OWNER, password: PASSWORD });
    const enable = await call("/two-factor/enable", { password: PASSWORD }, {}, signedIn.cookie);
    totpURI = enable.json.totpURI;
    expect((await call("/two-factor/verify-totp", { code: totp(totpURI) }, {}, signedIn.cookie)).status).toBe(200);
    lines.length = 0; // the first sign-in's notice: not what these cases look at
  });
  afterAll(() => {
    admin.close();
    accounts.close();
  });

  /** One POST to Better Auth on the admin listener; `from`: the front door names this client (with its secret). */
  async function call(path: string, body: unknown, extra: Record<string, string> = {}, cookie = "") {
    const headers = { host: "localhost:3120", "content-type": "application/json", origin: "http://localhost:3120", ...(cookie ? { cookie } : {}), ...extra };
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
    // Addresses in parallel (each one's guesses in order): the same 32 failures, a fraction of the wall time.
    await Promise.all(Array.from({ length: 8 }, async (_, a) => { for (let i = 0; i < 4; i++) expect((await guess(OWNER, from(`203.0.113.${10 + a}`))).status).toBe(401); }));
    const alerts = lines.filter((l) => l.includes("Sign-in attempts"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(`for ${OWNER}`);
    expect(alerts[0]).toContain("from 8 addresses");
    expect((await guess(OWNER, from("203.0.113.30"))).status).toBe(401);
    expect(lines.filter((l) => l.includes("Sign-in attempts"))).toHaveLength(1); // once an hour, not per failure
    // The owner, from his own address, signs all the way in; the new device's session tells him, with time and address.
    const step1 = await call("/sign-in/email", { email: OWNER, password: PASSWORD }, from("192.0.2.44"));
    expect(step1.json.twoFactorRedirect).toBe(true);
    expect(lines.some((l) => l.includes("New admin sign-in"))).toBe(false); // the password step opens no session
    expect((await call("/two-factor/verify-totp", { code: totp(totpURI, 1) }, from("192.0.2.44"), step1.cookie)).status).toBe(200);
    const notice = lines.find((l) => l.includes("New admin sign-in"));
    expect(notice).toMatch(new RegExp(`${OWNER} from 192\\.0\\.2\\.44 at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC`));
  });

  it("a flood of failed-sign-in alerts is capped and collapsed, and never holds back a new-session notice", async () => {
    const owner = (await accounts.list()).find((a) => a.owner)!;
    // Seven more admins, each guessed at 32 times (4 from each of 8 addresses, under the lockout and the ban).
    for (let n = 0; n < 7; n++) {
      const email = `admin${n}@example.com`;
      await accounts.invite(owner, { email, name: email, role: "admin" });
      await Promise.all(Array.from({ length: 8 }, async (_, a) => { for (let i = 0; i < 4; i++) expect((await guess(email, from(`100.64.${n}.${a}`))).status).toBe(401); }));
    }
    // The owner's alert (the case above) and four of these make the hourly five; then one line says the rest wait.
    expect(lines.filter((l) => l.includes("failed sign-ins for admin"))).toHaveLength(4);
    expect(lines.filter((l) => l.includes("Sign-in attempts on more accounts"))).toHaveLength(1);
    const step1 = await call("/sign-in/email", { email: OWNER, password: PASSWORD }, from("192.0.2.46"));
    expect(step1.json.twoFactorRedirect).toBe(true);
    // A code this test hasn't spent yet (a 30 s step may have turned since the others).
    let status = 0;
    for (const step of [-1, 0, 1]) if ((status = (await call("/two-factor/verify-totp", { code: totp(totpURI, step) }, from("192.0.2.46"), step1.cookie)).status) === 200) break;
    expect(status).toBe(200);
    expect(lines.at(-1)).toContain(`New admin sign-in**: ${OWNER} from 192.0.2.46`);
  }, 90_000);

  it("ignores a named address, X-Forwarded-For and CF-Connecting-IP without the front door's secret", async () => {
    const forged = (i: number) => ({ "x-aidenhq-client-ip": `10.7.0.${i}`, "x-aidenhq-edge": "not the secret", "x-forwarded-for": `10.8.0.${i}`, "cf-connecting-ip": `10.9.0.${i}` });
    // Failures from "five addresses" are the shared peer's: held (429 until its next allowed attempt), never locked, and an
    // address the front door names still gets in.
    expect((await guess(OWNER, forged(0))).status).toBe(401);
    for (let i = 1; i < 5; i++) expect((await guess(OWNER, forged(i))).status).toBe(429);
    expect((await call("/sign-in/email", { email: OWNER, password: PASSWORD }, forged(9))).status).toBe(429);
    expect((await call("/sign-in/email", { email: OWNER, password: PASSWORD }, from("192.0.2.45"))).json.twoFactorRedirect).toBe(true);
  });
});

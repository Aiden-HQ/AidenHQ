import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccounts, type Accounts } from "../src/accounts.js";
import { createSigninServer } from "../src/signin.js";
import { adminListener } from "./admin.js";
import { totp } from "./totp.js";

const PASSWORD = "correct horse battery staple";
const GATE_SECRET = "g".repeat(64);

// Its own file: Better Auth's rate limit (memory, per address, shared by every instance in a process) would otherwise count accounts.test.ts' sign-ins.
describe("board accounts: the sign-in listener's lockout", () => {
  const log = pino({ level: "silent" });
  let accounts: Accounts;
  let signin: Server;
  let admin: Awaited<ReturnType<typeof adminListener>>;
  const base = { local: "", signin: "" };
  const gate = () => ({ password: true, myAppsHost: "apps.example.com", appHosts: ["crm.example.com"] });

  beforeAll(async () => {
    // The kernel's admin listener (local) and the board's 3129 listener share one accounts file.
    const dbPath = join(mkdtempSync(join(tmpdir(), "lockout-")), "auth.db");
    accounts = await createAccounts({ dbPath, hosts: ["127.0.0.1:3129"], adminUrl: "http://localhost:3120", gate, gateSecret: GATE_SECRET, log });
    admin = await adminListener(dbPath, ["localhost:3120"]);
    base.local = admin.base;
    signin = createSigninServer({ accounts, hosts: ["127.0.0.1:3129"], gate, log });
    await new Promise<void>((r) => signin.listen(0, "127.0.0.1", r));
    base.signin = `http://127.0.0.1:${(signin.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    admin.close();
    signin.close();
    accounts.close();
  });

  /** One POST; local: the kernel's admin listener (http); signin: through the gate's sign-in host (https). */
  async function call(where: "local" | "signin", path: string, body: unknown, extra: Record<string, string> = {}, cookie = "") {
    const { request } = await import("node:http");
    const host = where === "local" ? "localhost:3120" : "apps.example.com";
    const headers = { host, "content-type": "application/json", origin: `${where === "local" ? "http" : "https"}://${host}`, ...(where === "local" ? { "x-aidenhq-board": "1" } : { "x-forwarded-proto": "https" }), ...(cookie ? { cookie } : {}), ...extra };
    return new Promise<{ status: number; json: any; cookie: string }>((resolve, reject) => {
      const r = request(`${base[where]}${path}`, { method: "POST", headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : {}, cookie: (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ") }));
      });
      r.on("error", reject);
      r.end(JSON.stringify(body));
    });
  }

  it("trusts the client-IP header only with the gate's secret, and the internet can't pause the owner's sign-in on the admin listener", async () => {
    // The owner, enrolled (the sign-in listener refuses an admin without an authenticator).
    const { url } = await accounts.setup("owner@example.com", "Owner");
    expect((await call("local", "/api/auth/reset-password", { token: url.split("token=").pop(), newPassword: PASSWORD })).status).toBe(200);
    const signedIn = await call("local", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD });
    const enable = await call("local", "/api/auth/two-factor/enable", { password: PASSWORD }, {}, signedIn.cookie);
    expect((await call("local", "/api/auth/two-factor/verify-totp", { code: totp(enable.json.totpURI) }, {}, signedIn.cookie)).status).toBe(200);

    const wrong = { email: "owner@example.com", password: "wrong password!!" };
    // Without the secret a named address is ignored: five failures from "five addresses" are the shared peer's, which is
    // slowed, never locked (a lock there would lock everyone behind it out).
    for (let i = 0; i < 5; i++) expect((await call("signin", "/.auth/api/sign-in/email", wrong, { "x-aidenhq-client-ip": `10.5.0.${i}`, "x-aidenhq-gate": "not the secret" })).status).toBe(401);
    const t0 = Date.now();
    expect((await call("signin", "/.auth/api/sign-in/email", { email: "owner@example.com", password: PASSWORD }, { "x-aidenhq-client-ip": "10.5.1.1" })).json.twoFactorRedirect).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    // 20 failures through the gate (the 5 above count too) pause the account there, never on the admin listener.
    for (let i = 0; i < 15; i++) expect((await call("signin", "/.auth/api/sign-in/email", wrong, { "x-aidenhq-client-ip": `10.6.0.${i}`, "x-aidenhq-gate": GATE_SECRET })).status).toBe(401);
    expect((await call("signin", "/.auth/api/sign-in/email", { email: "owner@example.com", password: PASSWORD }, { "x-aidenhq-client-ip": "10.6.1.1", "x-aidenhq-gate": GATE_SECRET })).status).toBe(403);
    expect((await call("local", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD })).json.twoFactorRedirect).toBe(true);
  });
});

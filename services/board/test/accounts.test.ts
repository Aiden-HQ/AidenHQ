import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccounts, type Accounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { createSigninServer } from "../src/signin.js";
import { Store } from "../src/store.js";
import { adminListener } from "./admin.js";
import { totp } from "./totp.js";

const OPERATOR = "o".repeat(40);
const INTERNAL = "i".repeat(40);
const PASSWORD = "correct horse battery staple";
const GATE_SECRET = "g".repeat(64);

describe("board accounts", () => {
  const log = pino({ level: "silent" });
  const store = new Store(":memory:");
  const paperclip = {} as Paperclip; // past the gate, a route fails on it: the gate is what's tested
  let accounts: Accounts;
  let lan: Server, internal: Server, signin: Server;
  let admin: Awaited<ReturnType<typeof adminListener>>;
  const base = { admin: "", lan: "", internal: "", signin: "" };
  // admin: the kernel's admin listener (sign-in, links, enrolment); lan: the board (3121); internal: ops/setup.sh's calls (3122);
  // signin: the gate's sign-in host (https, proxied by the gate); gate: the gate's own server-side calls to 3129.
  const HOST = { admin: "localhost:3120", lan: "aidenhq.local", internal: "127.0.0.1:3122", signin: "apps.example.com", gate: "127.0.0.1:3129" };
  const gate = () => ({ password: true, myAppsHost: "apps.example.com", appHosts: ["crm.example.com"] });
  const dir = mkdtempSync(join(tmpdir(), "accounts-"));
  mkdirSync(join(dir, "auth"));
  const gateAccountsFile = join(dir, "accounts.json");

  beforeAll(async () => {
    const dbPath = join(dir, "auth", "auth.db");
    accounts = await createAccounts({ dbPath, hosts: [HOST.lan, HOST.gate], adminUrl: "http://localhost:3120", gate, gateAccountsFile, gateSecret: GATE_SECRET, log });
    admin = await adminListener(dbPath, [HOST.admin]);
    base.admin = admin.base;
    const common = { paperclip, store, log, staticDir: "/nonexistent", timezone: "UTC", accounts };
    lan = createApp({ ...common, allowedHosts: [HOST.lan], mode: "lan", lan: { url: "http://aidenhq.local" } });
    internal = createApp({ ...common, allowedHosts: [HOST.internal], mode: "internal", internalToken: INTERNAL, operatorKey: OPERATOR });
    signin = createSigninServer({ accounts, hosts: [HOST.gate], gate, log });
    for (const [k, s] of [["lan", lan], ["internal", internal], ["signin", signin]] as const) {
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      base[k] = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    }
  }, 30_000);
  afterAll(() => {
    for (const s of [lan, internal, signin]) s.close();
    admin.close();
    accounts.close();
  });

  /**
   * A browser on one listener: keeps its cookies (`jar`: share one between the admin listener and the board, as a browser
   * does across ports of one host), sends the board's headers. fetch() can't set Host, so node:http.
   */
  function browser(where: keyof typeof HOST, jar = new Map<string, string>(), host = HOST[where]) {
    const https = where === "signin" || where === "gate";
    const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const { request } = await import("node:http");
      const headers: Record<string, string> = { host, ...(https ? { "x-forwarded-proto": "https" } : {}), ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...extra };
      // Through the gate (https) the board's header never arrives: the gate strips every x-aidenhq-* header.
      if (method !== "GET") Object.assign(headers, { "content-type": "application/json", ...(https ? {} : { "x-aidenhq-board": "1" }), origin: `${https ? "https" : "http"}://${host}` }, extra);
      const res = await new Promise<{ status: number; body: string; cookies: string[] }>((resolve, reject) => {
        const r = request(`${base[where === "gate" ? "signin" : where]}${path}`, { method, headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: data, cookies: res.headers["set-cookie"] ?? [] }));
        });
        r.on("error", reject);
        r.end(body === undefined ? undefined : JSON.stringify(body));
      });
      for (const c of res.cookies) {
        const [kv, ...attrs] = c.split(";");
        const [k, v] = kv!.split("=");
        if (attrs.some((a) => /max-age=0/i.test(a.trim())) || v === "") jar.delete(k!.trim());
        else jar.set(k!.trim(), v!.trim());
      }
      return { status: res.status, body: res.body, json: /^[[{]|^null$/.test(res.body) ? JSON.parse(res.body) : {}, cookies: res.cookies };
    };
    return { call, jar, on: (other: keyof typeof HOST) => browser(other, jar) };
  }

  const tokenOf = (url: string) => url.split(/[?&]token=|#/).pop()!;
  let ownerUri = "";
  let spent = "";
  let annUri = "";
  /** The owner's signed-in, enrolled browser from the first test (TOTP steps can't be reused, so one sign-in serves all). */
  let ownerB: ReturnType<typeof browser>;
  const ownerBrowser = async () => ownerB;
  const ops = { authorization: `Bearer ${INTERNAL}`, "x-operator-key": OPERATOR };

  it("sets up the owner with a single-use link (the operator, on the internal listener), then enrolment on the admin listener", async () => {
    const i = browser("internal");
    expect((await i.call("POST", "/internal/accounts/setup", { email: "Owner@Example.com", name: "Owner" }, { authorization: `Bearer ${INTERNAL}` })).status).toBe(403);
    const setup = await i.call("POST", "/internal/accounts/setup", { email: "Owner@Example.com", name: "Owner" }, ops);
    expect(setup.status).toBe(200);
    expect(setup.json.account).toMatchObject({ email: "owner@example.com", role: "admin", owner: true });
    // Admin links open on the kernel's admin listener.
    expect(setup.json.url).toMatch(/^http:\/\/localhost:3120\/auth\/set-password\?token=/);
    expect((await i.call("POST", "/internal/accounts/setup", { email: "x@example.com" }, ops)).status).toBe(409);
    const token = tokenOf(setup.json.url);
    const b = browser("admin");
    expect((await b.call("POST", "/api/auth/reset-password", { token, newPassword: PASSWORD })).status).toBe(200);
    expect((await b.call("POST", "/api/auth/reset-password", { token, newPassword: PASSWORD })).status).toBe(400);

    expect((await b.call("POST", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD })).status).toBe(200);
    // The board takes the admin listener's session (one file, one secret; cookies ignore ports), and still wants TOTP.
    const board = b.on("lan");
    expect((await board.call("GET", "/api/session")).json).toMatchObject({ needsTotp: true, account: { owner: true }, adminUrl: null });
    const read = await board.call("GET", "/api/board");
    expect([read.status, read.json.error]).toEqual([403, "totp"]);

    const enable = await b.call("POST", "/api/auth/two-factor/enable", { password: PASSWORD });
    expect(enable.status).toBe(200);
    ownerUri = enable.json.totpURI;
    spent = totp(ownerUri);
    expect((await b.call("POST", "/api/auth/two-factor/verify-totp", { code: spent })).status).toBe(200);
    expect((await board.call("GET", "/api/session")).json).toMatchObject({ needsTotp: false, account: { owner: true } });
    expect((await board.call("GET", "/api/board")).status).toBe(500); // past the gate (the fake Paperclip fails)
    ownerB = board;
  });

  it("a session opened on the admin listener (the kernel's sign-in) is the board's session: TOTP at sign-in, a code once", async () => {
    const b = browser("admin");
    const first = await b.call("POST", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD });
    expect(first.json.twoFactorRedirect).toBe(true);
    expect((await b.on("lan").call("GET", "/api/board")).status).toBe(401);
    // The enrolment spent the current step's code: the same code is refused, the next step's is accepted.
    expect((await b.call("POST", "/api/auth/two-factor/verify-totp", { code: spent })).status).toBe(401);
    expect((await b.call("POST", "/api/auth/two-factor/verify-totp", { code: totp(ownerUri, 1) })).status).toBe(200);
    expect((await b.on("lan").call("GET", "/api/session")).json).toMatchObject({ needsTotp: false, account: { owner: true } });
    expect((await b.on("lan").call("GET", "/api/board")).status).toBe(500); // past the gate
    expect((await b.call("POST", "/api/auth/two-factor/verify-totp", { code: totp(ownerUri, -1), trustDevice: true })).status).toBe(400);
  });

  it("serves no sign-in, approval decision or operator route on the board's listener", async () => {
    const b = browser("lan");
    expect((await b.call("GET", "/api/board")).status).toBe(401);
    expect((await b.call("GET", "/api/events")).status).toBe(401); // the live stream too
    expect((await b.call("GET", "/api/issues/WOR-1/files/00000000-0000-0000-0000-000000000000")).status).toBe(401);
    // Better Auth isn't on the board any more, and the operator key isn't a session there.
    expect((await b.call("POST", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD })).status).toBe(401);
    expect((await b.call("GET", "/api/board", undefined, { "x-operator-key": OPERATOR })).status).toBe(401);
    const owner = await ownerBrowser();
    expect((await owner.call("POST", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD })).status).toBe(404);
    expect((await owner.call("POST", "/api/approvals/A00000001/approve", {})).status).toBe(404);
    expect((await owner.call("POST", "/api/approvals/batch/approve", { items: [] })).status).toBe(404);
    // ops/setup.sh's welcome chat: the internal listener with the operator key (past it, the fake Paperclip fails).
    expect((await browser("internal").call("POST", "/internal/owner/welcome", { text: "Welcome" }, { authorization: `Bearer ${INTERNAL}` })).status).toBe(403);
    expect((await browser("internal").call("POST", "/internal/owner/welcome", { text: "Welcome" }, ops)).status).toBe(500);
  });

  it("refuses a write whose Origin differs in scheme", async () => {
    const owner = await ownerBrowser();
    expect((await owner.call("POST", "/api/accounts", { email: "x@example.com", name: "X", role: "user" }, { origin: "https://aidenhq.local" })).status).toBe(403);
  });

  it("an invite link works once, and a newer link kills the older", async () => {
    const owner = await ownerBrowser();
    const invite = await owner.call("POST", "/api/accounts", { email: "ann@example.com", name: "Ann", role: "admin" });
    expect(invite.status).toBe(200);
    const older = tokenOf(invite.json.url);
    const newer = tokenOf((await owner.call("POST", `/api/accounts/${invite.json.account.id}/link`)).json.url);
    const b = browser("admin");
    expect((await b.call("POST", "/api/auth/reset-password", { token: older, newPassword: PASSWORD })).status).toBe(400);
    // Two claims at once: exactly one wins.
    const both = await Promise.all([1, 2].map(() => b.call("POST", "/api/auth/reset-password", { token: newer, newPassword: PASSWORD })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
    // The owner's account can't be changed from the board.
    const me = (await owner.call("GET", "/api/accounts")).json.me;
    expect((await owner.call("POST", `/api/accounts/${me}/disable`)).status).toBe(403);
  });

  it("holds an unidentified peer after wrong passwords (429), keeps open sessions; a reset link lifts it", async () => {
    const b = browser("admin");
    const open = browser("admin");
    expect((await open.call("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: PASSWORD })).status).toBe(200);
    // An unidentified peer: two free failures, then a stepped hold (429 at once, no hashing).
    for (let i = 0; i < 3; i++) expect((await b.call("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: "wrong password!!" })).status).toBe(401);
    for (let i = 0; i < 2; i++) expect((await b.call("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: "wrong password!!" })).status).toBe(429);
    // Held even with the right password; claiming a link lifts the hold.
    expect((await b.call("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: PASSWORD })).status).toBe(429);
    // Failing on purpose signs nobody out.
    expect((await open.on("lan").call("GET", "/api/session")).json.account?.email).toBe("ann@example.com");
    await accounts.reset("ann@example.com");
    const [link] = accounts.takeResetLinks();
    expect(link?.email).toBe("ann@example.com");
    expect((await b.call("POST", "/api/auth/reset-password", { token: tokenOf(link!.url), newPassword: "another long password" })).status).toBe(200);
    expect((await b.call("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: "another long password" })).status).toBe(200);
    expect((await b.on("lan").call("GET", "/api/session")).json.needsTotp).toBe(true);
    // A second browser signed in with the password alone, before the authenticator: enrolling elsewhere ends it.
    const passwordOnly = browser("admin");
    expect((await passwordOnly.call("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: "another long password" })).status).toBe(200);
    // Enrolled, Ann is a full admin: she starts a Google or MCP sign-in like the owner (not before).
    annUri = (await b.call("POST", "/api/auth/two-factor/enable", { password: "another long password" })).json.totpURI;
    expect((await b.call("POST", "/api/auth/two-factor/verify-totp", { code: totp(annUri) })).status).toBe(200);
    expect((await b.on("lan").call("GET", "/api/session")).json).toMatchObject({ needsTotp: false, account: { owner: false } });
    expect((await passwordOnly.on("lan").call("GET", "/api/session")).json.account).toBeNull();
    expect((await passwordOnly.on("lan").call("GET", "/api/board")).status).toBe(401);
    expect((await passwordOnly.on("lan").call("GET", "/google/connect")).status).toBe(403);
    expect((await b.on("lan").call("GET", "/google/connect")).status).toBe(404); // past the gate: Google isn't set up here
    expect((await ownerB.call("GET", "/google/connect")).status).toBe(404); // past the gate: Google isn't set up here
  });

  it("keeps users off the board; the sign-in host signs them in, hands off to an app host once, and serves no board route", async () => {
    const owner = await ownerBrowser();
    const invite = await owner.call("POST", "/api/accounts", { email: "uma@example.com", name: "Uma", role: "user" });
    expect(invite.json.url).toMatch(/^https:\/\/apps\.example\.com\/\.auth\/set-password#/);
    const s = browser("signin");
    expect((await s.call("POST", "/.auth/api/reset-password", { token: tokenOf(invite.json.url), newPassword: PASSWORD })).status).toBe(200);
    expect((await browser("admin").call("POST", "/api/auth/sign-in/email", { email: "uma@example.com", password: PASSWORD })).status).toBe(403);
    const signedIn = await s.call("POST", "/.auth/api/sign-in/email", { email: "uma@example.com", password: PASSWORD });
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookies.join()).toMatch(/^__Host-better-auth\.session_token=[^;]+; Max-Age=\d+; HttpOnly; Path=\/; SameSite=Lax; Secure/);

    // next: a same-host path only.
    expect((await s.call("GET", "/.auth/sign-in?next=" + encodeURIComponent("/.auth/go?to=crm.example.com&state=abc"))).body).toContain('data-next="/.auth/go?to=crm.example.com&#38;state=abc"');
    for (const bad of ["https://evil.example.org/", "//evil.example.org/", "/\t/evil.example.org/", "/\\evil.example.org/"]) expect((await s.call("GET", "/.auth/sign-in?next=" + encodeURIComponent(bad))).body).not.toContain("data-next");

    // The gate, server-side: mint with the sign-in host's session cookie, then redeem once for that host.
    const g = browser("gate");
    for (const [k, v] of s.jar) g.jar.set(k, v);
    const state = "s".repeat(32);
    expect((await browser("gate").call("POST", "/.auth/api/handoff/mint", { host: "crm.example.com", state })).status).toBe(401);
    expect((await g.call("POST", "/.auth/api/handoff/mint", { host: "evil.example.org", state })).status).toBe(400);
    const mint = async () => (await g.call("POST", "/.auth/api/handoff/mint", { host: "crm.example.com", state })).json.code as string;
    const code = await mint();
    expect((await g.call("POST", "/.auth/api/handoff/redeem", { code, host: "other.example.com", state })).status).toBe(400); // spent by the wrong host
    expect((await g.call("POST", "/.auth/api/handoff/redeem", { code, host: "crm.example.com", state })).status).toBe(400);
    const code1 = await mint();
    expect((await g.call("POST", "/.auth/api/handoff/redeem", { code: code1, host: "crm.example.com", state: "t".repeat(32) })).status).toBe(400); // wrong state
    const code2 = await mint();
    // The gate never forwards these: through the sign-in host's name they're refused.
    expect((await s.call("POST", "/.auth/api/handoff/redeem", { code: code2, host: "crm.example.com", state })).status).toBe(403);
    const redeem = async (c: string) => g.call("POST", "/.auth/api/handoff/redeem", { code: c, host: "crm.example.com", state });
    const redeemed = await redeem(code2);
    expect(redeemed.status).toBe(200);
    expect(redeemed.json.token).toMatch(/^[A-Za-z0-9._~+/=-]{16,1024}$/);
    expect((await redeem(code2)).status).toBe(400);

    // The gate's get-session with the app host's cookie (its own new session): the user; with none: null.
    const app = browser("gate");
    app.jar.set("__Host-better-auth.session_token", redeemed.json.token);
    const appSession = async (b = app) => (await b.call("GET", "/.auth/api/get-session", undefined, { "x-forwarded-host": "crm.example.com", "x-forwarded-proto": "https" })).json;
    expect((await appSession()).user).toMatchObject({ email: "uma@example.com", banned: false });
    expect((await browser("gate").call("GET", "/.auth/api/get-session")).body).toBe("null");
    // On https only the __Host- name counts: the same value under the plain name is ignored.
    const plain = browser("gate");
    plain.jar.set("better-auth.session_token", redeemed.json.token);
    expect(await appSession(plain)).toBeNull();
    // An app host's session is never a board session (nor a parent for another handoff).
    const onBoard = browser("lan");
    onBoard.jar.set("better-auth.session_token", redeemed.json.token);
    expect((await onBoard.call("GET", "/api/session")).json.account).toBeNull();
    expect((await app.call("POST", "/.auth/api/handoff/mint", { host: "crm.example.com", state })).status).toBe(401);
    // The gate's sign-out on the app host ends that session only.
    const second = browser("gate");
    second.jar.set("__Host-better-auth.session_token", (await redeem(await mint())).json.token);
    expect((await second.call("POST", "/.auth/api/handoff/revoke", { host: "other.example.com" })).status).toBe(400);
    expect((await second.call("POST", "/.auth/api/handoff/revoke", { host: "crm.example.com" })).status).toBe(200);
    expect(await appSession(second)).toBeNull();
    expect((await appSession()).user.email).toBe("uma@example.com");
    // Signing out on the sign-in host ends every app host session handed off from it.
    expect((await s.call("POST", "/.auth/api/sign-out", {})).status).toBe(200);
    expect(await appSession()).toBeNull();

    // Nothing else is served on 3129.
    expect((await s.call("GET", "/.auth/api/list-sessions")).status).toBe(404);
    expect((await s.call("POST", "/.auth/api/change-password", { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(404);
    expect((await s.call("GET", "/api/board")).status).toBe(404);
    expect((await s.call("GET", "/.auth/two-factor")).status).toBe(200);
    // Admins give their TOTP code on the gate's side too; one without an authenticator can't sign in there.
    expect((await browser("signin").call("POST", "/.auth/api/sign-in/email", { email: "ann@example.com", password: "another long password" })).json.twoFactorRedirect).toBe(true);
    const bob = await owner.call("POST", "/api/accounts", { email: "bob@example.com", name: "Bob", role: "admin" });
    expect((await browser("admin").call("POST", "/api/auth/reset-password", { token: tokenOf(bob.json.url), newPassword: PASSWORD })).status).toBe(200);
    expect((await browser("signin").call("POST", "/.auth/api/sign-in/email", { email: "bob@example.com", password: PASSWORD })).status).toBe(403);

    // Two session cookies at once (one planted): no session.
    expect((await browser("gate").call("GET", "/.auth/api/get-session", undefined, { cookie: `__Host-better-auth.session_token=${redeemed.json.token}; __Host-better-auth.session_token=${redeemed.json.token}` })).body).toBe("null");

    // The gate's account map: every account, written in place, no secrets.
    await new Promise((r) => setTimeout(r, 50));
    const map = JSON.parse(readFileSync(gateAccountsFile, "utf8"));
    expect(map.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ email: "owner@example.com", role: "admin", disabled: false }), expect.objectContaining({ email: "uma@example.com", role: "user", disabled: false })]));
  });

  it("pauses sign-ins per address (the gate's client-IP header) and per account, and a challenge dies after 5 wrong codes", async () => {
    const from = (ip: string) => ({ "x-aidenhq-client-ip": ip, "x-aidenhq-gate": GATE_SECRET });
    // One password step, then wrong codes from five addresses (no address reaches its own pause): the sixth try, even with
    // the right code, finds the challenge spent.
    const s = browser("signin");
    expect((await s.call("POST", "/.auth/api/sign-in/email", { email: "ann@example.com", password: "another long password" }, from("10.0.0.1"))).json.twoFactorRedirect).toBe(true);
    // Five different wrong codes (a repeated one would stop at the replay guard, before Better Auth counts it).
    const wrong = (i: number) => String((Number(totp(annUri)) + 100_000 * (i + 1)) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i++) expect((await s.call("POST", "/.auth/api/two-factor/verify-totp", { code: wrong(i) }, from(`10.0.1.${i}`))).status).toBe(401);
    expect((await s.call("POST", "/.auth/api/two-factor/verify-totp", { code: totp(annUri, 1) }, from("10.0.2.1"))).status).toBe(400);

    // 20 wrong passwords spread over 20 addresses pause the whole account; the right password from a 21st is refused.
    const u = browser("signin");
    for (let i = 0; i < 20; i++) expect((await u.call("POST", "/.auth/api/sign-in/email", { email: "uma@example.com", password: "wrong password!!" }, from(`10.3.0.${i}`))).status).toBe(401);
    expect((await u.call("POST", "/.auth/api/sign-in/email", { email: "uma@example.com", password: PASSWORD }, from("10.4.0.1"))).status).toBe(403);
  });
});

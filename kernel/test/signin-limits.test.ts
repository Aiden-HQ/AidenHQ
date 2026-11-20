// Admin sign-in behind a front door: per-address bans, owner alerts, new-sign-in notices (ported from
// services/board/test/signin-limits.test.ts). Its own file: Better Auth's per-minute limit lives in memory per process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAccounts } from "../src/accounts.ts";
import { addressKey } from "../src/auth-rules.ts";
import { PASSWORD, call, silent, stepListener, totp } from "./auth-helpers.ts";

const EDGE = "e".repeat(64);
const OWNER = "owner@example.com";
const lines = [];
let accounts, base = "", totpURI = "", closeAll = () => {};

const post = (path, body, extra = {}, cookie = "") => call(base, "POST", `/api/auth${path}`, { host: "localhost:3120", body, cookie, headers: extra, origin: "http://localhost:3120" });
const from = (ip) => ({ "x-aidenhq-client-ip": ip, "x-aidenhq-edge": EDGE });
const guess = (email, extra) => post("/sign-in/email", { email, password: "wrong password!!" }, extra);

test("setup: the owner, enrolled, from the socket's address (no front door)", async () => {
  accounts = await openAccounts({ dataDir: ":memory:", hosts: ["localhost:3120", "127.0.0.1:3129"], adminUrl: "https://admin.example.com", edgeSecret: () => EDGE, notify: (l) => lines.push(l), log: silent });
  const listener = await stepListener(accounts);
  base = listener.url;
  closeAll = () => { listener.close(); accounts.close(); };
  const { url } = await accounts.setup(OWNER, "Owner");
  const claimed = await post("/reset-password", { token: url.split("token=").pop(), newPassword: PASSWORD });
  assert.equal(claimed.json.status, true);
  const signedIn = await post("/sign-in/email", { email: OWNER, password: PASSWORD });
  const enable = await post("/two-factor/enable", { password: PASSWORD }, {}, signedIn.cookie);
  totpURI = enable.json.totpURI;
  assert.equal((await post("/two-factor/verify-totp", { code: totp(totpURI) }, {}, signedIn.cookie)).status, 200);
  lines.length = 0; // the first sign-in's notice: not what these cases look at
});

test("bans one client behind the proxy after 20 failures across emails (its whole IPv6 /64), and never the next client", async () => {
  assert.equal(addressKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:0DB8:0001:0002:aaaa::9".toLowerCase()), "2001:db8:1:2::/64");
  for (let i = 1; i <= 20; i++) assert.equal((await guess(`nobody${i}@example.com`, from(`2001:db8:1:2::${i.toString(16)}`))).status, 401);
  const banned = await guess("nobody@example.com", from("2001:db8:1:2:ffff::9"));
  assert.deepEqual([banned.status, banned.json.code], [429, "BANNED"]);
  // Banned on the owner's real password too, while a second client behind the same proxy signs in.
  assert.equal((await post("/sign-in/email", { email: OWNER, password: PASSWORD }, from("2001:db8:1:2::1"))).status, 429);
  assert.equal((await guess("nobody@example.com", from("198.51.100.20"))).status, 401);
  assert.equal((await post("/sign-in/email", { email: OWNER, password: PASSWORD }, from("198.51.100.21"))).json.twoFactorRedirect, true);
});

test("never locks the owner for strangers' failures from many addresses, and tells the owner once", async () => {
  // 32 failures, 4 from each of 8 addresses (under the 5-per-address lockout, under the ban); addresses in parallel.
  await Promise.all(Array.from({ length: 8 }, async (_, a) => { for (let i = 0; i < 4; i++) assert.equal((await guess(OWNER, from(`203.0.113.${10 + a}`))).status, 401); }));
  const alerts = lines.filter((l) => l.includes("Sign-in attempts"));
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes(`for ${OWNER}`));
  assert.ok(alerts[0].includes("from 8 addresses"));
  assert.equal((await guess(OWNER, from("203.0.113.30"))).status, 401);
  assert.equal(lines.filter((l) => l.includes("Sign-in attempts")).length, 1); // once an hour, not per failure
  // The owner, from his own address, signs all the way in; the new device's session tells him, with time and address.
  const step1 = await post("/sign-in/email", { email: OWNER, password: PASSWORD }, from("192.0.2.44"));
  assert.equal(step1.json.twoFactorRedirect, true);
  assert.equal(lines.some((l) => l.includes("New admin sign-in")), false); // the password step opens no session
  assert.equal((await post("/two-factor/verify-totp", { code: totp(totpURI, 1) }, from("192.0.2.44"), step1.cookie)).status, 200);
  const notice = lines.find((l) => l.includes("New admin sign-in"));
  assert.match(notice, new RegExp(`${OWNER} from 192\\.0\\.2\\.44 at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC`));
});

test("ignores a named address, X-Forwarded-For and CF-Connecting-IP without the front door's secret", async (t) => {
  t.after(() => closeAll());
  const forged = (i) => ({ "x-aidenhq-client-ip": `10.7.0.${i}`, "x-aidenhq-edge": "not the secret", "x-forwarded-for": `10.8.0.${i}`, "cf-connecting-ip": `10.9.0.${i}` });
  // Failures from "five addresses" are one unidentified peer's: two free, then held (429), and an address the front
  // door names still gets in.
  for (let i = 0; i < 3; i++) assert.equal((await guess(OWNER, forged(i))).status, 401);
  for (let i = 3; i < 5; i++) assert.equal((await guess(OWNER, forged(i))).status, 429);
  assert.equal((await post("/sign-in/email", { email: OWNER, password: PASSWORD }, forged(9))).status, 429);
  assert.equal((await post("/sign-in/email", { email: OWNER, password: PASSWORD }, from("192.0.2.45"))).json.twoFactorRedirect, true);
});

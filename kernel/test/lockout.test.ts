// The sign-in listener's lockout (ported from services/board/test/lockout.test.ts). Its own file: Better Auth's rate limit
// (memory, per address, shared by every instance in a process) would otherwise count other files' sign-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAccounts } from "../src/accounts.ts";
import { createSignin } from "../src/signin.ts";
import { PASSWORD, call, silent, stepListener, totp } from "./auth-helpers.ts";
import { serve } from "./helpers.ts";

const GATE_SECRET = "g".repeat(64);
const gate = () => ({ password: true, myAppsHost: "apps.example.com", appHosts: ["crm.example.com"] });

test("the sign-in listener trusts the client-IP header only with the gate's secret, and the internet can't pause the owner's sign-in on the admin listener", async (t) => {
  const accounts = await openAccounts({ dataDir: ":memory:", hosts: ["localhost:3120", "127.0.0.1:3129"], adminUrl: "http://localhost:3120", gate, gateSecret: () => GATE_SECRET, edgeSecret: () => "", notify: () => {}, log: silent });
  const local = await stepListener(accounts);
  const signin = await serve(createSignin({ accounts, hosts: ["127.0.0.1:3129"], gate, log: silent }));
  t.after(() => { local.close(); signin.s.close(); accounts.close(); });
  const onLocal = (path, body, cookie = "") => call(local.url, "POST", `/api/auth${path}`, { host: "localhost:3120", body, cookie });
  const onSignin = (body, headers = {}) => call(signin.url, "POST", "/.auth/api/sign-in/email", { host: "apps.example.com", https: true, body, headers });

  // The owner, enrolled (the sign-in listener refuses an admin without an authenticator).
  const { url } = await accounts.setup("owner@example.com", "Owner");
  assert.equal((await onLocal("/reset-password", { token: url.split("token=").pop(), newPassword: PASSWORD })).status, 200);
  const signedIn = await onLocal("/sign-in/email", { email: "owner@example.com", password: PASSWORD });
  const enable = await onLocal("/two-factor/enable", { password: PASSWORD }, signedIn.cookie);
  assert.equal((await onLocal("/two-factor/verify-totp", { code: totp(enable.json.totpURI) }, signedIn.cookie)).status, 200);

  const wrong = { email: "owner@example.com", password: "wrong password!!" };
  // Without the secret a named address is ignored: five failures from "five addresses" are the shared peer's, which is
  // slowed, never locked (a lock there would lock everyone behind it out). A Tailscale-User-Login header names nobody here.
  const forged = (i) => ({ "x-aidenhq-client-ip": `10.5.0.${i}`, "x-aidenhq-gate": "not the secret", "tailscale-user-login": `login-${i}@example.com` });
  for (let i = 0; i < 3; i++) assert.equal((await onSignin(wrong, forged(i))).status, 401);
  for (let i = 3; i < 5; i++) assert.equal((await onSignin(wrong, forged(i))).status, 429);
  assert.equal((await onSignin({ email: "owner@example.com", password: PASSWORD }, { "x-aidenhq-client-ip": "10.5.1.1" })).status, 429);
  // 20 failures through the gate (the three above count too) pause the account there, never on the admin listener.
  for (let i = 0; i < 17; i++) assert.equal((await onSignin(wrong, { "x-aidenhq-client-ip": `10.6.0.${i}`, "x-aidenhq-gate": GATE_SECRET })).status, 401);
  assert.equal((await onSignin({ email: "owner@example.com", password: PASSWORD }, { "x-aidenhq-client-ip": "10.6.1.1", "x-aidenhq-gate": GATE_SECRET })).status, 403);
  assert.equal((await onLocal("/sign-in/email", { email: "owner@example.com", password: PASSWORD })).json.twoFactorRedirect, true);
});

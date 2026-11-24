// The test user's session is never an admin's and never the board's (docs/design/access.md, Test-user sign-in): the kernel's
// own admin session and the gate's get-session both refuse it by name, and the account the kernel made is a plain `user`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccounts } from "../src/accounts.ts";
import { reqWith, silent } from "./auth-helpers.ts";

const EMAIL = "canary@aidenhq.test";
const APP = "roadmap";
const HOST = { admin: "localhost:3120", gate: "127.0.0.1:3129", signin: "apps.example.com", app: "roadmap.example.com" };
const TASK = "00000000-0000-4000-8000-0000000000a1";
const AGENT = "00000000-0000-4000-8000-00000000red1";

let accounts: any, gateAccountsFile: string;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "test-session-admin-"));
  mkdirSync(join(dir, "gate"));
  gateAccountsFile = join(dir, "gate", "accounts.json");
  accounts = await openAccounts({
    dataDir: ":memory:", hosts: [HOST.admin, HOST.gate], adminUrl: "http://localhost:3120",
    gate: () => ({ password: true, myAppsHost: HOST.signin, appHosts: [HOST.app], apps: { [APP]: { host: HOST.app }, other: { host: "other.example.com" } }, test: { email: EMAIL, apps: [APP] } }),
    gateAccountsFile, gateSecret: () => "g".repeat(64), edgeSecret: () => "", notify: () => {},
    task: async (id) => ({ id, identifier: "WOR-11495", status: "in_progress", assigneeAgentId: AGENT }),
    log: silent,
  });
});
after(() => accounts.close());

test("the test user is a plain user, never an admin, and its session opens neither the admin listener nor the gate", async () => {
  const m = await accounts.test.mint({ agentKey: "red-teamer", agentId: AGENT, task: TASK, app: APP });
  // The session row Better Auth will check is the 15-minute one, not Better Auth's default.
  const row = accounts.db.prepare("SELECT expiresAt FROM session WHERE id = ?").get(m.id) as { expiresAt: string | Date };
  assert.ok(Math.abs(new Date(row.expiresAt).getTime() - Date.parse(m.expires)) < 5_000, `${row.expiresAt} vs ${m.expires}`);
  assert.ok(Date.parse(m.expires) - Date.now() <= 15 * 60_000 + 5_000);
  const { token } = await accounts.test.redeem({ code: m.code, host: HOST.app, state: m.state });
  // The account the kernel made is a plain user, not an owner and not an admin — and not a board account at all.
  assert.equal((await accounts.list()).some((a: any) => a.email === EMAIL), false);
  assert.equal(accounts.isTestAccount(EMAIL), true);
  // The admin listener: the test session is no admin session, so the board is closed to it.
  assert.equal(await accounts.sessionOf(reqWith([["better-auth.session_token", token]], HOST.admin)), null);
  // The gate's get-session (the front door and the my-apps sign-in host): also refused.
  assert.equal(await accounts.gateSession({ headers: { host: HOST.signin, "x-forwarded-proto": "https", cookie: `__Host-better-auth.session_token=${token}` } }, HOST.signin), null);
  assert.equal(await accounts.gateSession({ headers: { host: HOST.app, "x-forwarded-proto": "https", cookie: `__Host-better-auth.session_token=${token}` } }, HOST.app, HOST.app), null);
  // App access resolves the test user as a member of the named app only: never admin, and blocked everywhere else, so its
  // page's own POST /.aidenhq/notify is the gate's handler and not a refusal.
  assert.equal(accounts.apps.effectiveRole(APP, EMAIL), "member");
  assert.equal(accounts.apps.effectiveRole("other", EMAIL), "blocked");
  assert.equal(accounts.apps.notify(APP, EMAIL).ok, true);
  assert.throws(() => accounts.apps.notify("other", EMAIL), /isn't shared with you/);
  // The gate's account map never carries the test user: no admin row, no board. An ordinary account change writes it.
  await accounts.test.revoke({ sessionId: m.id });
  const owner = await accounts.setup("owner@example.com", "Owner");
  await accounts.invite(owner.account, { email: "member@example.com", name: "Member", role: "user" });
  // An admin can neither promote nor disable it: it is not an account to manage, and it is never an admin.
  const testId = accounts.db.prepare("SELECT user_id FROM test_account WHERE email = ?").get(EMAIL).user_id;
  await assert.rejects(accounts.setRole(owner.account, testId, "admin"), /isn't an account to manage/);
  await assert.rejects(accounts.setDisabled(owner.account, testId, true), /isn't an account to manage/);
  await assert.rejects(accounts.reset(EMAIL), /isn't an account to manage/);
  assert.equal(accounts.apps.effectiveRole(APP, EMAIL), "member");
  const gate = JSON.parse(readFileSync(gateAccountsFile, "utf8"));
  assert.deepEqual(gate.accounts.map((a: any) => a.email), ["owner@example.com", "member@example.com"]);
});

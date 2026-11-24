// app-access.ts: the test user's role. It is a member of exactly the apps settings.edge.test_user names — resolved before any
// stored row — so an app admin's assignment could never take effect, and must be refused rather than logged as a block that
// does not. The gate resolves it through exportApps (accounts.json), which is what the listener reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AccessError, createAppAccess } from "../../modules/apps-platform/src/app-access.ts";

const APP = "roadmap-keeper";
const ADMIN = "admin@example.com";
const TEST_USER = "canary@example.test";

function access(o: { otherDefault?: string } = {}) {
  const db = new DatabaseSync(":memory:");
  return createAppAccess({
    db,
    gate: () => ({ password: false, apps: {
      [APP]: { host: "roadmap.example.com" },
      ...(o.otherDefault ? { "other-app": { host: "other.example.com", defaultRole: o.otherDefault } } : {}),
    } }),
    account: (email) => (email === ADMIN ? { role: "admin", disabled: false } : undefined),
    testMember: (app, email) => email === TEST_USER && app === APP,
    testAccount: (email) => email === TEST_USER,
    exported: async () => {},
    log: { info: () => {}, warn: () => {} },
  });
}

test("an app admin's row for the test user is refused, never logged as a block that does not take effect", async () => {
  const a = access();
  await assert.rejects(() => a.assign(ADMIN, APP, TEST_USER, "blocked"), (e: AccessError) => e.status === 400 && /settings\.edge\.test_user/.test(e.message));
  // No row was written, and the test account stays out of the gate's map (its role is resolved, never stored).
  const gates = a.exportApps();
  assert.equal(Object.values(gates[APP].roles).includes(TEST_USER), false);
});

test("an unrelated email's assignment still works", async () => {
  const a = access();
  await a.assign(ADMIN, APP, "person@example.com", "blocked");
  assert.equal(a.exportApps()[APP].roles["person@example.com"], "blocked");
});

// The test account is never an ordinary account: on an app settings.edge.test_user does not name it is blocked outright, so
// an app's default (or a stored row) cannot hand it access, and the feedback handler refuses it there too.
test("the test account is blocked on an app the setting does not name, whatever that app's default", () => {
  const a = access({ otherDefault: "member" });
  assert.equal(a.effectiveRole("other-app", TEST_USER), "blocked");
  assert.equal(a.effectiveRole(APP, TEST_USER), "member");
  assert.throws(() => a.notify("other-app", TEST_USER), (e: AccessError) => e.status === 403);
  // An ordinary account on the same app still gets its default.
  assert.equal(a.effectiveRole("other-app", "person@example.com"), "member");
});

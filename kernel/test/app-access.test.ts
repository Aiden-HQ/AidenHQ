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

function access() {
  const db = new DatabaseSync(":memory:");
  return createAppAccess({
    db,
    gate: () => ({ password: false, apps: { [APP]: { host: "roadmap.example.com" } } }),
    account: (email) => (email === ADMIN ? { role: "admin", disabled: false } : undefined),
    testMember: (app, email) => email === TEST_USER && app === APP,
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

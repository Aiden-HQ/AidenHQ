// ops/setup.sh's calls (replaces the board's internal-listener tests): the owner's first link and account resets, through
// the backplane's /v1/operator routes with the operator key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAccounts } from "../src/accounts.ts";
import { authApiServer, silent } from "./auth-helpers.ts";

test("operator setup prints the owner's first link once, only for owner_email; reset returns the one-time link", async (t) => {
  const accounts = await openAccounts({ dataDir: ":memory:", hosts: ["localhost:3120"], adminUrl: "http://localhost:3120", ownerEmail: () => "owner@example.com", edgeSecret: () => "", notify: () => {}, log: silent });
  const api = await authApiServer(accounts);
  t.after(() => { api.close(); accounts.close(); });
  const body = { email: "Owner@Example.com", name: "Owner" };
  // A missing or wrong operator key (or the board's key) is 401, and creates nothing.
  assert.equal((await api.post("/v1/operator/setup", body)).status, 401);
  assert.equal((await api.post("/v1/operator/setup", body, { "x-operator-key": "wrong" })).status, 401);
  assert.equal((await api.post("/v1/operator/setup", body, { "x-operator-key": api.boardKey })).status, 401);
  assert.equal(accounts.hasOwner(), false);
  const ops = { "x-operator-key": api.operatorKey };
  // Only settings.owner_email may be the owner.
  assert.equal((await api.post("/v1/operator/setup", { email: "mallory@example.com", name: "M" }, ops)).status, 400);
  assert.equal(accounts.hasOwner(), false);
  const first = await api.post("/v1/operator/setup", body, ops);
  assert.equal(first.status, 200, first.body);
  assert.equal(first.json.account.email, "owner@example.com");
  assert.equal(first.json.account.owner, true);
  assert.match(first.json.url, /^http:\/\/localhost:3120\/auth\/set-password\?token=[\w-]+$/);
  assert.equal((await api.post("/v1/operator/setup", body, ops)).status, 409); // the second time
  assert.equal((await api.post("/v1/operator/setup", { email: "mallory@example.com", name: "M" }, ops)).status, 409);

  // Reset: the one-time link comes back to the operator, a fresh one each time.
  assert.equal((await api.post("/v1/operator/reset", { email: "owner@example.com" })).status, 401);
  assert.equal((await api.post("/v1/operator/reset", { email: "nobody@example.com" }, ops)).status, 404);
  const reset = await api.post("/v1/operator/reset", { email: "owner@example.com" }, ops);
  assert.equal(reset.status, 200, reset.body);
  assert.match(reset.json.url, /^http:\/\/localhost:3120\/auth\/set-password\?token=[\w-]+$/);
  assert.notEqual(reset.json.url, first.json.url); // a fresh link; the first no longer works
  const again = await api.post("/v1/operator/reset", { email: "owner@example.com" }, ops);
  assert.notEqual(again.json.url, reset.json.url); // a second reset invalidates the first link
});

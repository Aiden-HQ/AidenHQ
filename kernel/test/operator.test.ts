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

test("only the host can mint a link: the operator key is mounted into no container, and a missing key fails closed", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const { OPERATOR_KEY } = await import("../src/auth-api.ts");
  const root = new URL("../../", import.meta.url);
  // A compile-generated kernel secret (a module declaring it fails compile: scripts/modules.ts), read by the kernel on the host.
  assert.ok(JSON.parse(readFileSync(new URL("kernel/defaults.json", root), "utf8")).generated_secrets.includes(OPERATOR_KEY));
  assert.match(readFileSync(new URL("kernel/src/main.ts", root), "utf8"), /operatorKey: \(\) => secret\(OPERATOR_KEY\)/);
  const compose = parse(readFileSync(new URL("compose.yaml", root), "utf8"));
  assert.ok(!(OPERATOR_KEY in (compose.secrets ?? {})), "compose.yaml declares no such secret");
  for (const [name, svc] of Object.entries(compose.services ?? {}))
    assert.ok(!(svc.secrets ?? []).some((s) => (typeof s === "string" ? s : s.source) === OPERATOR_KEY), `service ${name} mounts ${OPERATOR_KEY}`);
  // The board's own key gets no link from the kernel.
  const accounts = await openAccounts({ dataDir: ":memory:", hosts: ["localhost:3120"], adminUrl: "http://localhost:3120", ownerEmail: () => "owner@example.com", edgeSecret: () => "", notify: () => {}, log: silent });
  const api = await authApiServer(accounts, { operatorKey: "k".repeat(40) });
  try {
    await api.post("/v1/operator/setup", { email: "owner@example.com", name: "Owner" }, { "x-operator-key": api.operatorKey });
    const board = await api.post("/v1/operator/reset", { email: "owner@example.com" }, { "x-operator-key": "the-boards-operator-key" });
    assert.equal(board.status, 401);
    assert.equal(board.json?.url, undefined);
  } finally { api.close(); accounts.close(); }
  // An install whose key isn't generated yet fails closed.
  const accounts2 = await openAccounts({ dataDir: ":memory:", hosts: ["localhost:3120"], adminUrl: "http://localhost:3120", ownerEmail: () => "owner@example.com", edgeSecret: () => "", notify: () => {}, log: silent });
  const none = await authApiServer(accounts2, { operatorKey: "" });
  try {
    assert.equal((await none.post("/v1/operator/setup", { email: "owner@example.com", name: "Owner" })).status, 401);
    assert.equal((await none.post("/v1/operator/setup", { email: "owner@example.com", name: "Owner" }, { "x-operator-key": "" })).status, 401);
  } finally { none.close(); accounts2.close(); }
});

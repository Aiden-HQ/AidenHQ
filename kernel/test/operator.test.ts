// ops/setup.sh's calls (replaces the board's internal-listener tests): the owner's first link and account resets, through
// the backplane's /v1/operator routes with the operator key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAccounts } from "../src/accounts.ts";
import { authApiServer, silent } from "./auth-helpers.ts";

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

// Test-user sign-in's kernel half (kernel/src/test-user.ts): the job's token names the agent and task (never the body); only an
// app the owner named is reachable; the session is short, host- and app-bound, and never returned; a missing key fails closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestUser, publishedKeys, subOf } from "../src/test-user.ts";
import { ensureIdentityKeys } from "../../scripts/identity.ts";
import { createPublicKey, verify } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "test-user-"));
ensureIdentityKeys(dir);
const keyFile = join(dir, "identity", "test.pem");
const keysFile = join(dir, "identity", "keys.json");
const gate = { test_user: { email: "Probe@Example.com", apps: ["roadmap"] }, apps: { roadmap: { host: "ROADMAP.example.com" } }, hosts: { "roadmap.example.com": { app: "roadmap" }, "other.example.com": { app: "other" } } };

test("test user: the owner's named app, the job's agent and task, a single-use session the agent never sees", async () => {
  const sent = [], logged = [];
  const t = createTestUser({ job: () => ({ agent: "ag-1", task: "task-1" }), gate: () => gate, keyFile: () => keyFile, keysFile: () => keysFile, log: (o) => logged.push(o), send: async (r) => { sent.push(r); return { status: 201, headers: { "content-type": "application/json", "retry-after": "7", etag: "x" }, body: JSON.stringify({ ok: true }) }; } });
  const out = await t.run("job-token", { app: "roadmap", method: "POST", path: "/intake/feedback", body: { feedback: "x" } });
  await t.run("job-token", { app: "roadmap", method: "GET", path: "/intake" });
  assert.equal(out.status, 201);
  assert.equal(out.url, "https://roadmap.example.com/intake/feedback");
  assert.deepEqual(out.by, { agent: "ag-1", task: "task-1" });
  // Each use is attributable: the kernel's log names the agent, the task and the request, and never the token.
  assert.deepEqual(logged, [{ msg: "test sign-in", agent: "ag-1", task: "task-1", app: "roadmap", host: "roadmap.example.com", method: "POST", path: "/intake/feedback", status: 201 }, { msg: "test sign-in", agent: "ag-1", task: "task-1", app: "roadmap", host: "roadmap.example.com", method: "GET", path: "/intake", status: 201 }]);
  assert.equal(JSON.stringify(logged).includes("x-aidenhq-test-session"), false);
  assert.deepEqual(out.headers, { "content-type": "application/json", "retry-after": "7" }); // only what a check needs
  assert.equal(JSON.stringify(out).includes("x-aidenhq-test-session"), false);
  const [req] = sent;
  assert.equal(req.host, "roadmap.example.com");
  assert.equal(req.method, "POST");
  assert.equal(req.body, JSON.stringify({ feedback: "x" }));
  // The token: Ed25519, iss aidenhq-test, this host and app, the configured email and its sub, 60 seconds.
  const [h, p, s] = req.headers["x-aidenhq-test-session"].split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  assert.equal(claims.iss, "aidenhq-test");
  assert.equal(claims.aud, "roadmap.example.com");
  assert.equal(claims.app, "roadmap");
  assert.equal(claims.email, "probe@example.com");
  assert.equal(claims.sub, subOf("probe@example.com"));
  assert.equal(claims.exp - claims.iat, 60);
  // Two requests never share a session: each has its own jti (the gate accepts each once).
  const second = JSON.parse(Buffer.from(sent[1].headers["x-aidenhq-test-session"].split(".")[1], "base64url").toString("utf8"));
  assert.notEqual(second.jti, claims.jti);
  assert.deepEqual(logged.map((l) => l.status), [201, 201]);
  const jwk = publishedKeys(keysFile).find((k) => k.iss === "aidenhq-test");
  assert.ok(verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }), Buffer.from(s, "base64url")));
});

test("test user: an unnamed app, a bad path or method, a header outside the list, and a missing key are refused", async () => {
  const t = createTestUser({ job: () => ({ agent: "a", task: "t" }), gate: () => gate, keyFile: () => keyFile, keysFile: () => keysFile, send: async () => ({ status: 200, headers: {}, body: "" }) });
  await assert.rejects(t.run("tok", { app: "other", method: "GET", path: "/" }), /isn't one the test user may sign in to/);
  await assert.rejects(t.run("tok", { app: "roadmap", method: "GET", path: "//evil" }), /absolute path/);
  await assert.rejects(t.run("tok", { app: "roadmap", method: "TRACE", path: "/" }), /method must be one of/);
  await assert.rejects(t.run("tok", { app: "roadmap", method: "GET", path: "/", headers: { authorization: "x" } }), /headers may be/);
  const none = createTestUser({ job: () => ({ agent: "a", task: "t" }), gate: () => ({ ...gate, test_user: undefined }), keyFile: () => keyFile, keysFile: () => keysFile, send: async () => ({ status: 200, headers: {}, body: "" }) });
  await assert.rejects(none.run("tok", { app: "roadmap", method: "GET", path: "/" }), /isn't one the test user may sign in to \(none configured\)/);
  const missing = createTestUser({ job: () => ({ agent: "a", task: "t" }), gate: () => gate, keyFile: () => join(dir, "nope.pem"), keysFile: () => keysFile, send: async () => ({ status: 200, headers: {}, body: "" }) });
  await assert.rejects(missing.run("tok", { app: "roadmap", method: "GET", path: "/" }), /no test-signing key/);
});

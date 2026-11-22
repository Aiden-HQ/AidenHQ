// Test-user sign-in's kernel half (kernel/src/test-user.ts): the job's token names the agent and task (never the body); only an
// app the owner named is reachable; the session is short, host- and app-bound, and never returned; a missing key fails closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestUser, publishedKeys, subOf } from "../src/test-user.ts";
import { ensureIdentityKeys } from "../../scripts/identity.ts";
import { createPublicKey, verify } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "test-user-"));
ensureIdentityKeys(dir);
const keyFile = join(dir, "identity", "test.pem");
const keysFile = join(dir, "identity", "keys.json");
const gate = { test_user: { email: "Probe@Example.com", apps: ["roadmap"] }, test_port: 1, apps: { roadmap: { host: "ROADMAP.example.com" } }, hosts: { "roadmap.example.com": { app: "roadmap" }, "other.example.com": { app: "other" } } };

test("test user: the owner's named app, the job's agent and task, a single-use session the agent never sees", async () => {
  const sent = [], logged = [];
  const t = createTestUser({ job: () => ({ agent: "ag-1", task: "task-1" }), gate: () => gate, keyFile: () => keyFile, keysFile: () => keysFile, log: (o) => logged.push(o), send: async (r) => { sent.push(r); return { status: 201, headers: { "content-type": "application/json", "retry-after": "7", etag: "x" }, body: JSON.stringify({ ok: true }) }; } });
  const out = await t.run("job-token", { app: "roadmap", method: "POST", path: "/intake/feedback", body: { feedback: "x" } });
  await t.run("job-token", { app: "roadmap", method: "GET", path: "/intake?token=do-not-log-me" });
  assert.equal(out.status, 201);
  assert.equal(out.url, "https://roadmap.example.com/intake/feedback");
  assert.deepEqual(out.by, { agent: "ag-1", task: "task-1" });
  // Each use is attributable: the kernel's log names the agent, the task and the request, and never the token.
  assert.deepEqual(logged.slice(0, 2), [{ msg: "test sign-in", agent: "ag-1", task: "task-1", app: "roadmap", host: "roadmap.example.com", method: "POST", route: "/intake/feedback", status: 201 }, { msg: "test sign-in", agent: "ag-1", task: "task-1", app: "roadmap", host: "roadmap.example.com", method: "GET", route: "/intake", status: 201 }]);
  assert.equal(JSON.stringify(logged).includes("do-not-log-me"), false); // a query string never reaches the log
  assert.equal(JSON.stringify(logged).includes("x-aidenhq-test-session"), false);
  assert.deepEqual(out.headers, { "content-type": "application/json", "retry-after": "7" }); // only what a check needs
  assert.equal(JSON.stringify(out).includes("x-aidenhq-test-session"), false);
  // The body's byte length, not its character count: a multi-byte body goes out as the bytes the gate reads.
  await t.run("job-token", { app: "roadmap", method: "POST", path: "/intake", body: { correction: "é" } });
  const wt = sent.at(-1);
  assert.equal(wt.headers["content-length"], String(Buffer.byteLength(wt.body)));
  assert.notEqual(wt.headers["content-length"], String(wt.body.length));
  await t.run("job-token", { app: "roadmap", method: "GET", path: "/" });
  assert.equal(sent.at(-1).headers["content-length"], undefined); // no body, no stated length
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
  assert.deepEqual(logged.map((l) => l.status), [201, 201, 201, 201]);
  assert.deepEqual(logged.map((l) => l.route), ["/intake/feedback", "/intake", "/intake", "/"]); // never the query string
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

test("test user: a response that ends mid-body is refused, not handed back as a whole one", async () => {
  // A gate double that promises 100 bytes, writes a few, and drops the connection: a truncated answer.
  const broken = createServer((q, r) => { r.writeHead(200, { "content-type": "application/json", "content-length": "100" }); r.write("{\"ok\":"); setTimeout(() => r.destroy(), 20); });
  const port = await new Promise<number>((ok) => broken.listen(0, "127.0.0.1", () => ok((broken.address() as { port: number }).port)));
  try {
    const t = createTestUser({ job: () => ({ agent: "a", task: "t" }), gate: () => ({ ...gate, test_port: port }), keyFile: () => keyFile, keysFile: () => keysFile });
    await assert.rejects(t.run("tok", { app: "roadmap", method: "GET", path: "/" }), /interrupted/);
  } finally { broken.close(); broken.closeAllConnections(); }
});

// The request goes to the gate's compiled test_port: a send double (as main.ts wires) sees no port, but the real client
// goes there, and a config without one is refused rather than sent to a guessed default.
test("test user: the request goes to the gate's compiled test_port, not the gate's main port", async () => {
  const hits = [];
  const srv = createServer((q, r) => { hits.push(q.headers.host); r.writeHead(200, { "content-type": "text/plain" }).end("ok"); });
  const port = await new Promise<number>((ok) => srv.listen(0, "127.0.0.1", () => ok((srv.address() as { port: number }).port)));
  try {
    const t = createTestUser({ job: () => ({ agent: "a", task: "t" }), gate: () => ({ ...gate, test_port: port }), keyFile: () => keyFile, keysFile: () => keysFile });
    const out = await t.run("tok", { app: "roadmap", method: "GET", path: "/" });
    assert.equal(out.status, 200);
    assert.deepEqual(hits, ["roadmap.example.com"]);
  } finally { srv.close(); srv.closeAllConnections(); }
  // No compiled test_port: the gate never opened its test listener, so the kernel refuses instead of trying a default.
  const none = createTestUser({ job: () => ({ agent: "a", task: "t" }), gate: () => ({ ...gate, test_port: undefined }), keyFile: () => keyFile, keysFile: () => keysFile });
  await assert.rejects(none.run("tok", { app: "roadmap", method: "GET", path: "/" }), /no test listener/);
});

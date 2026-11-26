// Accounts and the kernel pages (lean 3a): the board's auth.db moves into the kernel with the owner's account and TOTP,
// the owner signs in on the admin listener and decides a card there; adversarial checks A6 and A7 (spec §8.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccounts } from "../src/accounts.ts";
import { createAdmin } from "../src/admin.ts";
import { openRecords } from "../src/records.ts";
import { authSecret, tailnetPeer } from "../src/auth-rules.ts";
import { createChannels } from "../src/channels.ts";
import { serve } from "./helpers.ts";

// Made by the board's own code on origin/main before 3a (services/board createAccounts: setup link, password, TOTP enrolled).
const FIXTURE = new URL("./fixtures/board-auth/", import.meta.url).pathname;
const OWNER = JSON.parse(readFileSync(join(FIXTURE, "owner.json"), "utf8"));
const HOST = "localhost:3120";
const FRONT = "admin.example.com:8444"; // the front door (tailscale serve): https, its own origin
const silent = { info() {}, warn() {}, error() {} };
const csp = (r) => String(r.headers["content-security-policy"]);

/** RFC 6238 (SHA-1, 6 digits, 30 s), `step` periods from now. */
function totp(b32, step = 0) {
  let bits = "";
  for (const c of b32.replace(/=+$/, "")) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + step));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A data dir holding the board's accounts where 3a finds them (data/board/). */
function kernelData() {
  const dir = mkdtempSync(join(tmpdir(), "kernel-auth-"));
  mkdirSync(join(dir, "kernel", "auth"), { recursive: true });
  for (const f of ["auth.db", "auth.secret"]) copyFileSync(join(FIXTURE, f), join(dir, "kernel", "auth", f));
  return dir;
}

/** A browser against one listener: keeps cookies, posts forms from `origin` (its own, unless a test says otherwise). */
function browser(url, host = HOST, https = false, extra = {}) {
  const jar = new Map();
  return async (method, path, form, origin = `${https ? "https" : "http"}://${host}`) => {
    const body = form && new URLSearchParams(form).toString();
    const headers = { host, ...extra, ...(https ? { "x-forwarded-proto": "https" } : {}), ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) } : {}) };
    const res = await new Promise((ok, no) => {
      const r = request(`${url}${path}`, { method, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, html: d })); });
      r.on("error", no);
      r.end(body);
    });
    for (const c of res.headers["set-cookie"] ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      if (/max-age=0/i.test(c) || i === kv.length - 1) jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { ...res, csrf: /name="csrf" value="([0-9a-f]+)"/.exec(res.html)?.[1] };
  };
}

/** The kernel's admin listener over accounts in `dir`, with two records waiting for the owner: the runner's push and a module's. */
async function adminOn(t, dir, now, boardUrl) {
  const notices = [];
  const accounts = await openAccounts({ dataDir: dir, hosts: [HOST, FRONT], origins: [`https://${FRONT}`], edgeSecret: () => "edge-secret", notify: (l) => notices.push(l), log: silent, ...(now ? { now } : {}) });
  const decided = [];
  const records = openRecords(join(dir, "kernel.db"));
  const card = { sentence: "Push the fix.", changes: "c", reads: "r", cost: "0", details: "" };
  const file = (kind, module) => records.file({ kind, module, args: { kind }, targets: {}, executor: { module }, policy: "p", tier: 2, card, requester: { agent: "", key: "ada", name: "ada", roles: [], kind: "run" }, task: "t-7", identifier: "WOR-7", state: "owner" });
  const push = file("runner.push", "runner");
  const deploy = file("acme.deploy", "acme");
  const writes = { decide: (id, b) => (decided.push({ id, ...b }), { task: "t-7", identifier: "WOR-7", card: { sentence: "Deploy." }, state: "approved" }) };
  const channels = createChannels({ db: records.db, records, writes, board: async () => ({ status: 404, json: {} }), owner: async () => ({ status: 200, json: {} }), modules: () => ({}) });
  const { s, url } = await serve(createAdmin({ accounts, ...(boardUrl ? { boardUrl: () => boardUrl } : {}), ownerMessage: async () => ({ task: { identifier: "WOR-1" } }), owner: async () => ({ status: 200, json: {} }), hosts: () => [HOST, FRONT], origins: () => [`http://${HOST}`, `https://${FRONT}`], frameOrigins: () => ["https://board.example.com"] }));
  t.after(() => { s.close(); accounts.close(); });
  return { url, decided, notices, push, deploy };
}

/**
 * Password, then a code this accounts file hasn't spent (`spent`, one set per file): a code is single use, and a 30 s step
 * may turn between two sign-ins, so a fixed step offset can land on a code already used.
 */
async function signIn(b, spent = new Set()) {
  const pw = await b("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw });
  assert.equal(pw.status, 303, pw.html);
  assert.match(pw.headers.location, /^\/auth\/totp/);
  const fresh = [0, 1, -1].map((s) => totp(OWNER.b32, s)).find((c) => !spent.has(c));
  spent.add(fresh);
  const code = await b("POST", "/auth/totp", { code: fresh });
  assert.equal(code.status, 303, code.html);
  return code;
}

test("the account and TOTP sign in; an accounts file without its secret refuses", async (t) => {
  const dir = kernelData();

  const { url, notices } = await adminOn(t, dir);
  const b = browser(url);
  assert.equal((await b("GET", "/approvals")).status, 303); // signed out: to the sign-in page
  await signIn(b);
  assert.match(notices.join("\n"), /New admin sign-in.*owner@example\.com/); // the owner hears of every new admin session
  const list = await b("GET", "/approvals");
  assert.deepEqual([list.status, list.headers.location], [303, "/#/"]); // the board (Home) is the one approvals UI

  // An accounts file without its secret refuses (a new secret would void every TOTP); a fresh install makes both.
  const bare = mkdtempSync(join(tmpdir(), "kernel-auth-"));
  copyFileSync(join(FIXTURE, "auth.db"), join(bare, "auth.db"));
  assert.throws(() => authSecret(join(bare, "auth.db")), /without its auth\.secret/);
});

test("the kernel's approval addresses go to the board's approvals; nothing is decided on a kernel page", async (t) => {
  const dir = kernelData();
  const { url, decided, push } = await adminOn(t, dir, undefined, "https://board.example.com");
  const b = browser(url);
  await signIn(b);
  for (const [path, to] of [["/", "/#/"], ["/approvals", "/#/"], [`/approvals/${push.id}`, `/#/approvals/${push.id}`]]) {
    const r = await b("GET", path);
    assert.deepEqual([r.status, r.headers.location], [303, `https://board.example.com${to}`], path);
  }
  const csrf = (await b("GET", "/auth/password")).csrf;
  assert.ok(csrf);
  for (const path of [`/approvals/${push.id}/decide`, "/approvals/batch"]) assert.equal((await b("POST", path, { digest: push.digest, decision: "approve", item: `${push.id}:${push.digest}`, csrf })).status, 404, path);
  assert.equal(decided.length, 0);
  assert.equal((await browser(url, "evil.example:3120")("GET", "/approvals")).status, 421);
});

test("a form from an origin the listener doesn't accept names both sides; a missing Origin says so; a long one is cut", async (t) => {
  const dir = kernelData();
  const { url } = await adminOn(t, dir);
  const b = browser(url);
  const accepted = [`http://${HOST}`, `https://${FRONT}`];
  const foreign = "http://localhost:3121"; // the board's port, not the admin listener's
  const r = await b("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw }, foreign);
  assert.equal(r.status, 403, r.html);
  assert.match(r.html, new RegExp(foreign.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const o of accepted) assert.ok(r.html.includes(o), o);

  const none = await b("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw }, "");
  assert.equal(none.status, 403, none.html);
  assert.match(none.html, /no Origin/);
  for (const o of accepted) assert.ok(none.html.includes(o), o);

  const long = `http://${"a".repeat(5000)}.example`;
  const cut = await b("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw }, long);
  assert.equal(cut.status, 403, cut.html);
  assert.match(cut.html, /\(cut\)/);
  assert.ok(!cut.html.includes(long), "the whole oversized Origin is not echoed");
});

// Last: its burst spends Better Auth's per-address limit for the shared loopback peer (module-wide memory) for a minute.
test("every kernel page refuses a frame (A7); unidentified guessing hits its ceiling while the owner over the tailnet signs in; a forged tailnet identity counts for nothing", async (t) => {
  const dir = kernelData();
  let clock = Date.now();
  const { url, notices } = await adminOn(t, dir, () => clock);
  const b = browser(url);
  for (const path of ["/auth/sign-in", "/auth/set-password?token=x", "/nope"]) {
    const r = await b("GET", path);
    assert.match(csp(r), /frame-ancestors 'none'/, path);
    assert.equal(r.headers["x-frame-options"], "DENY", path);
  }
  // tailscale serve's requests are one peer, whatever login they name: only from the host's loopback, on the admin listener,
  // without the front door's header; never on the gate's sign-in listener (3129).
  const req = (peer, extra = {}) => ({ headers: { "tailscale-user-login": "owner@example.com", ...extra }, socket: { remoteAddress: peer } });
  assert.equal(tailnetPeer(req("127.0.0.1"), "admin"), "tailnet");
  assert.equal(tailnetPeer(req("127.0.0.1", { "tailscale-user-login": "someone-else@example.com" }), "admin"), "tailnet");
  assert.equal(tailnetPeer(req("198.51.100.4"), "admin"), "");
  assert.equal(tailnetPeer(req("127.0.0.1", { "x-aidenhq-edge": "forged" }), "admin"), "");
  assert.equal(tailnetPeer(req("127.0.0.1"), "signin"), "");

  // An unidentified stranger (a forged client address and a forged tailnet login, both beside the front door's header):
  // stepped holds, then after 10 failures in the hour no unidentified sign-in for that email, right password or not.
  const stranger = browser(url, HOST, false, { "x-aidenhq-client-ip": "198.51.100.9", "x-aidenhq-edge": "forged", "tailscale-user-login": "owner@example.com" });
  for (let i = 0; i < 10; i++) {
    clock += 301_000; // past the longest hold (5 minutes)
    assert.equal((await stranger("POST", "/auth/sign-in", { email: OWNER.email, password: `wrong-password-${i}` })).status, 401, `failure ${i + 1}`);
  }
  assert.equal((await stranger("POST", "/auth/sign-in", { email: OWNER.email, password: "too-soon" })).status, 429);
  clock += 301_000;
  const held = await stranger("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw });
  assert.equal(held.status, 429);
  assert.ok(Number(held.headers["retry-after"]) > 60, "held for the rest of the hour");
  assert.match(held.html, /Invalid email or password/); // nothing said about the account
  assert.match(notices.join("\n"), /Sign-in held.*owner@example\.com/);
  // The owner over the tailnet (tailscale serve, from loopback, with the login it passes on) is not held by any of it.
  const tailnet = (login) => browser(url, HOST, false, { "tailscale-user-login": login });
  const spent = new Set();
  await signIn(tailnet("owner@example.com"), spent);

  // A burst across 100 emails at once: at most 30 checks a minute run (the unidentified global cap; 4 at a time), the rest
  // wait (429), and the owner over the tailnet signs in meanwhile.
  const [burst] = await Promise.all([
    Promise.all(Array.from({ length: 100 }, (_, i) => b("POST", "/auth/sign-in", { email: `guess-${i}@example.com`, password: "wrong-password" }))),
    signIn(tailnet("owner@example.com"), spent),
  ]);
  const checked = burst.filter((r) => r.status === 401).length;
  assert.ok(checked <= 34, `${checked} password checks`); // 30 failures a minute, plus at most 4 already in flight
  assert.equal(burst.filter((r) => r.status === 429).length, 100 - checked);

  // An address the front door names (with its secret) is locked after five failures; the owner, from another, isn't.
  const named = (ip) => browser(url, HOST, false, { "x-aidenhq-client-ip": ip, "x-aidenhq-edge": "edge-secret" });
  const attacker = named("198.51.100.7");
  for (let i = 0; i < 5; i++) assert.equal((await attacker("POST", "/auth/sign-in", { email: OWNER.email, password: `wrong-password-${i}` })).status, 401);
  const locked = await attacker("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw });
  assert.equal(locked.status, 401);
  assert.match(locked.html, /too many failed sign-ins/);
  await signIn(named("198.51.100.6"), spent);

  // Signed in (on a fresh copy: TOTP steps above are spent), the pages a session reaches refuse frames too.
  const fresh = kernelData();
  const other = await adminOn(t, fresh);
  const o = browser(other.url, HOST, false, { "x-aidenhq-client-ip": "198.51.100.5", "x-aidenhq-edge": "edge-secret" });
  await signIn(o);
  for (const path of ["/auth/password"]) {
    const r = await o("GET", path);
    assert.equal(r.status, 200, path);
    assert.match(csp(r), /frame-ancestors 'none'/, path);
  }
  const frame = await o("GET", "/owner/message");
  assert.match(csp(frame), /frame-ancestors https:\/\/board\.example\.com/);
  assert.equal(frame.headers["x-frame-options"], undefined);

  // The tailnet is one peer whatever login it names, rate-limited only: sustained failures under varied logins never lock or
  // ban it; past 20 a minute it waits (429), and once the minute has passed the right password and code get in.
  const third = kernelData();
  let tclock = Date.now();
  const tn = await adminOn(t, third, () => tclock);
  const as = (login) => browser(tn.url, HOST, false, { "tailscale-user-login": login });
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    const r = await as(`login-${i}@example.com`)("POST", "/auth/sign-in", { email: OWNER.email, password: `wrong-password-${i}` });
    assert.doesNotMatch(r.html, /too many failed sign-ins|BANNED|an hour/);
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [...Array(20).fill(401), ...Array(5).fill(429)]);
  tclock += 61_000;
  await signIn(as("owner@example.com"));
});

test("wrong codes back off per account, whatever the peer: 100 from the tailnet reach the one-minute wait, and the owner's code works a minute after", async (t) => {
  // Every sign-in step keeps a rate limit (never `false`), the tailnet's included.
  const { authCore, openAuthDb } = await import("../src/auth-rules.ts");
  const rules = authCore({ db: openAuthDb(":memory:"), secret: "s".repeat(43), hosts: [HOST], linkTtlMs: 1000, mcpResource: "http://localhost:3121/mcp", log: silent }).options.rateLimit;
  assert.equal(rules.enabled, true);
  for (const p of ["/sign-in/email", "/two-factor/verify-totp"]) assert.deepEqual(rules.customRules[p], { window: 60, max: 20 });

  const dir = kernelData();
  let clock = Date.now();
  const { url } = await adminOn(t, dir, () => clock);
  const b = browser(url, HOST, false, { "tailscale-user-login": "owner@example.com" });
  const challenge = async () => assert.equal((await b("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw })).status, 303);
  const wrong = (i) => String((Number(totp(OWNER.b32)) + 1000 + i * 7) % 1_000_000).padStart(6, "0");
  let last;
  for (let i = 0; i < 100; i++) {
    if (i % 4 === 0) await challenge(); // Better Auth retires a challenge after a few wrong codes
    clock += 61_000; // past any wait, and the tailnet's per-minute window
    last = await b("POST", "/auth/totp", { code: wrong(i) });
    assert.equal(last.status, 401, `wrong code ${i + 1}`);
  }
  // Right after a failure, the next code waits the full minute (429 at once, nothing checked).
  const waiting = await b("POST", "/auth/totp", { code: wrong(100) });
  assert.equal(waiting.status, 429);
  assert.equal(waiting.headers["retry-after"], "60");
  // The attack stops: a minute later the owner's code gets in.
  clock += 60_000;
  await challenge();
  assert.equal((await b("POST", "/auth/totp", { code: totp(OWNER.b32) })).status, 303);

  // 20 codes at once for one account, from an address the front door names (no peer slot of its own): they are checked one
  // at a time (any that arrives while one is checked gets 429, Retry-After: 1), and the back-off stops them after five.
  const n = browser(url, HOST, false, { "x-aidenhq-client-ip": "198.51.100.3", "x-aidenhq-edge": "edge-secret" });
  assert.equal((await n("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw })).status, 303);
  const codes = await Promise.all(Array.from({ length: 20 }, (_, i) => n("POST", "/auth/totp", { code: wrong(200 + i) })));
  const checked = codes.filter((r) => r.status === 401).length;
  assert.ok(checked >= 1 && checked <= 5, `${checked} codes checked`);
  assert.ok(codes.some((r) => r.status === 429 && r.headers["retry-after"] === "1"), "a code that arrived during a check was refused");
  assert.equal(codes.filter((r) => r.status === 429).length, 20 - checked);
});

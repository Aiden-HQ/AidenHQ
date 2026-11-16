// Accounts and the kernel pages (lean 3a): the board's auth.db moves into the kernel with the owner's account and TOTP,
// the owner signs in on the admin listener and decides a card there; adversarial checks A6 and A7 (spec §8.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openAccounts } from "../src/accounts.ts";
import { createAdmin } from "../src/admin.ts";
import { authSecret } from "../src/auth-rules.ts";
import { accountsFile, moveAccounts } from "../src/auth-move.ts";
import { createChannels } from "../src/channels.ts";
import { serve } from "./helpers.mjs";

// Made by the board's own code on origin/main before 3a (services/board createAccounts: setup link, password, TOTP enrolled).
const FIXTURE = new URL("./fixtures/board-auth/", import.meta.url).pathname;
const OWNER = JSON.parse(readFileSync(join(FIXTURE, "owner.json"), "utf8"));
const HOST = "localhost:3120";
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
function boardData() {
  const dir = mkdtempSync(join(tmpdir(), "kernel-auth-"));
  mkdirSync(join(dir, "board"));
  for (const f of ["auth.db", "auth.secret"]) copyFileSync(join(FIXTURE, f), join(dir, "board", f));
  return dir;
}

/** A browser against one listener: keeps cookies, posts forms from `origin` (its own, unless a test says otherwise). */
function browser(url, host = HOST) {
  const jar = new Map();
  return async (method, path, form, origin = `http://${host}`) => {
    const body = form && new URLSearchParams(form).toString();
    const headers = { host, ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) } : {}) };
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

/** The kernel's admin listener over accounts in `dir`, with one card of the board's and one kernel record pending. */
async function adminOn(t, dir) {
  const accounts = await openAccounts({ dataDir: dir, hosts: [HOST], edgeSecret: () => "", notify: () => {}, log: silent });
  const decided = [];
  const card = (a) => ({ identifier: "WOR-7", action: "push", tier: 2, sentence: "Push the fix.", changes: "c", reads: "r", cost: "0", requestedBy: "ada", ...a });
  const board = async (method, path, body) => {
    if (path === "/internal/approvals?state=pending") return { status: 200, json: { approvals: [card({ id: "A0000aaaa", digest: "d-board" }), card({ id: "k-0000000000000001", digest: "d-kernel", action: "acme.deploy" })] } };
    if (path === "/internal/approvals?state=finished") return { status: 200, json: { approvals: [] } };
    if (method === "POST" && path === "/internal/owner/approvals/decide") { decided.push(body); return { status: 200, json: { identifier: "WOR-7", sentence: "Push the fix.", state: "approved" } }; }
    return { status: 404, json: {} };
  };
  const writes = { decide: (id, b) => (decided.push({ id, ...b }), { task: "WOR-7", card: { sentence: "Deploy." }, state: "approved" }) };
  const channels = createChannels({ db: new DatabaseSync(":memory:"), writes, board, owner: async () => ({ status: 200, json: {} }), modules: () => ({}) });
  const { s, url } = await serve(createAdmin({ accounts, cards: channels, ownerMessage: async () => ({ task: { identifier: "WOR-1" } }), owner: async () => ({ status: 200, json: {} }), hosts: () => [HOST], origin: () => "https://admin.example.com:8444", frameOrigins: () => ["https://board.example.com"] }));
  t.after(() => { s.close(); accounts.close(); });
  return { url, decided };
}

async function signIn(b, step = 0) {
  const pw = await b("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw });
  assert.equal(pw.status, 303, pw.html);
  assert.match(pw.headers.location, /^\/auth\/totp/);
  const code = await b("POST", "/auth/totp", { code: totp(OWNER.b32, step) });
  assert.equal(code.status, 303, code.html);
  return code;
}

test("move keeps the account and TOTP; a missing source refuses to start", async (t) => {
  const dir = boardData();
  // Not moved yet: the kernel refuses rather than open (and so create) an empty accounts file.
  assert.throws(() => accountsFile(dir), /still at/);
  await assert.rejects(openAccounts({ dataDir: dir, hosts: [HOST], edgeSecret: () => "", notify: () => {}, log: silent }), /still at/);
  assert.equal(moveAccounts(dir), "moved");
  assert.ok(!existsSync(join(dir, "board", "auth.db")) && existsSync(join(dir, "kernel", "auth", "auth.db")) && existsSync(join(dir, "kernel", "auth", "auth.secret")));
  // An older board started after a revert makes an empty file at the old path: never moved over the kernel's.
  writeFileSync(join(dir, "board", "auth.db"), "stale");
  writeFileSync(join(dir, "board", "auth.secret"), "stale");
  assert.equal(moveAccounts(dir), "present");

  const { url } = await adminOn(t, dir);
  const b = browser(url);
  assert.equal((await b("GET", "/approvals")).status, 303); // signed out: to the sign-in page
  await signIn(b);
  const list = await b("GET", "/approvals");
  assert.equal(list.status, 200);
  assert.match(list.html, /Push the fix\./);

  // An accounts file without its secret refuses (a new secret would void every TOTP); a fresh install makes both.
  const bare = mkdtempSync(join(tmpdir(), "kernel-auth-"));
  copyFileSync(join(FIXTURE, "auth.db"), join(bare, "auth.db"));
  assert.throws(() => authSecret(join(bare, "auth.db")), /without its auth\.secret/);
  const fresh = mkdtempSync(join(tmpdir(), "kernel-auth-"));
  assert.equal(moveAccounts(fresh), "fresh");
  assert.equal(accountsFile(fresh), join(fresh, "kernel", "auth", "auth.db"));
});

test("a card is decided on the kernel page, stamped with the admin's account; the board's origin and a page without the token can't", async (t) => {
  const dir = boardData();
  moveAccounts(dir);
  const { url, decided } = await adminOn(t, dir);
  const b = browser(url);
  await signIn(b);
  const page = await b("GET", "/approvals/A0000aaaa");
  assert.equal(page.status, 200);
  assert.ok(page.csrf);
  // A6: the board's JavaScript on the same host (another port: cookies ignore ports) posting here, and a forged form.
  assert.equal((await b("POST", "/approvals/A0000aaaa/decide", { digest: "d-board", decision: "approve", csrf: page.csrf }, "http://localhost:3121")).status, 403);
  assert.equal((await b("POST", "/approvals/A0000aaaa/decide", { digest: "d-board", decision: "approve", csrf: page.csrf }, "")).status, 403);
  assert.equal((await b("POST", "/approvals/A0000aaaa/decide", { digest: "d-board", decision: "approve" })).status, 403);
  assert.equal(decided.length, 0);

  const ok = await b("POST", "/approvals/A0000aaaa/decide", { digest: "d-board", decision: "approve", csrf: page.csrf });
  assert.equal(ok.status, 200, ok.html);
  assert.equal(decided.length, 1);
  assert.equal(decided[0].id, "A0000aaaa");
  assert.equal(decided[0].digest, "d-board");
  assert.match(decided[0].by, /^account:[\w-]+$/);
  assert.equal(decided[0].via, "web");
  // Several at once: each against the digest the owner saw; the kernel's record through the records.
  const batch = await b("POST", "/approvals/batch", { item: "k-0000000000000001:d-kernel", decision: "reject", csrf: page.csrf });
  assert.equal(batch.status, 200, batch.html);
  assert.deepEqual(decided[1], { id: "k-0000000000000001", digest: "d-kernel", decision: "reject", by: decided[0].by, via: "web" });

  // Signed out, a user's account and an unknown host never decide.
  const stranger = browser(url);
  assert.equal((await stranger("POST", "/approvals/A0000aaaa/decide", { digest: "d-board", decision: "approve" })).status, 401);
  const user = await stranger("POST", "/auth/sign-in", { email: "user@example.com", password: "x".repeat(12) });
  assert.equal(user.status, 401);
  assert.match(user.html, /no admin access/);
  assert.equal((await browser(url, "evil.example:3120")("GET", "/approvals")).status, 421);
  assert.equal(decided.length, 2);
});

test("every kernel page refuses a frame except the owner message frame (A7); five failed passwords pause sign-in", async (t) => {
  const dir = boardData();
  moveAccounts(dir);
  const { url } = await adminOn(t, dir);
  const b = browser(url);
  for (const path of ["/auth/sign-in", "/auth/set-password?token=x", "/nope"]) {
    const r = await b("GET", path);
    assert.match(csp(r), /frame-ancestors 'none'/, path);
    assert.equal(r.headers["x-frame-options"], "DENY", path);
  }
  for (let i = 0; i < 5; i++) assert.equal((await b("POST", "/auth/sign-in", { email: OWNER.email, password: `wrong-password-${i}` })).status, 401);
  const locked = await b("POST", "/auth/sign-in", { email: OWNER.email, password: OWNER.pw });
  assert.equal(locked.status, 401);
  assert.match(locked.html, /too many failed sign-ins/);

  // Signed in (on a fresh copy: the lockout above holds this one), the pages a session reaches refuse frames too.
  const fresh = boardData();
  moveAccounts(fresh);
  const other = await adminOn(t, fresh);
  const o = browser(other.url);
  await signIn(o, 1);
  for (const path of ["/approvals", "/approvals/A0000aaaa", "/auth/password"]) {
    const r = await o("GET", path);
    assert.equal(r.status, 200, path);
    assert.match(csp(r), /frame-ancestors 'none'/, path);
  }
  const frame = await o("GET", "/owner/message");
  assert.match(csp(frame), /frame-ancestors https:\/\/board\.example\.com/);
  assert.equal(frame.headers["x-frame-options"], undefined);
});

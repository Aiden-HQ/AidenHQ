// The real gate (modules/apps-platform/gate) in front of the real sign-in listener (3129) and the kernel's app access (ported from
// services/board/test/gate-seam.test.ts). Password mode: sign-in on the my-apps host (pages served by the gate itself), the
// one-time handoff to an app host, roles and the Access page, in-app requests and the agent's role changes. Access mode:
// an Access-verified email with no account gets the app's default role.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccounts } from "../src/accounts.ts";
import { createSignin } from "../src/signin.ts";
import { createGate } from "../../modules/apps-platform/gate/gate.ts";
import { ensureIdentityKeys } from "../../scripts/identity.ts";
import { serve } from "./helpers.ts";
import { silent } from "./auth-helpers.ts";

const GATE_SECRET = "b".repeat(64);
/** The identity token's claims as the app sees them (the gate's tests verify signatures with the app middleware). */
const who = (h) => JSON.parse(Buffer.from(String(h["x-aidenhq-identity"]).split(".")[1] ?? "", "base64url").toString());
const PASSWORD = "correct horse battery staple";
const MY = "apps.example.com";

const dir = mkdtempSync(join(tmpdir(), "gate-seam-"));
const accountsFile = join(dir, "accounts.json");
const apps = { crm: { host: "crm.example.com" }, wiki: { host: "wiki.example.com" } };
let password = true;
const gateInfo = () => ({ password, myAppsHost: MY, appHosts: Object.values(apps).map((a) => a.host), previews: true, apps, door: { base: "localhost", scheme: "http", port: 3130 } });
const manifests = {};
let accounts, signin, gate, app, gatePort = 0, authPort = 0;
const seen = [];
const wakes = []; // every feedback wake, as the kernel would hand it to Paperclip
const appPort = () => app.address().port;
const hostsConfig = () => Object.fromEntries(Object.entries(apps).map(([name, a]) => [a.host, { app: name, port: appPort() }]));
const baseConfig = (extra = {}) => ({ port: 0, login: "password", auth_url: `http://127.0.0.1:${authPort}`, auth_secret_file: join(dir, "board-secret"), accounts_file: accountsFile, identity_key_file: join(dir, "identity", "gate.pem"), owner_email: "owner@example.com", my_apps: { host: MY }, hosts: hostsConfig(), ...extra });

async function startGate(config, fetchImpl) {
  // cloudflared's listener (main.ts serves it on the tunnel's socket): the one that believes CF-Connecting-IP.
  const g = createGate({ config: () => config, log: () => {}, fromTunnel: true, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  await new Promise((r) => g.listen(0, "127.0.0.1", r));
  return g;
}

before(async () => {
  writeFileSync(join(dir, "board-secret"), GATE_SECRET);
  ensureIdentityKeys(dir);
  writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
  // The listener's own name is only known once it listens: hosts is read on each request.
  const hosts = [];
  accounts = await openAccounts({ dataDir: ":memory:", hosts: ["127.0.0.1:0"], adminUrl: "http://localhost:3120", gate: gateInfo, gateAccountsFile: accountsFile, gateSecret: () => GATE_SECRET, edgeSecret: () => "", notify: () => {}, manifest: async (a) => manifests[a] ?? { roles: [] }, feedbackWake: async (...args) => (wakes.push(args), true), log: silent });
  app = createServer((req, res) => (seen.push({ ...req.headers }), res.end("app")));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  signin = await serve(createSignin({ accounts, hosts, gate: gateInfo, log: silent }));
  authPort = signin.s.address().port;
  hosts.push(`127.0.0.1:${authPort}`);
  gate = await startGate(baseConfig());
  gatePort = gate.address().port;
});
after(() => { for (const s of [gate, signin.s, app]) s.close(); accounts.close(); });

/** A request through a gate, as cloudflared sends it (Host = the public name). */
function through(host, method, path, opts = {}) {
  const type = opts.form ? "application/x-www-form-urlencoded" : "application/json";
  const headers = { host, "cf-connecting-ip": opts.ip ?? "203.0.113.7", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(method !== "GET" ? { "content-type": type, origin: opts.origin ?? `https://${host}` } : {}), ...opts.headers };
  const body = opts.form ? new URLSearchParams(opts.form).toString() : opts.body;
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: opts.port ?? gatePort, method, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, location: String(res.headers.location ?? ""), cookies: res.headers["set-cookie"] ?? [], body: b, headers: res.headers }));
    });
    r.on("error", reject);
    r.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}
const cookieOf = (set, name) => set.map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`));

/** Claims an invite link on the my-apps host and signs in there: the session cookie. */
async function claim(url, email) {
  assert.equal((await through(MY, "POST", "/.auth/api/reset-password", { body: { token: url.split("#").pop(), newPassword: PASSWORD } })).status, 200);
  const signedIn = await through(MY, "POST", "/.auth/api/sign-in/email", { body: { email, password: PASSWORD } });
  assert.equal(signedIn.status, 200);
  assert.doesNotMatch(signedIn.body, /"token"/); // the gate never lets a session token out in a body
  return cookieOf(signedIn.cookies, "__Host-better-auth.session_token");
}
/** A new user account, signed in on the my-apps host. */
async function user(email, name) {
  const owner = (await accounts.list()).find((a) => a.owner);
  const { url } = await accounts.invite(owner, { email, name, role: "user" });
  return claim(url, email);
}
/** From the my-apps session to an app host's own session, through the one-time handoff. */
async function openApp(host, session, path = "/") {
  const first = await through(host, "GET", path);
  assert.equal(first.status, 302);
  const state = cookieOf(first.cookies, "__Host-better-auth.handoff_state");
  const go = await through(MY, "GET", new URL(first.location).pathname + new URL(first.location).search, { cookie: session });
  assert.match(go.location, new RegExp(`^https://${host.replace(/\./g, "\\.")}/\\.auth/handoff\\?code=`));
  const handoff = await through(host, "GET", new URL(go.location).pathname + new URL(go.location).search, { cookie: state });
  assert.deepEqual([handoff.status, handoff.location], [302, path]);
  return cookieOf(handoff.cookies, "__Host-aidenhq-gate.session");
}
const exported = () => JSON.parse(readFileSync(accountsFile, "utf8"));
const signInAs = async (email) => cookieOf((await through(MY, "POST", "/.auth/api/sign-in/email", { body: { email, password: PASSWORD } })).cookies, "__Host-better-auth.session_token");

test("the gate serves the sign-in pages itself; the kernel's listener serves none", async () => {
  const page = await through(MY, "GET", "/.auth/sign-in?next=" + encodeURIComponent("/.auth/go?to=crm.example.com&state=abc"));
  assert.equal(page.status, 200);
  assert.match(page.body, /<form id="password">/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(page.body, /data-next="\/\.auth\/go\?to=crm\.example\.com&#38;state=abc"/);
  // next: a same-host path only (no open redirect).
  for (const bad of ["https://evil.example.org/", "//evil.example.org/", "/\t/evil.example.org/", "/\\evil.example.org/"]) assert.doesNotMatch((await through(MY, "GET", "/.auth/sign-in?next=" + encodeURIComponent(bad))).body, /data-next/);
  assert.equal((await through(MY, "GET", "/.auth/two-factor")).status, 200);
  assert.equal((await through(MY, "GET", "/.auth/set-password")).status, 200);
  assert.equal((await through(MY, "GET", "/.auth/assets/auth.js")).status, 200);
  // The kernel's own listener answers none of them.
  const direct = (path) => new Promise((ok) => request({ host: "127.0.0.1", port: authPort, path, headers: { host: `127.0.0.1:${authPort}` } }, (res) => (res.resume(), ok(res.statusCode))).end());
  for (const p of ["/.auth/sign-in", "/.auth/two-factor", "/.auth/set-password", "/.auth/assets/auth.js"]) assert.equal(await direct(p), 404, p);
});

test("signs a user in on the my-apps host, hands off to the app host, and signs out there", async () => {
  await accounts.setup("owner@example.com", "Owner");
  await accounts.apps.setDefault("owner@example.com", "crm", "member");
  const uma = await user("uma@example.com", "Uma Ö");
  assert.match((await through(MY, "GET", "/", { cookie: uma })).body, /crm/);
  const appSession = await openApp("crm.example.com", uma, "/deals?x=1");

  // The app sees who it is, with the app's own gate secret; never an auth cookie or the board's secret.
  assert.equal((await through("crm.example.com", "GET", "/deals", { cookie: appSession, headers: { "x-aidenhq-role": "admin" } })).body, "app");
  const c = who(seen.at(-1));
  assert.deepEqual({ email: c.email, role: c.role, aud: c.aud, name: c.name, kind: c.kind, idp: c.idp }, { email: "uma@example.com", role: "member", aud: "crm", name: "Uma Ö", kind: "person", idp: "password" });
  assert.deepEqual(Object.keys(seen.at(-1)).filter((k) => k.startsWith("x-aidenhq-")), ["x-aidenhq-identity"]);
  assert.doesNotMatch(String(seen.at(-1).cookie ?? ""), /better-auth/);

  // Signing out on the app host ends that session.
  assert.equal((await through("crm.example.com", "POST", "/.auth/sign-out", { cookie: appSession, body: {} })).status, 303);
  assert.equal((await through("crm.example.com", "GET", "/deals", { cookie: appSession })).status, 302);
});

test("blocked is hidden and refused; an app admin assigns roles and names another admin; a dropped role resolves to blocked", async () => {
  const umaSession = await signInAs("uma@example.com");
  // The wiki starts blocked: off Uma's list, and refused.
  assert.doesNotMatch((await through(MY, "GET", "/", { cookie: umaSession })).body, /wiki\.example\.com/);
  const umaWiki = await openApp("wiki.example.com", umaSession);
  assert.equal((await through("wiki.example.com", "GET", "/", { cookie: umaWiki })).status, 403);

  // The owner names Ava an admin of the wiki (the board's App admins section calls the same function).
  const ava = await user("ava@example.com", "Ava");
  await accounts.apps.assign("owner@example.com", "wiki", "ava@example.com", "admin");
  const home = (await through(MY, "GET", "/", { cookie: ava })).body;
  assert.match(home, /https:\/\/wiki\.example\.com\//);
  assert.match(home, /\/access\?app=wiki/);
  assert.match((await through(MY, "GET", "/access?app=wiki", { cookie: ava })).body, /wiki: access/);
  assert.equal((await through(MY, "GET", "/access?app=crm", { cookie: ava })).status, 403);

  // Ava names Bob another admin (no account yet: inert until he has one), and gives Uma a custom role once the manifest declares it.
  const set = (form, origin) => through(MY, "POST", "/access", { cookie: ava, form: { app: "wiki", ...form }, origin });
  assert.equal((await set({ action: "role", email: "bob@example.com", role: "admin" })).status, 303);
  assert.equal((await set({ action: "role", email: "uma@example.com", role: "editor" })).status, 400);
  manifests.wiki = { roles: [{ name: "editor", meaning: "Edits pages." }] };
  await accounts.syncGate();
  assert.equal((await set({ action: "role", email: "uma@example.com", role: "editor" })).status, 303);
  assert.deepEqual({ bob: exported().apps.wiki.roles["bob@example.com"], uma: exported().apps.wiki.roles["uma@example.com"] }, { bob: "admin", uma: "editor" }); // on the gate when it returns
  assert.equal((await through("wiki.example.com", "GET", "/", { cookie: umaWiki })).status, 200);
  const c = who(seen.at(-1));
  assert.deepEqual({ email: c.email, role: c.role, aud: c.aud }, { email: "uma@example.com", role: "editor", aud: "wiki" });
  // Not from another site, never an AidenHQ admin, never admin as the default.
  assert.equal((await set({ action: "role", email: "eve@example.com", role: "member" }, "https://wiki.example.com")).status, 403);
  assert.equal((await set({ action: "role", email: "owner@example.com", role: "blocked" })).status, 400);
  assert.equal((await set({ action: "default", role: "admin" })).status, 400);
  const page = (await through(MY, "GET", "/access?app=wiki", { cookie: ava })).body;
  assert.match(page, /bob@example\.com/);
  assert.match(page, /Edits pages\./);

  // The manifest drops editor: Uma is blocked, her assignment kept and flagged for repair.
  manifests.wiki = { roles: [] };
  await accounts.syncGate();
  assert.equal((await through("wiki.example.com", "GET", "/", { cookie: umaWiki })).status, 403);
  assert.match((await through(MY, "GET", "/access?app=wiki", { cookie: ava })).body, /no longer declared/);
});

// App doors (docs/design/app-doors.md): the real gate's local door and the real kernel. The admin listener mints the code
// (handoff.test.ts drives its route); here the gate redeems it into the app host's own session, which counts on that host
// only and never as a kernel session.

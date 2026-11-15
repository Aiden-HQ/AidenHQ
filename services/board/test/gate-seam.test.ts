// The real gate (services/gate) in front of the real sign-in listener (3129) and the board's app access: lanes built against
// stubs of each other. Password mode: sign-in on the my-apps host, the one-time handoff to an app host, roles and the
// Access page, in-app requests and the agent's role changes. Access mode: an Access-verified email with no account gets the
// app's default role.
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccounts, type Accounts } from "../src/accounts.js";
import type { Manifest } from "../src/app-access.js";
import { createSigninServer } from "../src/signin.js";

const GATE_SECRET = "b".repeat(64);
/** The identity token's claims as the app sees them (the gate's tests verify signatures with the app middleware). */
const who = (h: Record<string, unknown>) => JSON.parse(Buffer.from(String(h["x-aidenhq-identity"]).split(".")[1] ?? "", "base64url").toString());
const PASSWORD = "correct horse battery staple";
const MY = "apps.example.com";

describe("the gate, the sign-in listener and app access", () => {
  const log = pino({ level: "silent" });
  const dir = mkdtempSync(join(tmpdir(), "gate-seam-"));
  const accountsFile = join(dir, "accounts.json");
  const apps = { crm: { host: "crm.example.com" }, wiki: { host: "wiki.example.com" } };
  let password = true;
  const gateInfo = () => ({ password, myAppsHost: MY, appHosts: Object.values(apps).map((a) => a.host), previews: true, apps });
  const manifests: Record<string, Manifest> = {};
  let accounts: Accounts;
  let signin: Server, gate: Server, app: Server;
  let gatePort = 0, authPort = 0;
  const seen: Record<string, unknown>[] = [];
  const hostsConfig = () => Object.fromEntries(Object.entries(apps).map(([name, a]) => [a.host, { app: name, port: (app.address() as AddressInfo).port }]));

  beforeAll(async () => {
    writeFileSync(join(dir, "board-secret"), GATE_SECRET);
    const { ensureIdentityKeys } = (await import("../../../scripts/identity.mjs" as string)) as { ensureIdentityKeys: (d: string) => string[] };
    ensureIdentityKeys(dir);
    writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
    accounts = await createAccounts({ dbPath: ":memory:", hosts: ["127.0.0.1:0"], boardUrl: "http://localhost:3120", gate: gateInfo, gateAccountsFile: accountsFile, gateSecret: GATE_SECRET, manifest: async (a) => manifests[a] ?? { roles: [] }, log });
    app = createServer((req, res) => (seen.push({ ...req.headers }), res.end("app")));
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    // The listener's own name is only known once it listens: hosts is read on each request.
    const hosts: string[] = [];
    signin = createSigninServer({ accounts, hosts, gate: gateInfo, log });
    await new Promise<void>((r) => signin.listen(0, "127.0.0.1", r));
    authPort = (signin.address() as AddressInfo).port;
    hosts.push(`127.0.0.1:${authPort}`);
    const config = { port: 0, login: "password", auth_url: `http://127.0.0.1:${authPort}`, auth_secret_file: join(dir, "board-secret"), accounts_file: accountsFile, identity_key_file: join(dir, "identity", "gate.pem"), owner_email: "owner@example.com", my_apps: { host: MY }, hosts: hostsConfig() };
    gate = await startGate(config);
    gatePort = (gate.address() as AddressInfo).port;
  });
  afterAll(() => {
    for (const s of [gate, signin, app]) s.close();
    accounts.close();
  });

  async function startGate(config: unknown, fetchImpl?: typeof fetch): Promise<Server> {
    const { createGate } = (await import("../../gate/gate.mjs" as string)) as { createGate: (o: unknown) => Server };
    const g = createGate({ config: () => config, log: () => {}, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    await new Promise<void>((r) => g.listen(0, "127.0.0.1", r));
    return g;
  }

  /** A request through a gate, as cloudflared sends it (Host = the public name). */
  function through(host: string, method: string, path: string, opts: { cookie?: string; body?: unknown; form?: Record<string, string>; origin?: string; ip?: string; port?: number; headers?: Record<string, string> } = {}) {
    const type = opts.form ? "application/x-www-form-urlencoded" : "application/json";
    const headers: Record<string, string> = { host, "cf-connecting-ip": opts.ip ?? "203.0.113.7", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(method !== "GET" ? { "content-type": type, origin: opts.origin ?? `https://${host}` } : {}), ...opts.headers };
    if (opts.form) opts = { ...opts, body: new URLSearchParams(opts.form).toString() };
    return new Promise<{ status: number; location: string; cookies: string[]; body: string }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: opts.port ?? gatePort, method, path, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, location: String(res.headers.location ?? ""), cookies: res.headers["set-cookie"] ?? [], body }));
      });
      r.on("error", reject);
      r.end(opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    });
  }
  const cookieOf = (set: string[], name: string) => set.map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`))!;

  /** Claims an invite link on the my-apps host and signs in there: the session cookie. */
  async function claim(url: string, email: string) {
    expect((await through(MY, "POST", "/.auth/api/reset-password", { body: { token: url.split("#").pop(), newPassword: PASSWORD } })).status).toBe(200);
    const signedIn = await through(MY, "POST", "/.auth/api/sign-in/email", { body: { email, password: PASSWORD } });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).not.toMatch(/"token"/);
    return cookieOf(signedIn.cookies, "__Host-better-auth.session_token");
  }
  /** A new user account, signed in on the my-apps host. */
  async function user(email: string, name: string) {
    const owner = (await accounts.list()).find((a) => a.owner)!;
    const { url } = await accounts.invite(owner, { email, name, role: "user" });
    return claim(url!, email);
  }
  /** From the my-apps session to an app host's own session, through the one-time handoff. */
  async function openApp(host: string, session: string, path = "/") {
    const first = await through(host, "GET", path);
    expect(first.status).toBe(302);
    const state = cookieOf(first.cookies, "__Host-better-auth.handoff_state");
    const go = await through(MY, "GET", new URL(first.location).pathname + new URL(first.location).search, { cookie: session });
    expect(go.location).toMatch(new RegExp(`^https://${host.replace(/\./g, "\\.")}/\\.auth/handoff\\?code=`));
    const handoff = await through(host, "GET", new URL(go.location).pathname + new URL(go.location).search, { cookie: state });
    expect([handoff.status, handoff.location]).toEqual([302, path]);
    return cookieOf(handoff.cookies, "__Host-better-auth.session_token");
  }
  const exported = () => JSON.parse(readFileSync(accountsFile, "utf8")) as { apps: Record<string, { default: string; roles: Record<string, string> }> };

  it("signs a user in on the my-apps host, hands off to the app host, and signs out there", async () => {
    await accounts.setup("owner@example.com", "Owner");
    await accounts.apps.setDefault("owner@example.com", "crm", "member");
    const uma = await user("uma@example.com", "Uma Ö");
    expect((await through(MY, "GET", "/", { cookie: uma })).body).toContain("crm");
    const appSession = await openApp("crm.example.com", uma, "/deals?x=1");

    // The app sees who it is, with the app's own gate secret; never an auth cookie or the board's secret.
    expect((await through("crm.example.com", "GET", "/deals", { cookie: appSession, headers: { "x-aidenhq-role": "admin" } })).body).toBe("app");
    expect(who(seen.at(-1)!)).toMatchObject({ email: "uma@example.com", role: "member", aud: "crm", name: "Uma Ö", kind: "person", idp: "password" });
    expect(Object.keys(seen.at(-1)!).filter((k) => k.startsWith("x-aidenhq-"))).toEqual(["x-aidenhq-identity"]);
    expect(String(seen.at(-1)!.cookie ?? "")).not.toContain("better-auth");

    // Signing out on the app host ends that session.
    expect((await through("crm.example.com", "POST", "/.auth/sign-out", { cookie: appSession, body: {} })).status).toBe(303);
    expect((await through("crm.example.com", "GET", "/deals", { cookie: appSession })).status).toBe(302);
  });

  it("a PR preview host has its app's access and its own identity; only previews apps-mcp names, in the band", async () => {
    const appPort = (app.address() as AddressInfo).port;
    const file = join(dir, "previews.json");
    writeFileSync(file, "{}");
    const config = { port: 0, login: "password", auth_url: `http://127.0.0.1:${authPort}`, auth_secret_file: join(dir, "board-secret"), accounts_file: accountsFile, identity_key_file: join(dir, "identity", "gate.pem"), owner_email: "owner@example.com", my_apps: { host: MY }, hosts: hostsConfig(), previews: { file, ports: [appPort, appPort] } };
    const g = await startGate(config);
    const port = (g.address() as AddressInfo).port;
    try {
      const uma = cookieOf((await through(MY, "POST", "/.auth/api/sign-in/email", { body: { email: "uma@example.com", password: PASSWORD } })).cookies, "__Host-better-auth.session_token");
      expect((await through("pr-4.crm.example.com", "GET", "/", { port })).status).toBe(404); // not running
      writeFileSync(file, JSON.stringify({ "crm-pr-4": appPort, "wiki-pr-2": appPort, "crm-pr-5": 3120 }));
      expect((await through("pr-5.crm.example.com", "GET", "/", { port })).status).toBe(404); // outside the band: never the board
      expect((await through("pr-4.nope.example.com", "GET", "/", { port })).status).toBe(404); // no such app host

      // The one-time handoff to the preview host (the board accepts it beside crm's), then crm's role, for the preview only.
      const first = await through("pr-4.crm.example.com", "GET", "/", { port });
      const state = cookieOf(first.cookies, "__Host-better-auth.handoff_state");
      const go = await through(MY, "GET", new URL(first.location).pathname + new URL(first.location).search, { cookie: uma, port });
      const handoff = await through("pr-4.crm.example.com", "GET", new URL(go.location).pathname + new URL(go.location).search, { cookie: state, port });
      const session = cookieOf(handoff.cookies, "__Host-better-auth.session_token");
      expect((await through("pr-4.crm.example.com", "GET", "/", { cookie: session, port })).body).toBe("app");
      expect(who(seen.at(-1)!)).toMatchObject({ email: "uma@example.com", role: "member", aud: "crm-pr-4" });
      expect((await through("pr-4.crm.example.com", "POST", "/.aidenhq/request", { cookie: session, port, body: { text: "hi" } })).status).toBe(404);
      // The wiki is blocked for Uma: so is its preview.
      const w = await through("pr-2.wiki.example.com", "GET", "/", { port });
      const wgo = await through(MY, "GET", new URL(w.location).pathname + new URL(w.location).search, { cookie: uma, port });
      const wh = await through("pr-2.wiki.example.com", "GET", new URL(wgo.location).pathname + new URL(wgo.location).search, { cookie: cookieOf(w.cookies, "__Host-better-auth.handoff_state"), port });
      expect((await through("pr-2.wiki.example.com", "GET", "/", { cookie: cookieOf(wh.cookies, "__Host-better-auth.session_token"), port })).status).toBe(403);
    } finally {
      g.close();
    }
  });

  it("blocked is hidden and refused; an app admin assigns roles and names another admin; a dropped role resolves to blocked", async () => {
    const uma = (await through(MY, "POST", "/.auth/api/sign-in/email", { body: { email: "uma@example.com", password: PASSWORD } })).cookies;
    const umaSession = cookieOf(uma, "__Host-better-auth.session_token");
    // The wiki starts blocked: off Uma's list, and refused.
    expect((await through(MY, "GET", "/", { cookie: umaSession })).body).not.toContain("wiki.example.com");
    const umaWiki = await openApp("wiki.example.com", umaSession);
    expect((await through("wiki.example.com", "GET", "/", { cookie: umaWiki })).status).toBe(403);

    // The owner names Ava an admin of the wiki (the board's App admins section calls the same function).
    const ava = await user("ava@example.com", "Ava");
    await accounts.apps.assign("owner@example.com", "wiki", "ava@example.com", "admin");
    const home = (await through(MY, "GET", "/", { cookie: ava })).body;
    expect(home).toContain("https://wiki.example.com/");
    expect(home).toContain("/access?app=wiki");
    expect((await through(MY, "GET", "/access?app=wiki", { cookie: ava })).body).toContain("wiki: access");
    expect((await through(MY, "GET", "/access?app=crm", { cookie: ava })).status).toBe(403);

    // Ava names Bob another admin (no account yet: inert until he has one), and gives Uma a custom role once the manifest declares it.
    const set = (form: Record<string, string>, origin?: string) => through(MY, "POST", "/access", { cookie: ava, form: { app: "wiki", ...form }, origin });
    expect((await set({ action: "role", email: "bob@example.com", role: "admin" })).status).toBe(303);
    expect((await set({ action: "role", email: "uma@example.com", role: "editor" })).status).toBe(400);
    manifests.wiki = { roles: [{ name: "editor", meaning: "Edits pages." }] };
    await accounts.syncGate();
    expect((await set({ action: "role", email: "uma@example.com", role: "editor" })).status).toBe(303);
    expect(exported().apps.wiki!.roles).toMatchObject({ "bob@example.com": "admin", "uma@example.com": "editor" }); // on the gate when it returns
    expect((await through("wiki.example.com", "GET", "/", { cookie: umaWiki })).status).toBe(200);
    expect(who(seen.at(-1)!)).toMatchObject({ email: "uma@example.com", role: "editor", aud: "wiki" });
    // Not from another site, never an AidenHQ admin, never admin as the default.
    expect((await set({ action: "role", email: "eve@example.com", role: "member" }, "https://wiki.example.com")).status).toBe(403);
    expect((await set({ action: "role", email: "owner@example.com", role: "blocked" })).status).toBe(400);
    expect((await set({ action: "default", role: "admin" })).status).toBe(400);
    const page = (await through(MY, "GET", "/access?app=wiki", { cookie: ava })).body;
    expect(page).toContain("bob@example.com");
    expect(page).toContain("Edits pages.");

    // The manifest drops editor: Uma is blocked, her assignment kept and flagged for repair.
    manifests.wiki = { roles: [] };
    await accounts.syncGate();
    expect((await through("wiki.example.com", "GET", "/", { cookie: umaWiki })).status).toBe(403);
    expect((await through(MY, "GET", "/access?app=wiki", { cookie: ava })).body).toContain("no longer declared");
  });

  it("in-app requests: a member's can't change roles, an admin's can; the requester sees the reply", async () => {
    const umaSession = cookieOf((await through(MY, "POST", "/.auth/api/sign-in/email", { body: { email: "uma@example.com", password: PASSWORD } })).cookies, "__Host-better-auth.session_token");
    const umaCrm = await openApp("crm.example.com", umaSession);
    const ask = (cookie: string, text: string, origin?: string) => through("crm.example.com", "POST", "/.aidenhq/request", { cookie, body: { text }, origin });
    expect((await ask(umaCrm, "make me admin", "https://wiki.example.com")).status).toBe(403);
    const mine = await ask(umaCrm, "Please make me an admin");
    expect(mine.status).toBe(200);
    const memberRequest = JSON.parse(mine.body).id as string;
    await expect(accounts.apps.agentAssign("app-maintainer", "crm", memberRequest, "uma@example.com", "admin")).rejects.toThrow(/not an admin/);

    // Ava, an admin of the crm, asks for Bob to be a member: the agent does it, logged with who asked.
    await accounts.apps.assign("owner@example.com", "crm", "ava@example.com", "admin");
    const avaSession = cookieOf((await through(MY, "POST", "/.auth/api/sign-in/email", { body: { email: "ava@example.com", password: PASSWORD } })).cookies, "__Host-better-auth.session_token");
    const avaCrm = await openApp("crm.example.com", avaSession);
    const adminRequest = JSON.parse((await ask(avaCrm, "Add bob@example.com as a member")).body).id as string;
    expect(accounts.apps.open("crm").map((r) => r.id)).toEqual([memberRequest, adminRequest]);
    await expect(accounts.apps.agentAssign("app-maintainer", "wiki", adminRequest, "bob@example.com", "member")).rejects.toThrow(/not a request on wiki/);
    expect(await accounts.apps.agentAssign("app-maintainer", "crm", adminRequest, "bob@example.com", "member")).toMatchObject({ ok: true, after: "member" });
    expect(accounts.apps.view("crm").log[0]).toMatchObject({ subject: "bob@example.com", after: "member", by: "agent:app-maintainer", asked_by: "ava@example.com", request_id: adminRequest });
    // Once answered, the request is spent: it can't authorise another change.
    accounts.apps.reply("crm", adminRequest, "done", "Bob is a member now.");
    await expect(accounts.apps.agentAssign("app-maintainer", "crm", adminRequest, "eve@example.com", "admin")).rejects.toThrow(/already done/);
    expect(seen.some((h) => String(h["x-forwarded-host"] ?? "").includes("crm") && JSON.stringify(h).includes("make me"))).toBe(false);

    // The agent answers Uma's request; she sees it on her requests page.
    accounts.apps.reply("crm", memberRequest, "declined", "Only an admin can ask for that: <ask Ava>");
    const list = await through("crm.example.com", "GET", "/.aidenhq/requests", { cookie: umaCrm });
    expect(list.status).toBe(200);
    expect(list.body).toContain("Please make me an admin");
    expect(list.body).toContain("Only an admin can ask for that: &#60;ask Ava&#62;");
    expect(list.body).not.toContain("Add bob@example.com");
  });

  it("an app that goes away takes its rows with it", async () => {
    const wiki = apps.wiki;
    delete (apps as Partial<typeof apps>).wiki;
    await accounts.syncGate();
    expect(exported().apps.wiki).toBeUndefined();
    (apps as typeof apps).wiki = wiki;
    expect(accounts.apps.view("wiki").assignments).toEqual([]);
  });

  it("access mode: an Access-verified email with no account gets the app's default role", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const issuer = "https://team.cloudflareaccess.com";
    const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = (email: string, aud: string) => {
      const body = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ iss: issuer, aud: [aud], exp: Math.floor(Date.now() / 1000) + 600, email })}`;
      return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
    };
    password = false;
    await accounts.syncGate();
    const hosts = Object.fromEntries(Object.entries(hostsConfig()).map(([h, c]) => [h, { ...c, aud: `aud-${c.app}` }]));
    const g = await startGate({ port: 0, login: "access", issuer, certs_url: "http://jwks.invalid/certs", auth_url: `http://127.0.0.1:${authPort}`, auth_secret_file: join(dir, "board-secret"), accounts_file: accountsFile, identity_key_file: join(dir, "identity", "gate.pem"), owner_email: "owner@example.com", my_apps: { host: MY, aud: "aud-my" }, hosts }, ((url: string | URL, init?: RequestInit) => (String(url).startsWith("http://jwks.invalid/") ? Promise.resolve(new Response(JSON.stringify(jwks))) : fetch(url, init))) as typeof fetch);
    const port = (g.address() as AddressInfo).port;
    try {
      const as = (host: string, aud: string, path = "/") => through(host, "GET", path, { port, headers: { "cf-access-jwt-assertion": token("zed@example.com", aud) } });
      expect((await as("crm.example.com", "aud-crm")).status).toBe(200); // crm's default is member
      expect(who(seen.at(-1)!)).toMatchObject({ email: "zed@example.com", role: "member", name: "", idp: "access" });
      expect((await as("wiki.example.com", "aud-wiki")).status).toBe(403); // wiki's is blocked
      const home = (await as(MY, "aud-my")).body;
      expect(home).toContain("crm.example.com");
      expect(home).not.toContain("wiki.example.com");
      // An in-app request from a visitor without an account works the same way.
      const r = await through("crm.example.com", "POST", "/.aidenhq/request", { port, body: { text: "hello" }, headers: { "cf-access-jwt-assertion": token("zed@example.com", "aud-crm") } });
      expect(r.status).toBe(200);
      expect(accounts.apps.open("crm").at(-1)).toMatchObject({ email: "zed@example.com", role: "member", text: "hello" });
    } finally {
      password = true;
      g.close();
    }
  });

  it("counts failed sign-ins against the visitor's Cloudflare address, not the gate's", async () => {
    const signIn = (pw: string, ip: string) => through(MY, "POST", "/.auth/api/sign-in/email", { body: { email: "uma@example.com", password: pw }, ip });
    for (let i = 0; i < 5; i++) expect((await signIn("wrong password!!", "198.51.100.9")).status).toBe(401);
    expect((await signIn(PASSWORD, "198.51.100.9")).status).toBe(403);
    expect((await signIn(PASSWORD, "198.51.100.10")).status).toBe(200);
  });
});

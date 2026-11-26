// `ui-review login`: the login ladder's rungs that sign a run in, and the session check a capture runs after each page.
//   supplied --app <app> --out state.json   the owner's stored login for the app's own pass (the design module's job tool
//                                                      `login`, kernel route POST /v1/jobtools/module/design/login),
//                                                      released by the module only to the app's own pass
//   form --url <login url> --user <u> --password-file <f> [--totp-file <f>] --out state.json   a user the agent found or made
//   signup --url <signup url> --out state.json         signs up as ui-review+<run>@example.test, the mail through Mailpit
//   aidenhq --app <app> --out state.json                an AidenHQ app's read-only test-user session (the design module's job
//                                                      tool `app-session`, which asks the kernel), redeemed at the gate's test
//                                                      listener: the app is then reviewed at http://<app>.canary.localhost:<port>
// Each writes Playwright storage state (state.json, mode 0600) and state.meta.json (SessionMeta: no secret) beside it, and prints
// only `signed in (<rung>) at <login path>`. Login material (passwords, TOTP seeds and codes, cookies, mail links) is read
// only by this process: it is never printed, logged or written anywhere but the state and its password file, and a failed
// login says a fixed reason, never a browser error (whose call log may quote what was typed).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Page as PwPage } from "playwright-core";
import { launch, ready, routeOf, TEST_LISTENER } from "./browser.ts";
import type { Mode, StorageState } from "./guard.ts";
import { totp } from "./totp.ts";

export type Rung = "supplied" | "form" | "signup" | "aidenhq" | "patch";
/** What a session is and how to sign in again (no secret: file paths and names only). */
export type SessionMeta = {
  rung: Rung; loginPath: string; loginTitle: string; origin: string;
  again?: { rung: "supplied" | "aidenhq"; app: string } | { rung: "form"; url: string; user: string; passwordFile: string; totpFile?: string };
};

export const MAILPIT = { smtp: "127.0.0.1:1025", api: "http://127.0.0.1:8025" };

class LoginError extends Error {}
const fail = (why: string): never => { throw new LoginError(why); };
const metaFile = (state: string) => state.replace(/\.json$/, "") + ".meta.json";

export function readSession(file: string): { state: StorageState; meta: SessionMeta } {
  try { return { state: JSON.parse(readFileSync(file, "utf8")) as StorageState, meta: JSON.parse(readFileSync(metaFile(file), "utf8")) as SessionMeta }; }
  catch { return fail(`no session at ${file} (run ui-review login first)`); }
}

/** The page is the sign-in page again: a sign-in field on the login page's path, or a password field under its title. */
export async function signedOut(page: PwPage, meta: SessionMeta): Promise<boolean> {
  // The test listener answers a dead test-user session with its plain 401 page, never a sign-in form.
  if (meta.rung === "aidenhq") return new URL(page.url()).origin === meta.origin && (await page.locator("body").innerText().catch(() => "")).trim() === LISTENER_SIGNED_OUT;
  const shows = async (sel: string) => (await page.locator(sel).filter({ visible: true }).count().catch(() => 0)) > 0;
  const u = new URL(page.url()), password = await shows("input[type=password]");
  // On the login page's path with a sign-in field (a username-first page shows no password yet); a SPA that signs in
  // without leaving that path shows neither.
  if (u.origin === meta.origin && pathOf(u) === meta.loginPath) return password || (await shows(USER));
  return password && (await page.title().catch(() => "")) === meta.loginTitle;
}
const pathOf = (u: URL) => routeOf(new URL(u.origin + u.pathname + u.hash)).replace(/\?.*$/, "");
/** A URL's place as SessionMeta.loginPath records it (path and hash route, no query). */
export const pathOfUrl = (url: string) => pathOf(new URL(url));

const USER = "input[autocomplete=username], input[autocomplete=email], input[type=email], input[name*=user i], input[name*=email i], input[name*=login i], input[id*=user i], input[id*=email i]";
const CODE = "input[autocomplete=one-time-code], input[name*=otp i], input[name*=totp i], input[name*=code i], input[id*=code i], input[inputmode=numeric]";
const visible = async (page: PwPage, sel: string) => { const l = page.locator(sel).filter({ visible: true }); return (await l.count()) ? l.first() : null; };

/** Fills a sign-in form (one page, or user first then password) and a TOTP step when one follows. */
async function signIn(page: PwPage, url: string, user: string, password: string, code: (() => string) | undefined) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await ready(page);
  const login = { loginPath: pathOf(new URL(page.url())), loginTitle: await page.title(), origin: new URL(page.url()).origin };
  const u = (await visible(page, USER)) ?? (await visible(page, "input[type=text]")) ?? fail("no user field on the sign-in page");
  await u.fill(user);
  let pw = await visible(page, "input[type=password]");
  if (!pw) { await u.press("Enter"); await ready(page); pw = (await visible(page, "input[type=password]")) ?? fail("no password field on the sign-in page"); }
  await pw.fill(password);
  await pw.press("Enter");
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await ready(page);
  const c = await visible(page, CODE);
  if (c && !(await visible(page, "input[type=password]"))) {
    if (!code) fail("the sign-in asks for a one-time code and no TOTP seed was given");
    await c.fill(code!());
    await c.press("Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await ready(page);
  }
  if (await signedOut(page, { rung: "form", ...login })) fail("the sign-in didn't go through (still on the sign-in page)");
  return login;
}

/** Runs `fn` on a fresh page of a guarded Chrome (any by default: a sign-in posts), saves the storage state and the meta. */
async function withPage(out: string, fn: (page: PwPage) => Promise<Omit<SessionMeta, "rung" | "again">>, rung: Rung, again?: SessionMeta["again"], mode: Mode = "any") {
  const b = await launch({ mode });
  try {
    const ctx = await b.browser.newContext({ viewport: { width: 1512, height: 900 } });
    const page = await ctx.newPage();
    let login: Omit<SessionMeta, "rung" | "again">;
    try { login = await fn(page); } catch (e) { throw e instanceof LoginError ? e : new LoginError(`the ${rung} sign-in failed in the browser`); }
    writeFileSync(out, JSON.stringify(await ctx.storageState()), { mode: 0o600 });
    const meta: SessionMeta = { rung, ...login, ...(again ? { again } : {}) };
    writeFileSync(metaFile(out), JSON.stringify(meta, null, 2));
    return meta;
  } finally { await b.close(); }
}

const readSecret = (f: string) => { try { return readFileSync(f, "utf8").trim(); } catch { return fail(`can't read ${f}`); } };

export async function formLogin(o: { url: string; user: string; passwordFile: string; totpFile?: string; out: string }) {
  const password = readSecret(o.passwordFile), seed = o.totpFile ? readSecret(o.totpFile) : undefined;
  const again = { rung: "form" as const, url: o.url, user: o.user, passwordFile: resolve(o.passwordFile), ...(o.totpFile ? { totpFile: resolve(o.totpFile) } : {}) };
  return withPage(o.out, (page) => signIn(page, o.url, o.user, password, seed ? () => totp(seed) : undefined), "form", again);
}

/** The job tool's answer: the login and the current TOTP code (never the seed). */
type Released = { login_url: string; username: string; password: string; totp?: string };

export async function suppliedLogin(o: { app: string; out: string }) {
  const gw = process.env.AIDENHQ_GATEWAY_URL || "http://10.231.2.1:8200";
  let r: Response;
  try {
    r = await fetch(`${gw}/v1/jobtools/module/design/login`, {
      method: "POST", headers: { authorization: `Bearer ${process.env.AIDENHQ_RUN_TOKEN ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({ app: o.app }), signal: AbortSignal.timeout(30_000),
    });
  } catch { return fail("the login tool didn't answer"); }
  if (!r.ok) {
    const why = await r.json().then((j: { error?: unknown }) => String(j.error ?? ""), () => "");
    return fail(`the login tool refused (${r.status})${why ? `: ${why.replace(/[^\x20-\x7e]/g, "").slice(0, 160)}` : ""}`);
  }
  const got = (await r.json().catch(() => ({}))) as Partial<Released>;
  if (!got.login_url || !got.username || !got.password) return fail("the login tool's answer has no login");
  const code = got.totp;
  return withPage(o.out, (page) => signIn(page, got.login_url!, got.username!, got.password!, code ? () => code : undefined), "supplied", { rung: "supplied", app: o.app });
}

/** The test listener's answer to a request without a live session (modules/apps-platform/gate/test-listener.ts). */
const LISTENER_SIGNED_OUT = "sign in first";
const APP = /^[a-z][a-z0-9-]{1,30}$/;
/** Where an AidenHQ app's test-user session is served: the gate's test listener, under the app's own name. */
export const listenerOrigin = (app: string) => `http://${app}.canary.localhost:${TEST_LISTENER.split(":").pop()}`;

/** The job tool's answer: a one-time handoff code and its state (single use, 60 s), the session's mode and expiry. */
type AppSession = { code: string; state: string; mode: string; expires: string };

export async function aidenhqLogin(o: { app: string; out: string }) {
  if (!APP.test(o.app)) fail("--app is an app name (lowercase letters, digits and -)");
  const gw = process.env.AIDENHQ_GATEWAY_URL || "http://10.231.2.1:8200";
  let r: Response;
  try {
    r = await fetch(`${gw}/v1/jobtools/module/design/app-session`, {
      method: "POST", headers: { authorization: `Bearer ${process.env.AIDENHQ_RUN_TOKEN ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({ app: o.app }), signal: AbortSignal.timeout(30_000),
    });
  } catch { return fail("the app-session tool didn't answer"); }
  if (!r.ok) {
    const why = await r.json().then((j: { error?: unknown }) => String(typeof j.error === "object" ? (j.error as { message?: unknown })?.message ?? "" : j.error ?? ""), () => "");
    return fail(`the app-session tool refused (${r.status})${why ? `: ${why.replace(/[^\x20-\x7e]/g, "").slice(0, 160)}` : ""}`);
  }
  const got = (await r.json().catch(() => ({}))) as Partial<AppSession>;
  if (typeof got.code !== "string" || typeof got.state !== "string" || got.mode !== "read") return fail("the app-session tool's answer has no read-only session");
  const origin = listenerOrigin(o.app);
  // A read-only Chrome: the handoff is a GET, and nothing this rung does writes.
  return withPage(o.out, async (page) => {
    await page.goto(`${origin}/.auth/handoff?${new URLSearchParams({ code: got.code!, state: got.state!, next: "/" })}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await ready(page);
    const text = (await page.locator("body").innerText().catch(() => "")).trim();
    if (new URL(page.url()).origin !== origin || page.url().includes("/.auth/handoff") || text === LISTENER_SIGNED_OUT) fail("the test listener refused the handoff");
    return { loginPath: "/.auth/handoff", loginTitle: "", origin };
  }, "aidenhq", { rung: "aidenhq", app: o.app }, "read");
}

/** Mailpit on 127.0.0.1 (SMTP 1025, API 8025), started unless it already answers. */
async function mailpit(): Promise<void> {
  const up = () => fetch(`${MAILPIT.api}/api/v1/info`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
  if (await up()) return;
  spawn("mailpit", ["--smtp", MAILPIT.smtp, "--listen", MAILPIT.api.replace("http://", "")], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  for (let i = 0; i < 50; i++) { if (await up()) return; await new Promise((ok) => setTimeout(ok, 200)); }
  fail("Mailpit didn't start");
}

/** The newest mail to `to` within `ms`: its text and HTML. */
async function mailTo(to: string, ms = 30_000): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const list = (await fetch(`${MAILPIT.api}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((r) => r.json(), () => ({}))) as { messages?: { ID: string }[] };
    const id = list.messages?.[0]?.ID;
    if (id) { const m = (await (await fetch(`${MAILPIT.api}/api/v1/message/${id}`)).json()) as { Text?: string; HTML?: string }; return `${m.Text ?? ""}\n${m.HTML ?? ""}`; }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return fail("no sign-up mail arrived");
}

const CAPTCHA = "iframe[src*=captcha], [class*=captcha], [id*=captcha], .g-recaptcha, .h-captcha";
const PHONE = "input[type=tel], input[name*=phone i], input[autocomplete=tel]";

export async function signupLogin(o: { url: string; out: string }) {
  const run = randomBytes(4).toString("hex"), email = `ui-review+${run}@example.test`, password = `Ui-${randomBytes(12).toString("base64url")}9!`;
  const passwordFile = `${o.out.replace(/\.json$/, "")}.password`;
  await mailpit();
  let signIn2: { loginPath: string; loginTitle: string; origin: string } | undefined;
  const meta = await withPage(o.out, async (page) => {
    await page.goto(o.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await ready(page);
    if ((await page.locator(CAPTCHA).count()) || (await page.locator(PHONE).count())) fail("sign-up needs a CAPTCHA/SMS");
    const e = (await visible(page, "input[type=email]")) ?? (await visible(page, USER)) ?? fail("no email field on the sign-up page");
    await e.fill(email);
    for (const p of await page.locator("input[type=password]").filter({ visible: true }).all()) await p.fill(password);
    for (const n of await page.locator("input[name*=name i]:not([type=email]), input[id*=name i]:not([type=email])").filter({ visible: true }).all()) if (!(await n.inputValue())) await n.fill("UI Review");
    for (const c of await page.locator("input[type=checkbox][required]").filter({ visible: true }).all()) await c.check();
    const signupAt = { path: pathOf(new URL(page.url())), title: await page.title() };
    const submit = await visible(page, "button[type=submit], input[type=submit]");
    if (submit) await submit.click(); else await e.press("Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await ready(page);
    const mail = await mailTo(email), origin = new URL(o.url).origin;
    const stillThere = async () => pathOf(new URL(page.url())) === signupAt.path && (await page.title()) === signupAt.title;
    const links = [...mail.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/&amp;/g, "&"));
    const link = links.find((l) => new URL(l).origin === origin) ?? links[0];
    const code = /\b(\d{6})\b/.exec(mail)?.[1];
    if (link) { await page.goto(link, { waitUntil: "domcontentloaded", timeout: 20_000 }); await ready(page); }
    else if (code) { const c = (await visible(page, CODE)) ?? fail("the mail has a code but the page has no code field"); await c.fill(code); await c.press("Enter"); await ready(page); }
    else fail("the sign-up mail has no link or code");
    // An app that verifies, then asks to sign in: the new account signs in like any form login.
    if (await visible(page, "input[type=password]")) signIn2 = await signIn(page, page.url(), email, password, undefined);
    if (await stillThere()) fail("the sign-up didn't go through (still on the sign-up page)");
    return signIn2 ?? { loginPath: signupAt.path, loginTitle: signupAt.title, origin };
  }, "signup");
  // The new account's password, for a re-login through the form rung when the app has a sign-in page.
  writeFileSync(passwordFile, password, { mode: 0o600 });
  if (signIn2) {
    meta.again = { rung: "form", url: `${signIn2.origin}${signIn2.loginPath}`, user: email, passwordFile: resolve(passwordFile) };
    writeFileSync(metaFile(o.out), JSON.stringify(meta, null, 2));
  }
  return meta;
}

/** Signs in again the way the session was made (supplied, form, aidenhq), rewriting `file`; a rung that can't (sign-up, patch) fails. */
export async function relogin(file: string): Promise<StorageState> {
  const { meta } = readSession(file), a = meta.again;
  if (!a) return fail(`a ${meta.rung} session can't sign in again`);
  if (a.rung === "form") await formLogin({ url: a.url, user: a.user, passwordFile: a.passwordFile, totpFile: a.totpFile, out: file });
  else if (a.rung === "supplied") await suppliedLogin({ app: a.app, out: file });
  else await aidenhqLogin({ app: a.app, out: file });
  const fresh = readSession(file);
  // A re-login keeps the session's own rung (a sign-up's re-login goes through its form).
  writeFileSync(metaFile(file), JSON.stringify({ ...fresh.meta, rung: meta.rung }, null, 2));
  return fresh.state;
}

const USAGE = "usage: ui-review login supplied --app <app> --out state.json | form --url <u> --user <u> --password-file <f> [--totp-file <f>] --out state.json | signup --url <u> --out state.json | aidenhq --app <app> --out state.json";

export async function loginCommand(argv: string[]): Promise<number> {
  const [rung, ...rest] = argv;
  const { values: v } = parseArgs({ args: rest, options: { app: { type: "string" }, out: { type: "string" }, url: { type: "string" }, user: { type: "string" }, "password-file": { type: "string" }, "totp-file": { type: "string" } } });
  const out = v.out ? resolve(v.out) : "";
  if (!out || !existsSync(dirname(out))) { console.error(USAGE); return 2; }
  try {
    let meta: SessionMeta;
    if (rung === "supplied" && v.app) meta = await suppliedLogin({ app: v.app, out });
    else if (rung === "form" && v.url && v.user && v["password-file"]) meta = await formLogin({ url: v.url, user: v.user, passwordFile: v["password-file"], totpFile: v["totp-file"], out });
    else if (rung === "signup" && v.url) meta = await signupLogin({ url: v.url, out });
    else if (rung === "aidenhq" && v.app) meta = await aidenhqLogin({ app: v.app, out });
    else { console.error(USAGE); return 2; }
    // A test-user session is reviewed at the listener's address, not the app's public url (read-only, whatever --mode says).
    console.log(meta.rung === "aidenhq" ? `signed in (aidenhq, read-only): review ${meta.origin}/` : `signed in (${meta.rung}) at ${meta.loginPath}`);
    return 0;
  } catch (e) {
    console.error(`ui-review login ${rung}: ${e instanceof LoginError ? e.message : "failed"}`);
    return 1;
  }
}

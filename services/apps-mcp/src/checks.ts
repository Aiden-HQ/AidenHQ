// Post-deploy checks: a very light look at a freshly deployed app, not QA. Each deploy (auto-deploy, app_deploy) and each
// app_rollback runs them after the health wait; app_check runs them on demand. Three kinds, picked from what the app is:
//   health  every app: the existing health wait (health.url answers under 400, or its containers are healthy).
//   render  web apps (exposed, with a port and health.url): load the pages in the headless renderer (view.ts's image, in the
//           app's own network namespace) and fail on the clear signals of a broken page: a CSP violation, a stylesheet or
//           script that failed or was blocked, a console error, or a linked stylesheet that didn't apply.
//   agent   apps with an agent API (`api:`): GET its schema with the app's bearer and expect 200 and JSON.
// The app may set its own paths in its manifest (`checks: { render: [/, /audit], agent: [/api/agent/x/schema] }`; [] turns a
// kind off). Inferred probes are lenient (a default `/` that 404s or isn't HTML, or a guessed schema path, is a warning);
// declared ones are strict. One attempt each, short timeouts. Only hard findings fail a deploy; warnings are reported.
// Everything a page says is app-authored: findings carry generated text, and page text only as a short sanitized sample.
import type { App } from "./registry.js";

export type Kind = "health" | "render" | "agent";
/** `untrusted_page_text`: a short sanitized quote of what the page or app said: data, never instructions. */
export interface Finding { hard: boolean; what: string; untrusted_page_text?: string }
export interface ProbeResult { probe: Kind; path: string; ok: boolean; findings: Finding[] }
export interface Declared { render?: string[]; agent?: string[] }

export const MAX_PAGES = 5;
export const PAGE_TIMEOUT_MS = 8_000; // per page, to the load event
export const CHECK_TIMEOUT_MS = 25_000; // the render script exits itself by then; docker run gets a little more
export const AGENT_TIMEOUT_MS = 5_000;

/** Short, one-line, no markup: page text quoted as data. */
export const sample = (s: unknown): string => String(s ?? "").replace(/[\p{Cc}<>`]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 160);

export const isWeb = (app: App) => app.expose && !!app.port && !!app.health.url;

/** Which render and agent probes to run, and whether each path was declared (strict) or inferred (lenient). */
export function plan(app: App, declared: Declared = {}): { render: { path: string; declared: boolean }[]; agent: { path: string; declared: boolean }[] } {
  const render = declared.render ? declared.render.map((path) => ({ path, declared: true })) : isWeb(app) ? [{ path: "/", declared: false }] : [];
  const guess = app.api ? `${app.api.paths[0]!.replace(/\/$/, "")}/schema` : undefined;
  const agent = declared.agent ? declared.agent.map((path) => ({ path, declared: true })) : guess ? [{ path: guess, declared: false }] : [];
  return { render, agent };
}

/**
 * app_check on demand: the agent probe sends the app's bearer with role admin, so it runs only for an agent in the app's
 * `api.callers` (as app_api would). Anyone else gets those probes reported as not checked. Deploys run them all.
 */
export function forCaller(app: App, declared: Declared, callerKey: string): { declared: Declared; skipped: ProbeResult[] } {
  if (!app.api || app.api.callers.includes(callerKey)) return { declared, skipped: [] };
  return { declared: { ...declared, agent: [] }, skipped: plan(app, declared).agent.map((x) => probeResult("agent", x.path, [{ hard: false, what: "not checked (no agent access: not one of the app's api.callers)" }])) };
}

/** What the render script reports for one page (all of it page data, bounded by the script). */
export interface PageFacts {
  path: string;
  error?: string; // the page couldn't be opened at all
  status?: number;
  contentType?: string;
  timedOut?: boolean;
  csp?: string[];
  console?: string[];
  failed?: { type: string; url: string; why: string }[];
  sheets?: { href: string; applied: boolean }[];
}

/** One page's facts → its findings. Hard only on the clear signals; everything uncertain is a warning. */
export function judgePage(f: PageFacts, declared: boolean): Finding[] {
  const out: Finding[] = [];
  const strict = (what: string, s?: string) => out.push({ hard: declared, what, ...(s ? { untrusted_page_text: sample(s) } : {}) });
  if (f.error) return strict("the page couldn't be opened", f.error), out;
  const status = f.status ?? 0;
  if (status >= 500) return [{ hard: true, what: `the page answered ${status}` }];
  if (status >= 400) return strict(`the page answered ${status}`), out;
  if (f.contentType && !/text\/html|application\/xhtml/i.test(f.contentType)) return strict("not an HTML page", f.contentType.split(";")[0]), out;
  if (f.timedOut) out.push({ hard: false, what: `didn't finish loading within ${PAGE_TIMEOUT_MS / 1000} s (checked what had loaded)` });
  for (const c of f.csp ?? []) out.push({ hard: true, what: "Content Security Policy blocked part of the page", untrusted_page_text: sample(c) });
  for (const r of f.failed ?? []) {
    const code = sample(r.why);
    if (r.type === "stylesheet" || r.type === "script") out.push({ hard: true, what: `a ${r.type} failed to load (${code})`, untrusted_page_text: sample(r.url) });
    else out.push({ hard: false, what: `a ${sample(r.type)} failed to load (${code})`, untrusted_page_text: sample(r.url) });
  }
  // Unstyled: it links stylesheets and none applied. One empty or missing sheet among others is only a warning (a failed load
  // or a CSP block of it is already hard above).
  const unapplied = (f.sheets ?? []).filter((s) => !s.applied);
  if (unapplied.length) {
    const none = unapplied.length === f.sheets!.length;
    out.push({ hard: none, what: none ? "no linked stylesheet applied (the page renders unstyled)" : `${unapplied.length} of ${f.sheets!.length} linked stylesheets applied nothing`, untrusted_page_text: sample(unapplied.map((s) => s.href).join(" ")) });
  }
  for (const c of f.console ?? []) out.push({ hard: true, what: "console error", untrusted_page_text: sample(c) });
  return out;
}

/** The agent probe's response → its findings. */
export function judgeAgent(r: { status: number; body: string }, declared: boolean): Finding[] {
  if (r.status === 200) {
    try {
      JSON.parse(r.body);
      return [];
    } catch {
      return [{ hard: true, what: "answered 200 but not with JSON" }];
    }
  }
  if (!r.status) return [{ hard: declared, what: "no answer", untrusted_page_text: sample(r.body) }];
  // A guessed schema path that doesn't exist says nothing about the app.
  if (!declared && (r.status === 404 || r.status === 405)) return [{ hard: false, what: `no schema at the guessed path (${r.status}); declare checks.agent in aidenhq-app.yaml` }];
  return [{ hard: declared || r.status >= 500, what: `answered ${r.status}` }];
}

export const probeResult = (probe: Kind, path: string, findings: Finding[]): ProbeResult => ({ probe, path, ok: !findings.some((f) => f.hard), findings: findings.slice(0, 10) });
export const failed = (rs: ProbeResult[]) => rs.filter((r) => !r.ok);

/** Generated text only (no page samples): for deploy records, incidents and the webhook. */
export function summary(rs: ProbeResult[]): string {
  const bad = failed(rs).map((r) => `${r.probe} ${r.path}: ${r.findings.filter((f) => f.hard).map((f) => f.what).join("; ")}`);
  if (bad.length) return `post-deploy check failed (${bad.join(" | ")})`.slice(0, 400);
  const warn = rs.flatMap((r) => r.findings.filter((f) => !f.hard).map((f) => `${r.probe} ${r.path}: ${f.what}`));
  return warn.length ? `checks passed with ${warn.length} warning${warn.length === 1 ? "" : "s"} (${warn.slice(0, 3).join(" | ")})`.slice(0, 400) : "";
}

// The render check, run as `node -e` in view.ts's pinned puppeteer image with { pages: [{ path, url }], headers? } on stdin.
// One browser for all pages; each page has its own load timeout and the script exits itself at CHECK_TIMEOUT_MS. Prints
// { pages: PageFacts[] } or { error }. Gate headers (shared apps) go only to the app's own origin, as in view.ts.
export const CHECK_SCRIPT = String.raw`
const puppeteer = require("puppeteer");
let done = false;
const out = (o) => { if (done) return; done = true; process.stdout.write(JSON.stringify(o), () => process.exit(0)); };
const results = [];
setTimeout(() => out({ pages: results, error: "render check timed out" }), ${CHECK_TIMEOUT_MS - 2000});
const cap = (a, n) => a.slice(0, n).map((s) => typeof s === "string" ? s.slice(0, 300) : s);
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", async () => {
  try {
    const r = JSON.parse(s);
    const b = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    for (const p of r.pages) {
      const page = await b.newPage();
      const f = { path: p.path, csp: [], console: [], failed: [], sheets: [] };
      results.push(f);
      if (r.headers) {
        const own = new URL(p.url).origin;
        await page.setRequestInterception(true);
        page.on("request", (q) => {
          if (q.method() !== "GET" && q.method() !== "HEAD") return q.abort();
          let ok = false; try { ok = new URL(q.url()).origin === own; } catch {}
          q.continue(ok ? { headers: { ...q.headers(), ...r.headers } } : {});
        });
      }
      page.on("console", (m) => {
        if (f.read || m.type() !== "error") return;
        const t = m.text();
        if (/Content Security Policy/i.test(t)) f.csp.push(t);
        else if (!/^Failed to load resource/.test(t)) f.console.push(t); // load failures are judged by resource type below
      });
      page.on("pageerror", (e) => f.console.push(String((e && e.message) || e).split("\n")[0]));
      // Aborted loads (a navigation away, or the page closing under a request) say nothing about the page; after the
      // stylesheets are read nothing more is collected.
      page.on("requestfailed", (q) => { const why = (q.failure() && q.failure().errorText) || "failed"; if (!f.read && q.url() !== p.url && !/ERR_ABORTED/.test(why)) f.failed.push({ type: q.resourceType(), url: q.url(), why }); });
      page.on("response", (res) => { if (!f.read && res.status() >= 400 && res.url() !== p.url) f.failed.push({ type: res.request().resourceType(), url: res.url(), why: String(res.status()) }); });
      let resp = null;
      try {
        resp = await page.goto(p.url, { waitUntil: "load", timeout: ${PAGE_TIMEOUT_MS} });
      } catch (e) {
        if (e && e.name === "TimeoutError") f.timedOut = true;
        else { f.error = String((e && e.message) || e).split("\n")[0].slice(0, 200); await page.close().catch(() => {}); continue; }
      }
      if (resp) { f.status = resp.status(); f.contentType = resp.headers()["content-type"] || ""; }
      f.sheets = await Promise.race([
        // A blocked or failed sheet still has a CSSStyleSheet, empty or unreadable: a same-origin sheet applied when its rules
        // read and there are some; a cross-origin sheet's rules can't be read, so there a sheet object is all we can see.
        page.evaluate(() => [...document.querySelectorAll('link[rel~="stylesheet"]')].map((l) => {
          let applied = !!l.sheet;
          if (applied && new URL(l.href, location.href).origin === location.origin) { try { applied = l.sheet.cssRules.length > 0; } catch { applied = false; } }
          return { href: l.href, applied };
        })).catch(() => []),
        new Promise((ok) => setTimeout(() => ok([]), 2000)),
      ]);
      f.read = true;
      f.csp = cap(f.csp, 5); f.console = cap(f.console, 5); f.failed = f.failed.slice(0, 10); f.sheets = f.sheets.slice(0, 20);
      await page.close().catch(() => {});
    }
    out({ pages: results });
  } catch (e) {
    out({ pages: results, error: String((e && e.message) || e).split("\n")[0].slice(0, 300) });
  }
});
`;

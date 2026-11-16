// Post-deploy checks: a very light look at a freshly deployed app, not QA. Each deploy (auto-deploy, app_deploy) and each
// app_rollback runs them after the health wait; app_check runs them on demand. Three kinds, picked from what the app is:
//   health  every app: the existing health wait (health.url answers under 400, or its containers are healthy).
//   render  web apps (exposed, with a port and health.url): load the pages in the headless renderer (view.ts's browser image, in the
//           app's own network namespace) and fail on the clear signals of a broken page: a CSP violation, a stylesheet or
//           script that failed or was blocked, a console error, or a linked stylesheet that didn't apply.
//   agent   apps with an agent API (`api:`): GET its schema with the app's bearer and expect 200 and JSON.
// The app may set its own paths in its manifest (`checks: { render: [/, /audit], agent: [/api/agent/x/schema] }`; [] turns a
// kind off). Inferred probes are lenient (a default `/` that 404s or isn't HTML, or a guessed schema path, is a warning);
// declared ones are strict. One attempt each, short timeouts. Only hard findings fail a deploy; warnings are reported.
// Everything a page says is app-authored: findings carry generated text, and page text only as a short sanitized sample.
import { checkPath, plainPath } from "./api.js";
import type { Scope } from "./identity.js";
import type { App } from "./registry.js";
import { browserKit } from "./view.js";

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
 * The agent probe's identity, the same on every deploy and every app_check whoever asks: the platform's own `deploy-check`,
 * never the caller's, so any agent granted app_check gets a real signed answer without being one of the app's api.callers.
 * It can only read: GET alone, bound to the one probe path (the running commit's manifest `checks.agent`, or the guessed
 * schema path; never the caller's), which must sit under the app's agent API paths. Only the status and whether it was JSON
 * come back (judgeAgent), never the body.
 */
export function agentProbeScope(app: App, path: string): Scope {
  checkPath(app, path, app.api!.paths, "GET"); // the bearer goes only under the app's own agent API paths, and only reads
  return { role: "admin", methods: ["GET"], path: plainPath(path) };
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

// The render check, run as `node -e` in view.ts's browser image with { pages: [{ path, url }], headers? } on stdin. One browser
// and tab for all pages; each page has its own load timeout and the script exits itself at CHECK_TIMEOUT_MS. Prints
// { pages: PageFacts[] } or { error }. The facts come from the tab's own DevTools events (console, log, exceptions, network),
// as a person's DevTools would show them. Gate headers (shared apps) go only to the app's own origin, as in view.ts.
export const CHECK_SCRIPT = browserKit(PAGE_TIMEOUT_MS) + String.raw`
const results = [];
setTimeout(() => out({ pages: results, error: "render check timed out" }), ${CHECK_TIMEOUT_MS - 2000});
const cap = (a, n) => a.slice(0, n).map((s) => typeof s === "string" ? s.slice(0, 300) : s);
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", async () => {
  try {
    const r = JSON.parse(s);
    await ab("open"); // the launch, on about:blank
    const dt = await devtools();
    if (r.headers) await guard(dt, r.headers, new URL(r.pages[0].url).origin);
    let f = null; // the page being read; after its stylesheets are read nothing more is collected
    const live = () => f && !f.read;
    const urls = new Map();
    const log = (t) => {
      if (!live()) return;
      if (/Content Security Policy/i.test(t)) f.csp.push(t);
      else if (!/^Failed to load resource/.test(t)) f.console.push(t); // load failures are judged by resource type below
    };
    dt.on["Runtime.consoleAPICalled"] = (p) => { if (p.type === "error") log(p.args.map((a) => a.value !== undefined ? String(a.value) : a.description || "").join(" ")); };
    dt.on["Log.entryAdded"] = ({ entry }) => { if (entry.level === "error") log(entry.text); };
    dt.on["Runtime.exceptionThrown"] = ({ exceptionDetails: d }) => { if (live()) f.console.push(String((d.exception && d.exception.description) || d.text).split("\n")[0]); };
    dt.on["Network.requestWillBeSent"] = (p) => urls.set(p.requestId, p.request.url);
    const main = await tab(dt, ["Network", "Log", "Runtime"]);
    const isPage = (p) => p.type === "Document" && p.frameId === main;
    dt.on["Network.responseReceived"] = (p) => {
      if (!live()) return;
      const res = p.response;
      if (isPage(p)) { f.status = res.status; f.contentType = Object.entries(res.headers || {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] || ""; }
      else if (res.status >= 400) f.failed.push({ type: String(p.type || "other").toLowerCase(), url: res.url, why: String(res.status) });
    };
    // Aborted loads (a navigation away under a request) say nothing about the page.
    dt.on["Network.loadingFailed"] = (p) => { if (live() && !isPage(p) && !/ERR_ABORTED/.test(p.errorText || "")) f.failed.push({ type: String(p.type || "other").toLowerCase(), url: urls.get(p.requestId) || "", why: p.blockedReason ? "blocked:" + p.blockedReason : p.errorText || "failed" }); };
    for (const p of r.pages) {
      // The last page is left first (a blank page), so nothing it still does lands on the next one.
      if (results.length) await within(ab("open", "about:blank"), 3000, null);
      f = { path: p.path, csp: [], console: [], failed: [], sheets: [] };
      results.push(f);
      try {
        await ab("open", p.url); // to the load event, within PAGE_TIMEOUT_MS (the launch's default)
      } catch (e) {
        if (timedOut(e)) f.timedOut = true;
        else { f.error = line(e).slice(0, 200); f.read = true; continue; }
      }
      // A blocked or failed sheet still has a CSSStyleSheet, empty or unreadable: a same-origin sheet applied when its rules
      // read and there are some; a cross-origin sheet's rules can't be read, so there a sheet object is all we can see.
      const sheets = await within(ab("eval", "JSON.stringify([...document.querySelectorAll('link[rel~=\"stylesheet\"]')].map((l) => { let applied = !!l.sheet; if (applied && new URL(l.href, location.href).origin === location.origin) { try { applied = l.sheet.cssRules.length > 0; } catch { applied = false; } } return { href: l.href, applied }; }))"), 2000, {});
      try { f.sheets = JSON.parse(sheets.result || "[]"); } catch { f.sheets = []; }
      f.read = true;
      f.csp = cap(f.csp, 5); f.console = cap(f.console, 5); f.failed = f.failed.slice(0, 10); f.sheets = f.sheets.slice(0, 20);
    }
    out({ pages: results });
  } catch (e) {
    out({ pages: results, error: line(e) });
  }
});
`;

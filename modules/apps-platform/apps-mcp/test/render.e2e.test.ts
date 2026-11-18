// The real renderers (view and the post-deploy check) in the real browser image, against a fixture app in its own container,
// through renderArgs exactly as apps-mcp runs them. Needs Docker and the built browser image, so it runs only when asked:
//   AIDENHQ_BROWSER_E2E=1 [AIDENHQ_BROWSER_IMAGE=<tag>] npx vitest run test/render.e2e.test.ts
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_SCRIPT, judgePage, type PageFacts } from "../src/checks.js";
import { BROWSER_IMAGE, renderArgs, VIEW_SCRIPT, WEB_NETWORK, type ViewResult } from "../src/view.js";

const IMAGE = process.env.AIDENHQ_BROWSER_IMAGE ?? BROWSER_IMAGE;
const docker = (args: string[], input?: string) => execFileSync("docker", args, { input, encoding: "utf8", timeout: 90_000, stdio: ["pipe", "pipe", "pipe"] });

// The fixture: an app on :8080 that logs every request (method, host, path, whether the identity header came) at /__log.
const APP = String.raw`
const http = require("node:http");
const log = [];
http.createServer((req, res) => {
  if (req.url === "/__log") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(log)); }
  log.push({ method: req.method, host: req.headers.host, path: req.url, signed: !!req.headers["x-aidenhq-identity"] });
  const html = (body, h = {}) => { res.writeHead(200, { "content-type": "text/html", ...h }); res.end(body); };
  if (req.url === "/style.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end("h1{color:red}"); }
  if (req.url === "/api") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
  if (req.url === "/missing.js") { res.writeHead(404); return res.end(); }
  if (req.url === "/away") { res.writeHead(302, { location: "http://localhost:8080/landed" }); return res.end(); }
  if (req.url === "/slow") { res.writeHead(200, { "content-type": "text/html" }); return res.write("<title>Slow</title><h1>Partial</h1>"); }
  if (req.url === "/csp") return html("<title>CSP</title><h1>Strict</h1><img src=http://localhost:8080/x.png>", { "content-security-policy": "default-src 'self'" });
  html("<!doctype html><title>Fixture</title><link rel=stylesheet href=/style.css><h1>Hello</h1><button>New item</button>" +
    "<script>fetch('/api',{method:'POST'}).catch(()=>{});fetch('/api');fetch('http://localhost:8080/api',{mode:'no-cors'});console.error('boom')</script><script src=/missing.js></script>");
}).listen(8080);
`;

describe.runIf(process.env.AIDENHQ_BROWSER_E2E)("the browser image renders (end to end)", () => {
  let app = "";
  const net = () => `container:${app}`;
  const requests = () => JSON.parse(docker(["exec", app, "node", "-e", "fetch('http://127.0.0.1:8080/__log').then((r) => r.text()).then((t) => process.stdout.write(t))"])) as { method: string; host: string; path: string; signed: boolean }[];
  beforeAll(() => {
    app = docker(["run", "-d", "--rm", "--user", "65534:65534", IMAGE, "node", "-e", APP]).trim();
    execFileSync("sleep", ["2"]);
  });
  afterAll(() => {
    if (app) docker(["rm", "-f", app]);
  });

  it("app_view: the snapshot and screenshot; the identity header only on the app's own origin; no writes", () => {
    const t0 = Date.now();
    const r = JSON.parse(docker(renderArgs(net(), IMAGE, VIEW_SCRIPT), JSON.stringify({ url: "http://127.0.0.1:8080/", width: 1280, screenshot: true, web: false, headers: { "x-aidenhq-identity": "tok" } }))) as ViewResult;
    console.log(`app_view cold render: ${Date.now() - t0} ms`);
    expect(r).toMatchObject({ status: 200, url: "http://127.0.0.1:8080/", title: "Fixture", timed_out: false, truncated: false });
    expect(r.snapshot).toContain('- heading "Hello" [level=1]');
    expect(r.snapshot).toContain('- button "New item"');
    expect(r.snapshot).not.toMatch(/ref=/);
    expect(Buffer.from(r.png!, "base64").subarray(1, 4).toString()).toBe("PNG");
    const log = requests();
    expect(log.filter((q) => q.method === "POST")).toEqual([]); // the page's POST never left the browser
    expect(log.filter((q) => q.host === "127.0.0.1:8080").every((q) => q.signed)).toBe(true);
    expect(log.filter((q) => q.host === "localhost:8080").length).toBeGreaterThan(0);
    expect(log.filter((q) => q.host === "localhost:8080").some((q) => q.signed)).toBe(false); // another origin never gets it
  });

  it("app_view: a cross-origin redirect drops the header; a page that never settles is still read", () => {
    const away = JSON.parse(docker(renderArgs(net(), IMAGE, VIEW_SCRIPT), JSON.stringify({ url: "http://127.0.0.1:8080/away", width: 390, screenshot: false, web: false, headers: { "x-aidenhq-identity": "tok" } }))) as ViewResult;
    expect(away).toMatchObject({ status: 200, url: "http://localhost:8080/landed", timed_out: false });
    expect(requests().find((q) => q.path === "/landed")).toMatchObject({ host: "localhost:8080", signed: false });
    const t0 = Date.now();
    const r = JSON.parse(docker(renderArgs(net(), IMAGE, VIEW_SCRIPT), JSON.stringify({ url: "http://127.0.0.1:8080/slow", width: 1280, screenshot: false, web: true }))) as ViewResult;
    expect(r).toMatchObject({ timed_out: true, title: "Slow" });
    expect(r.snapshot).toContain("Partial");
    expect(Date.now() - t0).toBeLessThan(45_000);
  });

  it("the post-deploy render check reports CSP blocks, console errors and failed scripts, and reads the stylesheets", () => {
    const t0 = Date.now();
    const out = JSON.parse(docker(renderArgs(net(), IMAGE, CHECK_SCRIPT), JSON.stringify({ pages: [{ path: "/", url: "http://127.0.0.1:8080/" }, { path: "/csp", url: "http://127.0.0.1:8080/csp" }], headers: { "x-aidenhq-identity": "tok" } }))) as { pages: PageFacts[]; error?: string };
    console.log(`render check (2 pages) cold: ${Date.now() - t0} ms`);
    expect(out.error).toBeUndefined();
    const [home, csp] = out.pages;
    expect(home).toMatchObject({ path: "/", status: 200, contentType: "text/html", console: ["boom"], sheets: [{ href: "http://127.0.0.1:8080/style.css", applied: true }] });
    expect(home!.failed).toContainEqual({ type: "script", url: "http://127.0.0.1:8080/missing.js", why: "404" });
    expect(judgePage(home!, true).filter((f) => f.hard).map((f) => f.what)).toEqual(["a script failed to load (404)", "console error"]);
    expect(csp!.csp!.join(" ")).toMatch(/Content Security Policy/);
  });

  it("web_view: a public HTTPS page on the computers network (created here when this host has none)", () => {
    try { docker(["network", "inspect", WEB_NETWORK]); } catch { docker(["network", "create", WEB_NETWORK]); }
    const r = JSON.parse(docker(renderArgs(WEB_NETWORK, IMAGE, VIEW_SCRIPT), JSON.stringify({ url: "https://example.com/", width: 1280, screenshot: true, web: true }))) as ViewResult;
    expect(r).toMatchObject({ status: 200, url: "https://example.com/", title: "Example Domain", timed_out: false });
    expect(r.snapshot).toMatch(/This domain/);
    expect(r.png).toBeTruthy();
  });
});

// The real renderers (view and the post-deploy check) in the real browser image, against a fixture app in its own container,
// through renderArgs exactly as apps-mcp runs them. Needs Docker and the built browser image, so it runs only when asked:
//   AIDENHQ_BROWSER_E2E=1 [AIDENHQ_BROWSER_IMAGE=<tag>] bun test test/render.e2e.test.ts
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CHECK_SCRIPT, judgePage, type PageFacts } from "../src/checks.js";
import { BROWSER_IMAGE, CANARY_NETWORK, renderArgs, VIEW_SCRIPT, WEB_NETWORK, type ViewResult } from "../src/view.js";
import { CANARY_SCRIPT } from "../src/canary.js";

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

describe.if(!!process.env.AIDENHQ_BROWSER_E2E)("the browser image renders (end to end)", () => {
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
    expect(judgePage(home!, true).filter((f) => !f.hard).map((f) => f.what)).toEqual(["a script failed to load (404)", "console error"]);
    expect(csp!.csp!.join(" ")).toMatch(/Content Security Policy/);
  });

  it("web_view: a public HTTPS page on the computers network (created here when this host has none)", () => {
    try { docker(["network", "inspect", WEB_NETWORK]); } catch { docker(["network", "create", WEB_NETWORK]); }
    const r = JSON.parse(docker(renderArgs(WEB_NETWORK, IMAGE, VIEW_SCRIPT), JSON.stringify({ url: "https://example.com/", width: 1280, screenshot: true, web: true }))) as ViewResult;
    expect(r).toMatchObject({ status: 200, url: "https://example.com/", title: "Example Domain", timed_out: false });
    expect(r.snapshot).toMatch(/This domain/);
    expect(r.png).toBeTruthy();
  });

  // The test-user page canary, end to end: a real fixture page with a real "Send feedback" form whose own JavaScript posts
  // /api/intake (returning a reference) and then /.aidenhq/notify, a real handoff that sets the listener's host-only cookie,
  // and the real renderer on the canary network. The page's own JS is what runs; nothing calls the app on its behalf.
  it("app_page_canary: the page's own JS posts /.aidenhq/notify, and the canary reads notify: fired with the reference", () => {
    // A bridge of the test's own, never the host's aidenhq-canary: that one has inter-container traffic off, so the browser
    // could not reach the fixture at all, and creating it here (or reusing it) would leave a production-named, unguarded
    // network on a developer's host for ops/vm/canary-net.sh to trip over.
    const testNet = `aidenhq-canary-test-${process.pid}`;
    docker(["network", "create", testNet]);
    const fixture = String.raw`
const http = require("node:http");
const seen = [];
const app = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie || "" });
  if (String(req.url).split("?")[0] === "/.auth/handoff") {
    res.writeHead(302, { location: "/intake", "set-cookie": ["__Host-aidenhq-canary.session=tok.sig; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900"] });
    return res.end();
  }
  if (req.url === "/.aidenhq/notify") { res.writeHead(204); return res.end(); }
  if (req.url === "/api/intake") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ reference: "TEST-RT-2026-11-24-9" }));
  }
  if (req.url === "/__seen") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(seen)); }
  if (req.url === "/intake") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>Roadmap Keeper</title><h1>Send feedback</h1>" +
      "<form id=f><textarea name=text aria-label=\"Your feedback\"></textarea><button type=\"submit\">Send feedback</button></form><div id=out></div>" +
      "<script>document.getElementById('f').addEventListener('submit', async (e) => { e.preventDefault();" +
      "const t = document.querySelector('textarea').value;" +
      "const r = await fetch('/api/intake', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({text:t}) });" +
      "const j = await r.json(); await fetch('/.aidenhq/notify', { method: 'POST' });" +
      "document.getElementById('out').textContent = 'Thanks. Reference ' + j.reference; });</script>");
  }
  res.writeHead(404); res.end();
});
app.listen(8080, "0.0.0.0");
`;
    const page = docker(["run", "-d", "--rm", "--user", "65534:65534", IMAGE, "node", "-e", fixture]).trim();
    try {
      // The "listener" is the fixture itself, on the canary network's own bridge address: the browser reaches it at
      // <app>.canary.localhost through the resolver rule, and at nothing else.
      docker(["network", "connect", testNet, page]);
      const ip = docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${testNet}").IPAddress}}`, page]).trim();
      execFileSync("sleep", ["1"]);
      const input = { listener: "http://roadmap-keeper.canary.localhost:8080", listenerAddress: ip, code: "c".repeat(43), state: "0".repeat(32), path: "/intake", text: "TEST-RT-2026-11-24-9 canary", width: 1280 };
      const r = JSON.parse(docker(renderArgs(testNet, IMAGE, CANARY_SCRIPT), JSON.stringify(input))) as { error?: string; notify?: string; notifyStatus?: number | null; reference?: string | null; finalUrl?: string; pageTitle?: string; png?: string };
      console.log(JSON.stringify({ ...r, png: r.png ? `${r.png.length} b64 chars` : undefined }));
      expect(r.error).toBeUndefined();
      expect(r).toMatchObject({ notify: "fired", notifyStatus: 204, reference: "TEST-RT-2026-11-24-9", pageTitle: "Roadmap Keeper" });
      expect(r.finalUrl).toMatch(/roadmap-keeper\.canary\.localhost:8080\/intake/);
      expect(Buffer.from(r.png!, "base64").subarray(1, 4).toString()).toBe("PNG");
      // The page's own requests reached it, with the host-only cookie the handoff set; the canary never calls the app itself.
      const seen = JSON.parse(docker(["exec", page, "node", "-e", "fetch('http://127.0.0.1:8080/__seen').then(r=>r.text()).then(t=>process.stdout.write(t))"])) as { method: string; url: string; cookie: string }[];
      expect(seen.find((x) => x.method === "POST" && x.url === "/.aidenhq/notify")).toMatchObject({ cookie: "__Host-aidenhq-canary.session=tok.sig" });
      expect(seen.find((x) => x.method === "POST" && x.url === "/api/intake")).toBeTruthy();
    } finally {
      docker(["rm", "-f", page]);
      docker(["network", "rm", testNet]);
    }
  });
});

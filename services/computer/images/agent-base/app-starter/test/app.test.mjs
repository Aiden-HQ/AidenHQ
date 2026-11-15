// End to end: build the app, serve it, and check what a browser gets: the page with a strict CSP whose nonce matches the
// page's, the built assets from 'self', the client routes, the health check and the example API (read, write, refuse).
// (How it looks and behaves is checked in a browser with ui-review; see the README.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("built app: page, CSP, assets, routes, health and API", async () => {
  const dist = mkdtempSync(join(tmpdir(), "app-dist-"));
  execFileSync(join(root, "node_modules/.bin/vite"), ["build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: root, stdio: "inherit" });
  process.env.DIST_DIR = dist;
  const { server } = await import("../server.mjs");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/?status=late`);
    assert.equal(res.status, 200);
    const html = await res.text(), policy = res.headers.get("content-security-policy");
    assert.match(policy, /script-src 'self';/);
    const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(policy)?.[1];
    assert.ok(nonce, "style-src allows 'self' and a nonce");
    assert.doesNotMatch(policy, /unsafe-inline|https?:/);
    assert.ok(html.includes(`<meta name="csp-nonce" content="${nonce}"`), "the page carries the header's nonce");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "no inline script");
    for (const src of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      const a = await fetch(base + src[1]);
      assert.equal(a.status, 200, src[1]);
      assert.match(a.headers.get("content-type"), /javascript|css/);
      // The library is a menu: only what the app imports is built. The example page doesn't use these.
      if (src[1].endsWith(".js")) {
        const slots = new Set([...(await a.text()).matchAll(/"data-slot":[`"']([\w-]+)/g)].map((m) => m[1]));
        assert.ok(slots.has("sheet-content") && slots.has("table"), "the components the page uses are built");
        for (const unused of ["tabs-list", "card-header", "breadcrumb", "sidebar-wrapper", "dialog-content", "toggle-group", "avatar"])
          assert.ok(!slots.has(unused), `the bundle carries ${unused}, which the example page doesn't import`);
      }
    }
    assert.equal((await fetch(`${base}/theme.js`)).status, 200);
    assert.equal((await fetch(`${base}/catalog`)).status, 404, "the catalog is a dev-only preview, never an app route");
    for (const route of ["/teams"]) assert.equal((await fetch(base + route)).status, 200, `${route} is a client route, so a reload of it answers 200`);
    assert.equal((await fetch(`${base}/no-such-page`)).status, 404);

    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true, checks: [] });
    const { items } = await (await fetch(`${base}/api/items`)).json();
    assert.ok(items.length >= 10 && items.every((i) => i.source?.url), "sample projects, each with its source");
    const patch = (body, type = "application/json") => fetch(`${base}/api/items/${items[0].id}`, { method: "PATCH", headers: { "content-type": type }, body });
    const saved = await (await patch(JSON.stringify({ status: "late" }))).json();
    assert.equal(saved.status, "late");
    assert.match(saved.history[0].text, /to Late$/);
    assert.equal((await patch(JSON.stringify({ status: "bogus" }))).status, 400);
    assert.equal((await patch("status=late", "application/x-www-form-urlencoded")).status, 415);
    assert.equal((await fetch(`${base}/api/items/nope`)).status, 404);
  } finally {
    server.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

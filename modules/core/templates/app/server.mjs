// App server: serves the built React app (dist/) and its JSON API with no runtime dependencies (node:http only).
// - GET /api/health answers {ok: true, checks: []} (the apps platform's health check; add data checks to `checks`).
// - /api/items is the example API: replace ITEMS with the app's real store and keep the shapes the page reads.
// - Every page gets a strict CSP: scripts and styles from 'self' only, plus a fresh nonce for the few <style> tags Radix
//   adds at run time (src/lib/csp.ts reads it from <meta name="csp-nonce">). Never add 'unsafe-inline' or a CDN.
// - On the platform (it sets AIDENHQ_APP) every request but the health check needs a valid signed identity from the gate or
//   apps-mcp (aidenhq-identity.mjs, copied unchanged; docs/design/app-identity.md); the handler reads it as req.user.
//   Without AIDENHQ_APP (local development, tests) the app is open.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentity } from "./aidenhq-identity.mjs";

const DIST = resolve(process.env.DIST_DIR || fileURLToPath(new URL("./dist/", import.meta.url)));
const PAGES = new Set(["/", "/catalog"]); // the client's routes (src/App.tsx); anything else renders its 404 page
const TYPES = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
};

export const csp = (nonce) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self'; font-src 'self'; connect-src 'self'; ` +
  `object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
const SECURITY = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };

// Sample data so the app renders out of the box and every state can be reviewed. Dates are relative to start-up so the
// demo stays current. Each fact keeps its source.
const DAY = 86400000, now = Date.now();
const day = (d) => new Date(now + d * DAY).toISOString().slice(0, 10);
const ago = (h) => new Date(now - h * 3600000).toISOString();
const src = (id) => ({ label: id, url: `https://tracker.example.com/${id}` });
const LABELS = { "on-track": "On track", "at-risk": "At risk", late: "Late", done: "Done" };
export const STATUSES = Object.keys(LABELS);
const item = (id, name, team, owner, status, due, updatedH, next, ticket, history) => ({
  id, name, team, owner, status, due: day(due), updated: ago(updatedH), next, source: src(ticket),
  history: history.map(([h, text, t]) => ({ at: ago(h), text, source: src(t) })),
});
let ITEMS = [
  item("billing-export", "Billing export", "Payments", "Ana Silva", "on-track", 9, 2, "Ship the CSV export behind the invoices page.", "PAY-412", [[2, "Moved to review", "PAY-412"], [70, "Started", "PAY-412"]]),
  item("search-v2", "Search v2", "Platform", "Dev Patel", "at-risk", 4, 5, "Unblock the indexer migration.", "PLAT-88", [[5, "Status changed from On track to At risk", "PLAT-90"], [48, "Due date moved out by five days", "PLAT-88"]]),
  item("offline-mode", "Offline mode", "Mobile", "Kai Müller", "late", -3, 20, "Agree the sync API contract with Platform.", "MOB-301", [[20, "Missed its due date", "MOB-301"], [120, "Waiting on the sync API", "MOB-299"]]),
  item("refund-flow", "Refund flow", "Payments", "Ana Silva", "on-track", 6, 1, "Final review with Support.", "PAY-398", [[1, "Review requested", "PAY-398"]]),
  item("sso-rollout", "SSO rollout", "Identity", "Lena Ortiz", "on-track", 21, 30, "Enable for the second pilot group.", "ID-57", [[30, "Pilot group one is live", "ID-55"]]),
  item("audit-log", "Audit log", "Identity", "Sam Reed", "at-risk", 2, 8, "Decide the retention period.", "ID-61", [[8, "Retention question raised", "ID-61"]]),
  item("usage-dashboards", "Usage dashboards", "Data", "Mia Chen", "on-track", 14, 26, "Wire the weekly rollups.", "DATA-140", [[26, "Design approved", "DATA-138"]]),
  item("cost-alerts", "Cost alerts", "Data", "Omar Haddad", "late", -1, 40, "Fix the threshold calculation.", "DATA-151", [[40, "Missed its due date", "DATA-151"]]),
  item("push-notifications", "Push notifications", "Mobile", "Kai Müller", "on-track", 11, 3, "Beta to internal testers.", "MOB-318", [[3, "Beta build passed QA", "MOB-318"]]),
  item("api-rate-limits", "API rate limits", "Platform", "Dev Patel", "done", -6, 90, "", "PLAT-71", [[90, "Shipped", "PLAT-71"]]),
  item("invoice-redesign", "Invoice redesign", "Payments", "Noor Aziz", "done", -12, 200, "", "PAY-350", [[200, "Shipped", "PAY-350"]]),
  item("status-page", "Status page", "Platform", "Lena Ortiz", "at-risk", 7, 12, "Pick a hosting option.", "PLAT-95", [[12, "Hosting option still open", "PLAT-95"]]),
];

const json = (res, code, body) => (res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY }), res.end(JSON.stringify(body)));

async function body(req) {
  let size = 0, chunks = [];
  for await (const c of req) if ((size += c.length) > 4096) throw Object.assign(new Error("too large"), { status: 413 }); else chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}

async function api(req, res, path) {
  if (path === "/api/items" && req.method === "GET") return json(res, 200, { items: ITEMS });
  const m = /^\/api\/items\/([\w-]+)$/.exec(path);
  const found = m && ITEMS.find((i) => i.id === m[1]);
  if (m && !found) return json(res, 404, { error: "No project with that id." });
  if (found && req.method === "GET") return json(res, 200, found);
  if (found && req.method === "PATCH") {
    if (!String(req.headers["content-type"]).startsWith("application/json")) return json(res, 415, { error: "Send JSON." });
    const { status } = await body(req);
    if (!STATUSES.includes(status)) return json(res, 400, { error: `Status must be one of ${STATUSES.join(", ")}.` });
    const next = { ...found, status, updated: new Date().toISOString(), history: [{ at: new Date().toISOString(), text: `Status changed from ${LABELS[found.status]} to ${LABELS[status]}`, source: found.source }, ...found.history] };
    ITEMS = ITEMS.map((i) => (i.id === found.id ? next : i));
    return json(res, 200, next);
  }
  return json(res, m ? 405 : 404, { error: m ? "Method not allowed." : "Not found." });
}

let indexHtml;
async function page(res, code) {
  indexHtml ??= await readFile(join(DIST, "index.html"), "utf8");
  const nonce = randomBytes(18).toString("base64");
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": csp(nonce), ...SECURITY });
  res.end(indexHtml.replace("__CSP_NONCE__", nonce));
}

async function asset(res, path) {
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + "/") || file.endsWith("index.html")) return false;
  try {
    const data = await readFile(file);
    const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300";
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": cache, ...SECURITY });
    res.end(data);
    return true;
  } catch { return false; }
}

const protect = process.env.AIDENHQ_APP ? createIdentity().protect : (h) => h;

export const server = createServer(protect(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    if (path === "/api/health") return json(res, 200, { ok: true, checks: [] });
    if (path.startsWith("/api/")) return await api(req, res, path);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
    if (await asset(res, path)) return;
    return await page(res, PAGES.has(path) ? 200 : 404);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "Something failed on the server. Try again in a moment." });
  }
}, { health: "/api/health" }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`listening on ${port}`));
}

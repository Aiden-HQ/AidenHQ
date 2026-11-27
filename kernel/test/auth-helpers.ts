// Shared by the accounts tests (lean 3g): a TOTP function, a JSON Better Auth listener over accounts.step (the admin
// listener's sign-in steps, as the old board tests' adminListener drove them), and a cookie-keeping JSON caller.
import { createHmac } from "node:crypto";
import { request } from "node:http";
import { serve, readBody } from "./helpers.ts";

export const silent = { info() {}, warn() {}, error() {} };
export const PASSWORD = "correct horse battery staple";

/** RFC 6238 (SHA-1, 6 digits, 30 s), `step` periods from now, from an otpauth:// URI or a base32 secret. */
export function totp(uriOrKey, step = 0) {
  const b32 = uriOrKey.startsWith("otpauth:") ? new URL(uriOrKey).searchParams.get("secret") : uriOrKey;
  let bits = "";
  for (const c of b32.replace(/=+$/, "")) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c.toUpperCase()).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + step));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Better Auth's endpoints under /api/auth on a loopback listener, through the kernel's own accounts.step (listener "admin"). */
export async function stepListener(accounts) {
  const { s, url } = await serve(async (req, res) => {
    const sub = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/api\/auth/, "");
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    const r = await accounts.step(req, sub, body);
    res.writeHead(r.status, { "content-type": "application/json", ...(r.retryAfter ? { "retry-after": r.retryAfter } : {}), ...(r.cookies.length ? { "set-cookie": r.cookies } : {}) }).end(JSON.stringify({ ...r.json, ...(r.ok ? {} : { message: r.error }) }));
  });
  return { url, close: () => s.close() };
}

/** One JSON request with node:http (fetch can't set Host). Returns { status, json, body, headers, cookies, cookie }. */
export function call(base, method, path, { host, body, https = false, cookie = "", headers = {}, origin } = {}) {
  const h = { ...(host ? { host } : {}), ...(https ? { "x-forwarded-proto": "https" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { "content-type": "application/json", origin: origin ?? `${https ? "https" : "http"}://${host}` } : {}), ...headers };
  return new Promise((ok, no) => {
    const r = request(`${base}${path}`, { method, headers: h }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => ok({ status: res.statusCode, body: d, json: /^[[{]|^null$/.test(d) ? JSON.parse(d) : {}, headers: res.headers, cookies: res.headers["set-cookie"] ?? [], cookie: (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ") }));
    });
    r.on("error", no);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** A browser on one listener: keeps its cookies in `jar` (share a jar between browsers as a real browser does across ports). */
export function jsonBrowser(base, host, { https = false, jar = new Map() } = {}) {
  const fn = async (method, path, body, extra = {}) => {
    const { origin, ...headers } = extra;
    const r = await call(base, method, path, { host, body, https, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), headers, origin });
    for (const c of r.cookies) {
      const [kv, ...attrs] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || v === "") jar.delete(k); else jar.set(k, v);
    }
    return r;
  };
  fn.jar = jar;
  return fn;
}

/** A request object as accounts.sessionOf wants it, carrying a browser's cookies. */
export const reqWith = (jar, host = "localhost:3120", https = false) => ({ headers: { host, ...(https ? { "x-forwarded-proto": "https" } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });

/** The backplane's /v1/<group>/<op> routes for accounts (createAuthApi) on a loopback listener; `whoami`: bearer → identity. */
export async function authApiServer(accounts, { whoami = async () => undefined, boardKey = "b".repeat(40), operatorKey = "o".repeat(40), secrets, validate } = {}) {
  const { createAuthApi } = await import("../src/auth-api.ts");
  const api = createAuthApi({ accounts: () => accounts, whoami, boardKey: () => boardKey, operatorKey: () => operatorKey, secrets, validate });
  const { s, url } = await serve(async (req, res) => {
    const [, , group, op] = new URL(req.url, "http://x").pathname.split("/");
    try {
      await api(req, res, group, op);
    } catch (e) {
      res.writeHead(e.status ?? 500, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: e.type, message: e.message } }));
    }
  });
  const post = (path, body, headers = {}) => call(url, "POST", path, { host: "kernel.example", body, headers, origin: "" });
  return { url, post, boardKey, operatorKey, close: () => s.close() };
}

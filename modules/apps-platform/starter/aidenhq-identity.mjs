// AidenHQ app identity (docs/design/app-identity.md). Copy this file into an app unchanged; no dependencies.
// Every request from the gate (people) or apps-mcp (agents) carries X-AidenHQ-Identity: a short-lived Ed25519 JWT for this
// app. identify(req) → { sub, email, name, role, kind } (or null: a token-less caller on a tailnet-only app), else throws with
// .status 401/403/503. protect(handler, { health }) wraps the app's whole request handler (and use it on upgrades too): every
// path but the exact health path needs a valid identity, set as req.user. Key the app's own rules on user.sub and user.role.
import { createPublicKey, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const KINDS = { "aidenhq-gate": "person", "aidenhq-apps": "agent" }; // each issuer may assert only its own kind
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const part = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const int = (n) => Number.isSafeInteger(n);

export function createIdentity({ app = process.env.AIDENHQ_APP, keysFile = "/run/secrets/AIDENHQ_IDENTITY_KEYS", anonymous = process.env.AIDENHQ_ANONYMOUS === "tailnet", now = () => Date.now() / 1000 } = {}) {
  if (!app) throw new Error("AIDENHQ_APP is not set (the platform sets it to the app's name)");
  let keys = new Map(), mtime = -1;
  const keyFor = (kid) => {
    try {
      const m = statSync(keysFile).mtimeMs;
      if (m !== mtime) (keys = new Map(JSON.parse(readFileSync(keysFile, "utf8")).keys.map((k) => [k.kid, { iss: k.iss, key: createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: "jwk" }) }]))), (mtime = m);
    } catch { mtime = -1; throw fail(503, "identity keys unavailable"); }
    return keys.get(kid);
  };
  const identify = (req) => {
    const token = req.headers["x-aidenhq-identity"];
    // Tailnet-only apps (set by the platform): a token-less request is an anonymous caller, who gets only what the app
    // gives anyone (reads, a public form); a request with a token must still carry a valid one.
    if (!token && anonymous) return null;
    const p = String(token ?? "").split(".");
    if (p.length !== 3) throw fail(401, "no identity");
    let h, c;
    try { (h = part(p[0])), (c = part(p[1])); } catch { throw fail(401, "bad identity"); }
    const k = h.alg === "EdDSA" && typeof h.kid === "string" ? keyFor(h.kid) : undefined;
    if (!k || !verify(null, Buffer.from(`${p[0]}.${p[1]}`), k.key, Buffer.from(p[2], "base64url"))) throw fail(401, "bad identity");
    const t = now(), kind = KINDS[c.iss];
    if (k.iss !== c.iss || !kind || c.kind !== kind || c.aud !== app) throw fail(401, "identity not for this app");
    if (!int(c.iat) || !int(c.exp) || c.exp <= c.iat || c.exp - c.iat > 300 || c.iat > t + 60 || t >= c.exp) throw fail(401, "identity expired");
    const sub = kind === "agent" ? /^agent:[a-z0-9][a-z0-9_-]*$/ : /^u_[A-Za-z0-9_-]{22}$/;
    if (typeof c.sub !== "string" || !sub.test(c.sub) || !/^[a-z][a-z0-9-]{1,30}$/.test(c.role) || c.role === "blocked") throw fail(401, "bad identity");
    // An agent's token names exactly what it may do: app_api one method on one path, app_view reads.
    const path = String(req.url ?? "").split("?")[0];
    if ((c.methods !== undefined && !(Array.isArray(c.methods) && c.methods.includes(req.method))) || (c.path !== undefined && c.path !== path)) throw fail(403, "identity not for this request");
    return { sub: c.sub, email: String(c.email ?? ""), name: String(c.name ?? ""), role: c.role, kind };
  };
  const protect = (handler, { health = "/health" } = {}) => (req, res, ...rest) => {
    if (String(req.url ?? "").split("?")[0] !== health || req.method !== "GET") {
      try { req.user = identify(req); } catch (e) {
        if (res.writeHead) return void res.writeHead(e.status ?? 401, { "content-type": "text/plain" }).end(`${e.message}\n`);
        return void res.end(`HTTP/1.1 ${e.status ?? 401} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); // an upgrade's socket
      }
    }
    return handler(req, res, ...rest);
  };
  return { identify, protect };
}

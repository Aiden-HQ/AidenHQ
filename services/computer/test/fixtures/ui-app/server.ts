// The ui-review engine's fixture app: one HTML shell, a hash router, 60 routes. Neutral copy (acme, example.com).
//   node server.ts [port]      serves it (prints the URL)
//   startFixture(port?)        for tests: { url, writes(), set(key, value), close() }
// Routes (ROUTES, as /#/name): the generated r01..r54 plus live (polls every 50 ms, never settles), /scroll (scrolls inside <main>),
// /planted (the measurement plants), /clock ("2m ago" from Date.now()), /danger (a POST on mount, and Delete and Pay POST: the server counts writes),
// /socket-write (writes over a WebSocket on load: socketWrites()).
// Server-rendered pages for the login ladder (the signed-in pages expire `sessionSeconds` after sign-in, 30 by default):
//   /login (password, then a TOTP step; user SIGN_IN.user, SIGN_IN.password, seed SIGN_IN.totp), /app/<name> (signed in, else a
//   redirect to /login), /admin-only (an admin only: 403 for the member), /signup (mails a link through SMTP on 127.0.0.1:1025,
//   Mailpit), /signup-captcha (a reCAPTCHA box), /split (a Save that POSTs to the api.localhost origin: apiWrites()).
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { totp } from "../../../images/agent-base/ui-review/totp.ts";

export const SIGN_IN = { user: "member", password: "correct horse battery staple", totp: "JBSWY3DPEHPK3PXP" };

const dir = fileURLToPath(new URL(".", import.meta.url));
const shell = (title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>`;

/** The 60 navigable paths, relative to the fixture URL (app.js renders the same set from the hash). */
export const ROUTES: string[] = ["/", "/#/live", "/#/scroll", "/#/planted", "/#/clock", "/#/danger", ...Array.from({ length: 54 }, (_, i) => `/#/r${String(i + 1).padStart(2, "0")}`)];

export type Fixture = { url: string; port: number; writes(): number; apiWrites(): number; socketWrites(): number; signups(): number; set(key: string, value: string): void; close(): Promise<void> };

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/style.css"></head><body><main>${body}</main></body></html>`;
const html = (res: import("node:http").ServerResponse, title: string, body: string, status = 200, headers: Record<string, string> = {}) => void res.writeHead(status, { "content-type": "text/html", ...headers }).end(page(title, body));
const form = (q: string) => Object.fromEntries(new URLSearchParams(q));

/** One mail through SMTP (Mailpit on 127.0.0.1:1025). */
function sendMail(to: string, text: string): Promise<void> {
  return new Promise((ok, no) => {
    const s = connect(1025, "127.0.0.1"), lines = ["HELO fixture", "MAIL FROM:<noreply@acme.example>", `RCPT TO:<${to}>`, "DATA", `From: noreply@acme.example\r\nTo: ${to}\r\nSubject: Confirm your Acme account\r\n\r\n${text}\r\n.`, "QUIT"];
    s.on("data", () => { const l = lines.shift(); if (l !== undefined) s.write(l + "\r\n"); else s.end(); });
    s.on("close", () => ok()); s.on("error", no);
  });
}

export async function startFixture(port = 0, o: { sessionSeconds?: number } = {}): Promise<Fixture> {
  let writes = 0, apiWrites = 0, socketWrites = 0, signups = 0;
  const state: Record<string, string> = { "planted-title": "Planted page" };
  const sessions = new Map<string, { user: string; until: number }>(), pending = new Map<string, string>(), verify = new Map<string, string>();
  const ttl = (o.sessionSeconds ?? 30) * 1000;
  const who = (req: import("node:http").IncomingMessage) => { const sid = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1]; const s = sid ? sessions.get(sid) : undefined; return s && s.until > Date.now() ? s.user : undefined; };
  const signIn = (res: import("node:http").ServerResponse, user: string) => { const sid = randomBytes(12).toString("hex"); sessions.set(sid, { user, until: Date.now() + ttl }); res.writeHead(302, { location: "/app/home", "set-cookie": `sid=${sid}; Path=/; HttpOnly` }).end(); };
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    let body = "";
    for await (const c of req) body += c;
    if (req.method === "POST" && /^api\./.test(req.headers.host ?? "")) { apiWrites++; return void res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end("{}"); }
    if (req.method === "POST" && path === "/login") {
      const f = form(body);
      if (f.username !== SIGN_IN.user || f.password !== SIGN_IN.password) return html(res, "Sign in · Acme", `<h1>Sign in</h1><p>Wrong user or password.</p>`, 401);
      const t = randomBytes(8).toString("hex"); pending.set(t, f.username);
      return html(res, "Two-step · Acme", `<h1>Enter your code</h1><form method="post" action="/login/totp"><input type="hidden" name="t" value="${t}"><input name="code" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>`);
    }
    if (req.method === "POST" && path === "/login/totp") {
      const f = form(body), user = pending.get(f.t);
      if (!user || ![totp(SIGN_IN.totp), totp(SIGN_IN.totp, Date.now() - 30_000)].includes(f.code)) return html(res, "Two-step · Acme", `<h1>Wrong code</h1>`, 401);
      pending.delete(f.t);
      return signIn(res, user);
    }
    if (req.method === "POST" && path === "/signup") {
      const f = form(body), t = randomBytes(12).toString("hex");
      verify.set(t, f.email); signups++;
      await sendMail(f.email, `Confirm your account: http://${req.headers.host}/signup/verify?token=${t}`).catch(() => {});
      return html(res, "Check your mail · Acme", `<h1>Check your mail</h1><p>We sent a link to confirm your account.</p>`);
    }
    if (req.method === "POST") {
      if (path.startsWith("/api/")) writes++;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/login") return html(res, "Sign in · Acme", `<h1>Sign in</h1><form method="post" action="/login"><label>User <input name="username" autocomplete="username"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>`);
    if (path === "/signup") return html(res, "Sign up · Acme", `<h1>Create your account</h1><form method="post" action="/signup"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign up</button></form>`);
    if (path === "/signup-captcha") return html(res, "Sign up · Acme", `<h1>Create your account</h1><form method="post" action="/signup"><input type="email" name="email"><input type="password" name="password"><div class="g-recaptcha" data-sitekey="x"></div><button>Sign up</button></form>`);
    if (path === "/signup/verify") {
      const t = new URL(req.url!, "http://x").searchParams.get("token") ?? "", email = verify.get(t);
      if (!email) return html(res, "Link expired · Acme", `<h1>That link has expired</h1>`, 400);
      verify.delete(t);
      return signIn(res, email);
    }
    if (path === "/split") return html(res, "Split · Acme", `<h1>Split origins</h1><button id="save" onclick="fetch('http://api.localhost:${(server.address() as { port: number }).port}/api/save',{method:'POST',mode:'no-cors'}).catch(()=>{})">Save</button>`);
    if (path === "/admin-only") return who(req) === "admin" ? html(res, "Admin · Acme", `<h1>Admin</h1>`) : html(res, "Forbidden · Acme", `<h1>Admins only</h1>`, 403);
    if (path.startsWith("/app/")) {
      const user = who(req);
      if (!user) return void res.writeHead(302, { location: "/login" }).end();
      const name = path.slice(5) || "home";
      return html(res, `${name} · Acme`, `<h1>Signed-in page ${name}</h1><div class="card">Hello ${user.replace(/[<>&"]/g, "")}. Acme orders for ${name}.</div><nav>${["home", "orders", "billing", "team"].map((n) => `<a href="/app/${n}">${n}</a>`).join(" ")}</nav>`);
    }
    if (path === "/app.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(`${dir}app.js`));
    if (path === "/style.css") return void res.writeHead(200, { "content-type": "text/css" }).end(readFileSync(`${dir}style.css`));
    if (path === "/api/state") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
    if (path === "/api/items") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: 1, name: "Acme order 1001" }, { id: 2, name: "Acme order 1002" }]));
    if (path === "/api/live") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ t: Date.now() }));
    if (path === "/" || path === "/index.html" || !path.includes(".")) return void res.writeHead(200, { "content-type": "text/html" }).end(shell("Acme fixture"));
    res.writeHead(404).end("not found");
  });
  // A WebSocket at /ws: every frame the client sends counts as a write.
  server.on("upgrade", (req, sock) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on("data", () => { socketWrites++; });
    sock.on("end", () => sock.end()); sock.on("error", () => {});
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const p = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${p}`, port: p, writes: () => writes, apiWrites: () => apiWrites, socketWrites: () => socketWrites, signups: () => signups, set: (k, v) => { state[k] = v; },
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await startFixture(Number(process.argv[2] ?? 0));
  console.log(f.url);
}

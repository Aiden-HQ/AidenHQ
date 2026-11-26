// The job tools this module serves to its own pass (module.yaml providers.jobtools; the kernel's POST
// /v1/jobtools/module/design/<op> forwards a job's call here as { op, body, caller } with this module's key). The kernel signs
// nothing more: the service key on the request is what makes `caller` the kernel's word.
//
// login { app, nonce } releases the app's supplied login (secret ui_logins) to the box's `ui-review` process, only when:
//   the caller holds role ui-login; its task is the design module's own pass for that app (task_module design, task_source
//   design:pass:<app>:<run>); that run is the app's running pass at depth signed-in or tester; the app is not an AidenHQ app
//   (those sign in through the test-user session, read-only); a login is set; and `nonce` is the run's current login nonce.
// Each answer spends that nonce and carries the next one (`next_nonce`), which the engine writes back where the agent can't
// read it, so a dead session's re-login works and a replay doesn't. Every refusal is 403 with its reason and nothing else.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Passes, Login } from "./passes.ts";
import type { Store } from "./store.ts";

export type JobCaller = { agent: string; roles: string[]; task: string; task_module: string | null; task_source: string | null };
type Answer = { status: number; body: Record<string, unknown> };
const refuse = (why: string): Answer => ({ status: 403, body: { error: why } });

/** RFC 6238 (SHA-1, 30 s, 6 digits) from a base32 seed: the current code, never the seed. */
export function totp(seed: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of seed.toUpperCase().replace(/[\s=-]/g, "")) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error("the TOTP seed isn't base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function createJobTools(d: { passes: Passes; store: Store; logins: () => Record<string, Login>; now?: () => number }) {
  const now = d.now ?? Date.now;
  function login(body: Record<string, unknown>, caller: JobCaller): Answer {
    const name = String(body.app ?? "");
    if (!caller.roles.includes("ui-login")) return refuse("login is for an agent with the ui-login role");
    if (caller.task_module !== "design") return refuse("login is only for the design module's own pass");
    const p = d.passes.passFor(name, caller.task_source);
    if (p.refused) return refuse(p.refused);
    if (p.app!.aidenhq_app) return refuse(`${p.app!.name} is an AidenHQ app: it signs in through the test-user session (read-only), never a supplied login`);
    if (p.run!.depth === "scan") return refuse(`pass ${p.run!.id} is a scan: it doesn't sign in`);
    const l = d.logins()[p.app!.name];
    if (!l) return refuse(`no login is set for ${p.app!.name} (secret ui_logins)`);
    if (typeof body.nonce !== "string" || !d.store.nonceIs(p.run!.id, body.nonce)) return refuse("login needs the run's current login nonce (a run token or a spent nonce is refused)");
    let code: string | undefined;
    try { code = l.totp_secret ? totp(l.totp_secret, now()) : undefined; } catch { return refuse(`the login for ${p.app!.name} has a TOTP seed that isn't base32`); }
    const next = d.store.issueNonce(p.run!.id);
    return { status: 200, body: { login_url: l.login_url, username: l.username, password: l.password, ...(code ? { totp: code } : {}), next_nonce: next } };
  }
  const ops: Record<string, (b: Record<string, unknown>, c: JobCaller) => Answer> = { login };

  /** One forwarded call: 404 for an op this module doesn't serve. */
  const answer = (op: string, body: unknown, caller: JobCaller): Answer => {
    const f = Object.hasOwn(ops, op) ? ops[op] : undefined;
    if (!f) return { status: 404, body: { error: `no job tool ${String(op).slice(0, 40)}` } };
    return f(body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}, caller);
  };

  /** POST /jobtools with this module's key; false for any other path. */
  async function serve(req: IncomingMessage, res: ServerResponse, key: () => string): Promise<boolean> {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/jobtools") return false;
    const send = (a: Answer) => void res.writeHead(a.status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(a.body));
    const want = Buffer.from(key()), got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return send({ status: 401, body: { error: "not the kernel" } }), true;
    let n = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) { n += (c as Buffer).length; if (n > 64 * 1024) return send({ status: 413, body: { error: "too large" } }), true; chunks.push(c as Buffer); }
    let m: { op?: unknown; body?: unknown; caller?: Partial<JobCaller> };
    try { m = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send({ status: 400, body: { error: "send { op, body, caller }" } }), true; }
    const c = m?.caller;
    if (!c || typeof c.agent !== "string" || !Array.isArray(c.roles) || typeof c.task !== "string") return send({ status: 400, body: { error: "send { op, body, caller }" } }), true;
    const caller: JobCaller = { agent: c.agent, roles: c.roles.map(String), task: c.task, task_module: typeof c.task_module === "string" ? c.task_module : null, task_source: typeof c.task_source === "string" ? c.task_source : null };
    return send(answer(String(m.op ?? ""), m.body, caller)), true;
  }
  return { answer, serve };
}

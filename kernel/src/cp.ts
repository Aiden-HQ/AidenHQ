// ANY /v1/cp/agent/<path>: a module acting as the agent whose tool call it is serving. The module's own token plus the
// caller assertion it was handed (X-AidenHQ-Caller), which opens this route only while that call is in flight and only for
// the module it was addressed to (assert.ts). The path must be one of the control plane's agent routes below; the kernel
// forwards with the caller's control-plane credential (identity.ts), so the control plane sees the agent itself, never the
// owner; a caller without one is refused. A status change to `done` passes the
// finish gate first (checks.ts): held or reopened, the change isn't forwarded and the answer says so (202). A task a job
// creates gets the kernel's provenance (provenance.ts): its intent before the POST, its row on the 201; no PATCH changes its marker.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Asserter } from "./assert.ts";
import type { Checks } from "./checks.ts";
import type { Connection, Whoami } from "./identity.ts";
import type { Provenance } from "./provenance.ts";
import { fail } from "./proxy.ts";

// One path segment: never a dot segment, which URL resolution would turn into another route.
const ID = "(?!\\.+(?:/|$))[A-Za-z0-9_.:-]{1,100}";
/** The control plane's agent routes a module may use as the caller, by method (query strings are passed as they are). */
export const CP_AGENT_PATHS: [string, RegExp][] = [
  ["GET", /^\/api\/agents\/me$/],
  ["GET", new RegExp(`^/api/agents/${ID}/instructions-bundle/file$`)],
  ["GET", new RegExp(`^/api/companies/${ID}$`)],
  ["GET", new RegExp(`^/api/companies/${ID}/(agents|labels|issues)$`)],
  ["POST", new RegExp(`^/api/companies/${ID}/issues$`)],
  ["GET", new RegExp(`^/api/issues/${ID}$`)],
  ["PATCH", new RegExp(`^/api/issues/${ID}$`)],
  ["GET", new RegExp(`^/api/issues/${ID}/(comments|attachments)$`)],
  ["POST", new RegExp(`^/api/issues/${ID}/comments$`)],
  ["GET", new RegExp(`^/api/attachments/${ID}/content$`)],
];
const MAX = 32 * 1024 * 1024;

export function createCp({ whoami, asserter, controlUrl, checks, provenance, log = () => {} }: {
  whoami: Whoami; asserter: Asserter; controlUrl: string; checks?: Checks; provenance: Provenance; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  return async function cp(req: IncomingMessage, res: ServerResponse, path: string, query: string): Promise<void> {
    const mod = await whoami(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim()).catch(() => undefined);
    if (mod?.kind !== "module" || !mod.module) throw fail(401, "unauthorized", "a module's own token is required");
    const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), mod.module);
    if (!live) throw fail(401, "unauthorized", "the caller assertion isn't for a call in flight to this module");
    const method = String(req.method);
    if (!CP_AGENT_PATHS.some(([m, re]) => m === method && re.test(path))) throw fail(403, "forbidden", `${method} ${path} isn't an agent route`);
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 4 * 1024 * 1024) throw fail(413, "too_large", "too large"); chunks.push(c); }
    let body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
    const target = `${path}${query}`;
    const job = live.caller.kind === "job" ? { agent: live.caller.agent, task: live.caller.task ?? "" } : undefined;
    if (job && provenance.stuck(job.agent, job.task)) throw fail(503, "reconciling", "a task this job created is still being reconciled; retry in a few minutes");
    const task = method === "PATCH" ? /^\/api\/issues\/([^/]+)$/.exec(path)?.[1] : undefined;
    // Any caller's PATCH: a task's provenance marker stays as it is (provenance.ts).
    if (task) await provenance.guard(decodeURIComponent(task), body);
    if (task && checks) {
      let status: unknown;
      try { status = JSON.parse(body?.toString("utf8") || "{}")?.status; } catch { throw fail(400, "bad_request", "the body must be JSON"); }
      if (status === "done") {
        // The tool claim is `<connection>.<tool>`, the connection always this module's own: the check gets the tool's name.
        const tool = String(live.caller.tool ?? "").split(".").pop()!;
        const f = await checks.finish(decodeURIComponent(task), { agent: live.caller.agent, tool, via: tool });
        if (!f.pass) {
          const out = Buffer.from(JSON.stringify("held" in f ? { held: { state: f.state, reason: f.reason } } : { reopened: { reason: f.reason } }));
          log("cp", { module: mod.module, agent: live.caller.key, method, path, finish: "held" in f ? "held" : "reopened" });
          return void res.writeHead(202, { "content-type": "application/json", "content-length": out.length }).end(out);
        }
      }
    }
    // The finish gate first: a held or refused close never needs the caller's credential.
    const cred = live.flight.credential;
    if (!cred) throw fail(403, "forbidden", "this caller has no control-plane identity");
    const company = job && method === "POST" ? new RegExp(`^/api/companies/(${ID})/issues$`).exec(path)?.[1] : undefined;
    const intent = company ? await provenance.intend({ company, ...job!, body: body! }) : undefined;
    if (intent) body = intent.body;
    let status: number, type: string, out: Buffer;
    try {
      const r = await fetch(new URL(target, controlUrl), {
        method, signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${cred}`, accept: String(req.headers.accept ?? "application/json"), ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body } : {}),
      });
      status = r.status; type = r.headers.get("content-type") ?? "application/json"; out = Buffer.from(await r.arrayBuffer());
    } catch (e) { if (intent) provenance.settle(intent.id); throw e; }
    if (intent) provenance.settle(intent.id, status, out);
    if (out.length > MAX) throw fail(502, "too_large", "the control plane's answer is too large");
    log("cp", { module: mod.module, agent: live.caller.key, method, path, status });
    res.writeHead(status, { "content-type": type, "content-length": out.length }).end(out);
  };
}

/** The control plane's routes the board reads as the owner (GET /v1/cp/read/<path> with the board's key). */
export const BOARD_READ_PATHS: RegExp[] = [
  /^\/api\/cli-auth\/me$/,
  new RegExp(`^/api/companies/${ID}$`),
  new RegExp(`^/api/companies/${ID}/(agents|labels|issues|live-runs|heartbeat-runs|routines|approvals)$`),
  new RegExp(`^/api/companies/${ID}/adapters/${ID}/models$`),
  new RegExp(`^/api/companies/${ID}/costs/(by-agent|by-agent-model)$`),
  new RegExp(`^/api/heartbeat-runs/${ID}(/log)?$`),
  new RegExp(`^/api/issues/${ID}(/comments|/attachments)?$`),
  new RegExp(`^/api/attachments/${ID}/content$`),
  new RegExp(`^/api/agents/${ID}/instructions-bundle/file$`),
];
/** The owner's writes the board makes (ANY /v1/cp/owner/<path> with the board's key), by method. */
export const BOARD_WRITE_PATHS: [string, RegExp][] = [
  ["POST", new RegExp(`^/api/companies/${ID}/(labels|approvals|issues)$`)],
  ["POST", new RegExp(`^/api/companies/${ID}/issues/${ID}/attachments$`)],
  ["POST", new RegExp(`^/api/agents/${ID}/(pause|resume|clear-error|wakeup)$`)],
  ["PATCH", new RegExp(`^/api/issues/${ID}$`)],
  ["POST", new RegExp(`^/api/issues/${ID}/(comments|recovery-actions/resolve)$`)],
  ["DELETE", new RegExp(`^/api/issues/${ID}/approvals/${ID}$`)],
  ["POST", new RegExp(`^/api/approvals/${ID}/reject$`)],
  ["POST", new RegExp(`^/api/heartbeat-runs/${ID}/cancel$`)],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`)],
  ["POST", new RegExp(`^/api/routines/${ID}/run$`)],
];
// An attachment the board uploads (10 MB, multipart) fits; nothing else comes near.
const BOARD_MAX_BODY = 16 * 1024 * 1024;

/**
 * The board's only way to the control plane: GET /v1/cp/read/<path> (reads) and ANY /v1/cp/owner/<path> (the owner's
 * writes), both with the board's key on the kernel (the backplane checks it). Only the kernel holds the control plane's
 * owner key (paperclip_board_key); the board holds none. Each path must be on the board's list for its method. Bodies and
 * answers pass as they are (an attachment upload is multipart, its content bytes). `X-AidenHQ-Account` names the signed-in
 * admin a write is for (none: the board's own timers and notices); it is logged with the write.
 */
export function createBoardCp({ controlUrl, key, log = () => {} }: { controlUrl: string; key: () => string; log?: (msg: string, f?: Record<string, unknown>) => void }) {
  return async function boardCp(req: IncomingMessage, res: ServerResponse, lane: string, path: string, query: string): Promise<void> {
    const method = String(req.method);
    const allowed = lane === "read" ? method === "GET" && BOARD_READ_PATHS.some((re) => re.test(path)) : BOARD_WRITE_PATHS.some(([m, re]) => m === method && re.test(path));
    if (!allowed) throw fail(403, "forbidden", `${method} ${path} isn't one of the board's ${lane === "read" ? "read" : "owner"} routes`);
    const account = String(req.headers["x-aidenhq-account"] ?? "");
    if (account && !/^[A-Za-z0-9_-]{1,100}$/.test(account)) throw fail(400, "bad_request", "X-AidenHQ-Account isn't an account id");
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > BOARD_MAX_BODY) throw fail(413, "too_large", "too large"); chunks.push(c); }
    const body = method === "GET" ? undefined : Buffer.concat(chunks);
    const type = req.headers["content-type"];
    const r = await fetch(new URL(`${path}${query}`, controlUrl), {
      method, signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${key()}`, accept: String(req.headers.accept ?? "application/json"), ...(body?.length && type ? { "content-type": String(type) } : {}) },
      ...(body?.length ? { body } : {}),
    });
    const out = Buffer.from(await r.arrayBuffer());
    if (out.length > MAX) throw fail(502, "too_large", "the control plane's answer is too large");
    if (lane === "owner") log("cp owner", { method, path, status: r.status, ...(account ? { account } : {}) });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json", "content-length": out.length }).end(out);
  };
}

/**
 * A module's model call for the caller it serves (an advisor or fan-out tool), billed to that caller's run: only
 * for a module whose connection declares model_as_caller, and only while that caller's tool call is in flight. Returns the
 * caller's own credential for the gateway to identify, or undefined when the request carries no assertion.
 */
export function createAsCaller({ whoami, connections, asserter, log = () => {} }: {
  whoami: Whoami; connections: () => Record<string, Connection>; asserter: Asserter; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  return async function asCaller(req: IncomingMessage): Promise<string | undefined> {
    const jwt = String(req.headers["x-aidenhq-caller"] ?? "");
    if (!jwt) return undefined;
    const mod = await whoami(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim()).catch(() => undefined);
    if (mod?.kind !== "module" || !mod.module) throw fail(401, "unauthorized", "a caller assertion needs a module's own token");
    if (!Object.values(connections()).some((c) => c.module === mod.module && c.model_as_caller === true)) throw fail(403, "forbidden", `${mod.module} doesn't make model calls for its callers`);
    const live = await asserter.inFlight(jwt, mod.module);
    if (!live?.flight.credential) throw fail(401, "unauthorized", "the caller assertion isn't for a call in flight to this module");
    log("model as caller", { module: mod.module, agent: live.caller.key, tool: live.caller.tool });
    return live.flight.credential;
  };
}

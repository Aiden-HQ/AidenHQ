// ANY /v1/cp/agent/<path>: a module acting as the agent whose tool call it is serving. The module's own token plus the
// caller assertion it was handed (X-AidenHQ-Caller), which opens this route only while that call is in flight and only for
// the module it was addressed to (assert.ts). The path must be one of the control plane's agent routes below; the kernel
// forwards with the caller's own credential (the run's JWT or agent key; an agent computer's run through its launcher, on the
// box's own bridge), so the control plane sees the agent itself, never the owner. A status change to `done` passes the
// finish gate first (checks.ts): held or reopened, the change isn't forwarded and the answer says so (202). A task a job
// creates gets the kernel's provenance (provenance.ts): its intent before the POST, its row on the 201.
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

export function createCp({ whoami, asserter, controlUrl, launcherUrl, checks, provenance, log = () => {} }: {
  whoami: Whoami; asserter: Asserter; controlUrl: string; launcherUrl?: string; checks?: Checks; provenance: Provenance; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  return async function cp(req: IncomingMessage, res: ServerResponse, path: string, query: string): Promise<void> {
    const mod = await whoami(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim()).catch(() => undefined);
    if (mod?.kind !== "module" || !mod.module) throw fail(401, "unauthorized", "a module's own token is required");
    const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), mod.module);
    if (!live) throw fail(401, "unauthorized", "the caller assertion isn't for a call in flight to this module");
    const method = String(req.method);
    if (!CP_AGENT_PATHS.some(([m, re]) => m === method && re.test(path))) throw fail(403, "forbidden", `${method} ${path} isn't an agent route`);
    const cred = live.flight.credential;
    if (!cred) throw fail(403, "forbidden", "this caller has no control-plane identity");
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 4 * 1024 * 1024) throw fail(413, "too_large", "too large"); chunks.push(c); }
    let body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
    const target = `${path}${query}`;
    const job = live.caller.kind === "job" ? { agent: live.caller.agent, task: live.caller.task ?? "" } : undefined;
    if (job && provenance.stuck(job.agent, job.task)) throw fail(503, "reconciling", "a task this job created is still being reconciled; retry in a few minutes");
    const company = job && method === "POST" ? new RegExp(`^/api/companies/(${ID})/issues$`).exec(path)?.[1] : undefined;
    const intent = company ? await provenance.intend({ company, ...job!, body: body! }) : undefined;
    if (intent) body = intent.body;
    const task = method === "PATCH" ? /^\/api\/issues\/([^/]+)$/.exec(path)?.[1] : undefined;
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
    let status: number, type: string, out: Buffer;
    try {
    if (cred.startsWith("ahqc_")) {
      // An agent computer's run: its control-plane credential works only inside its box (the launcher runs the call there).
      if (!launcherUrl) throw fail(503, "unavailable", "the computer launcher isn't configured");
      const r = await fetch(new URL("/cp", launcherUrl), { method: "POST", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, body: JSON.stringify({ method, path: target, ...(body?.length ? { body: body.toString("base64") } : {}) }), signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw fail(502, "bad_upstream", `the computer launcher answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = (await r.json()) as { status: number; type?: string; body?: string };
      status = j.status; type = j.type ?? "application/json"; out = Buffer.from(j.body ?? "", "base64");
    } else {
      const r = await fetch(new URL(target, controlUrl), {
        method, signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${cred}`, accept: String(req.headers.accept ?? "application/json"), ...(body ? { "content-type": "application/json" } : {}), ...(live.flight.run ? { "x-paperclip-run-id": live.flight.run } : {}) },
        ...(body ? { body } : {}),
      });
      status = r.status; type = r.headers.get("content-type") ?? "application/json"; out = Buffer.from(await r.arrayBuffer());
    }
    } catch (e) { if (intent) provenance.settle(intent.id); throw e; }
    if (intent) provenance.settle(intent.id, status, out);
    if (out.length > MAX) throw fail(502, "too_large", "the control plane's answer is too large");
    log("cp", { module: mod.module, agent: live.caller.key, method, path, status });
    res.writeHead(status, { "content-type": type, "content-length": out.length }).end(out);
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

// ANY /v1/cp/agent/<path>: a module acting as the job whose tool call it is serving. The module's own token plus the caller
// assertion it was handed (X-AidenHQ-Caller), which opens this route only while that call is in flight and only for the
// module it was addressed to (assert.ts). The path must be one of the control plane's agent routes below. The caller must be
// a kernel job (an agent on its task): its credential is the agent's own Paperclip key (secrets paperclip-agents/<agent>),
// which the kernel holds and never hands to a module; anything else is refused before anything runs.
// - Reads (GET) go to the control plane with that key.
// - Writes go through the paperclip-events plugin's signed `post` action (outcomes.ts createPluginPost, services/paperclip-events/
//   post.js), the only writer: Paperclip refuses an agent key's writes without a run. The kernel decides who writes where and
//   signs a `scope`; the plugin re-checks what it can see. A job writes on its own task (assigned to it), a task it created,
//   a child of a task assigned to it, and creates tasks as itself (under such a task, a part of its own under any task, or
//   top-level). The chief of staff (role fleet-admin) comments on any task of its company; an agent comments on the tasks the
//   grants table names for it (memory inbox, review log, chat) and a librarian on every memory inbox. Anything else is
//   refused, naming whom to ask. Each write carries a tag (the plugin's once-only key): on the job's own task and the chief of
//   staff's anywhere-comments the job tag (wakes.ts SELF_TAG: it wakes nobody), elsewhere `aidenhq:op=`, which wakes the
//   task's assignee as any agent's comment does.
// - A status change to `done` is for the job's own task only and passes the finish gate first (checks.ts): held or reopened,
//   nothing is written and the answer says so (202).
// - A task a job creates gets the kernel's provenance row (provenance.ts) from the plugin's answer.
// Answers look like Paperclip's: the task as it is now (a PATCH 200, a create 201 with `deduplicated`), a comment's {id} (201).
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Asserter } from "./assert.ts";
import type { Checks } from "./checks.ts";
import type { Connection, Grant, Whoami } from "./identity.ts";
import type { PluginPost } from "./outcomes.ts";
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
/** What a PATCH may change besides its status and comment (post.js PATCH_KEYS), and what a create may carry. */
const PATCH = ["title", "description", "priority", "assigneeAgentId", "assigneeUserId", "labelIds", "blockedByIssueIds"];
const CREATE = ["title", "description", "priority", "status", "assigneeAgentId", "assigneeUserId", "labelIds", "parentId", "idempotencyKey", "allowDuplicate"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Issue = { id: string; identifier?: string; assigneeAgentId?: string | null; createdByAgentId?: string | null; parentId?: string | null; status?: string };

export function createCp({ whoami, asserter, plugin, agentKey, grants, controlUrl, checks, provenance, log = () => {} }: {
  whoami: Whoami; asserter: Asserter; plugin: PluginPost;
  /** An agent's own Paperclip key (secrets paperclip-agents/<id>), or "". */
  agentKey: (agent: string) => string;
  /** The grants table's agents: roles, delegation targets and the tasks it names for each agent. */
  grants: () => Record<string, Grant>;
  controlUrl: string; checks?: Checks; provenance: Pick<Provenance, "carried" | "record">; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  // Writes whose answer was lost (a 5xx): the next try of the same write asks the plugin to look for it first.
  const unknown = new Set<string>();
  return async function cp(req: IncomingMessage, res: ServerResponse, path: string, query: string): Promise<void> {
    const mod = await whoami(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim()).catch(() => undefined);
    if (mod?.kind !== "module" || !mod.module) throw fail(401, "unauthorized", "a module's own token is required");
    const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), mod.module);
    if (!live) throw fail(401, "unauthorized", "the caller assertion isn't for a call in flight to this module");
    const method = String(req.method);
    if (!CP_AGENT_PATHS.some(([m, re]) => m === method && re.test(path))) throw fail(403, "forbidden", `${method} ${path} isn't an agent route`);
    // The credential first: only a kernel job (an agent on its task) has one, and nothing runs for a caller without it.
    const c = live.caller;
    const agent = c.kind === "run" && c.agent && c.task ? c.agent : "";
    const key = agent ? agentKey(agent) : "";
    if (!key) throw fail(403, "forbidden", "this caller has no control-plane identity (only a kernel job acts on the control plane)");
    const task = c.task!;
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const ch of req) { n += ch.length; if (n > 4 * 1024 * 1024) throw fail(413, "too_large", "too large"); chunks.push(ch); }
    const read = async (p: string) => {
      const r = await fetch(new URL(p, controlUrl), { signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${key}`, accept: String(req.headers.accept ?? "application/json") } });
      return { status: r.status, type: r.headers.get("content-type") ?? "application/json", out: Buffer.from(await r.arrayBuffer()) };
    };
    const answer = (status: number, out: Buffer, type = "application/json") => {
      if (out.length > MAX) throw fail(502, "too_large", "the control plane's answer is too large");
      log("cp", { module: mod.module, agent: c.key, method, path, status });
      res.writeHead(status, { "content-type": type, "content-length": out.length }).end(out);
    };
    if (method === "GET") { const r = await read(`${path}${query}`); return answer(r.status, r.out, r.type); }

    let b: Record<string, unknown>;
    try { b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
    if (!b || typeof b !== "object" || Array.isArray(b)) throw fail(400, "bad_request", "the body must be a JSON object");
    const issue = async (ref: string): Promise<Issue> => {
      const r = await read(`/api/issues/${encodeURIComponent(ref)}`);
      if (r.status === 404) throw fail(404, "not_found", `no task ${ref}`);
      if (r.status !== 200) throw fail(502, "bad_upstream", `the control plane answered ${r.status} for task ${ref}`);
      return JSON.parse(r.out.toString("utf8")) as Issue;
    };
    const table = grants();
    const roles = c.roles ?? [];
    const keyOf = (id?: string | null) => (id ? String(table[id]?.key ?? "another agent") : "");
    /** Why this job may write on task `t` (post.js scopes), or undefined. */
    const scopeOf = async (t: Issue) => {
      if (t.assigneeAgentId === agent) return "own";
      if (t.createdByAgentId === agent) return "created";
      if (t.parentId && (await issue(t.parentId)).assigneeAgentId === agent) return "child";
      return undefined;
    };
    /** A comment-only write's scope where the job has no other: the grants table's tasks for it, a librarian's inboxes, the chief of staff anywhere. */
    const commentScope = (t: Issue) => {
      const own = table[agent] ?? {};
      if ([own.memory_inbox, own.review_log, own.chat_task].includes(t.id)) return "listed";
      if (roles.includes("librarian") && Object.values(table).some((g) => g.memory_inbox === t.id)) return "listed";
      return roles.includes("fleet-admin") ? "admin" : undefined;
    };
    const refuse = (t: Issue): never => {
      const who = t.assigneeAgentId ? `its assignee (${keyOf(t.assigneeAgentId)})` : "the owner";
      throw fail(403, "forbidden", `${t.identifier ?? t.id} isn't yours to change: ask ${who} or the chief of staff to pass it on`);
    };
    // The write's once-only key: an idempotency key the module sent, else this call's write itself (a retry of it is the same op).
    const opOf = (seed: string) => createHash("sha256").update(seed).digest("base64url").slice(0, 32);
    const send = async (params: Record<string, unknown>, op: string) => {
      const r = await plugin.post(agent, { ...params, ...(unknown.has(op) ? { again: true } : {}) });
      if (r.status >= 500 || !r.data) { unknown.add(op); throw fail(502, "unknown", `the post action answered ${r.status}; retry the same write`); }
      unknown.delete(op);
      if (r.status >= 300) throw fail(502, "bad_upstream", `the post action answered ${r.status}`);
      if (r.data.refused) {
        if (r.data.details) return void answer(409, Buffer.from(JSON.stringify({ error: r.data.refused, details: r.data.details })));
        throw fail(409, "refused", r.data.refused);
      }
      return r.data as { comment: string | null; child: string | null; found: boolean; status: string | null };
    };
    const issueAnswer = async (id: string, status: number, extra: Record<string, unknown> = {}) => {
      const r = await read(`/api/issues/${encodeURIComponent(id)}`);
      answer(r.status === 200 ? status : r.status, r.status === 200 ? Buffer.from(JSON.stringify({ ...JSON.parse(r.out.toString("utf8")), ...extra })) : r.out);
    };
    const tagOf = (scope: string, op: string) => (scope === "own" || scope === "admin" || scope === "listed" ? `<!-- aidenhq:job=${op} kind=cp -->` : `<!-- aidenhq:op=${op} -->`);

    // POST /api/companies/:cid/issues: a new task, as the job's agent, in its own company.
    const company = method === "POST" ? new RegExp(`^/api/companies/(${ID})/issues$`).exec(path)?.[1] : undefined;
    if (company) {
      const extra = Object.keys(b).filter((k) => !CREATE.includes(k));
      if (extra.length) throw fail(400, "bad_request", `a new task takes ${CREATE.join(", ")}; not ${extra.join(", ")}`);
      if (decodeURIComponent(company) !== (await plugin.company(agent))) throw fail(403, "forbidden", "a job creates tasks in its own company only");
      const parent = typeof b.parentId === "string" && b.parentId ? await issue(b.parentId) : undefined;
      const scope = parent ? (await scopeOf(parent)) ?? (b.assigneeAgentId === agent ? "part" : refuse(parent)) : "own";
      const op = opOf(typeof b.idempotencyKey === "string" && b.idempotencyKey ? `${agent}\n${b.idempotencyKey}` : `${c.call}\n${path}\n${JSON.stringify(b)}`);
      const child = Object.fromEntries(CREATE.slice(0, 7).filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
      const carried = await provenance.carried(agent, task);
      const d = await send({ tag: tagOf("created", op), ...(parent ? { issueId: parent.id, scope } : {}), child, delegateTo: Object.keys(table).filter((id) => UUID.test(id)) }, op);
      if (!d) return;
      provenance.record(d.child!, carried);
      return issueAnswer(d.child!, 201, { deduplicated: d.found });
    }

    // A comment, or a PATCH: on a task the job may write on.
    const ref = decodeURIComponent(/^\/api\/issues\/([^/]+)/.exec(path)![1]!);
    const t = await issue(ref);
    const comment = method === "POST" ? b.body : b.comment;
    if (method === "POST" && (typeof comment !== "string" || Object.keys(b).some((k) => k !== "body"))) throw fail(400, "bad_request", "a comment is {body}");
    const status = method === "PATCH" ? b.status : undefined;
    const patch = method === "PATCH" ? Object.fromEntries(Object.entries(b).filter(([k]) => k !== "status" && k !== "comment")) : {};
    const extra = Object.keys(patch).filter((k) => !PATCH.includes(k));
    if (extra.length) throw fail(400, "bad_request", `a task's change takes status, comment, ${PATCH.join(", ")}; not ${extra.join(", ")}`);
    const scope = (await scopeOf(t)) ?? (status === undefined && !Object.keys(patch).length ? commentScope(t) : undefined) ?? refuse(t);
    let gated = false;
    if (status === "done") {
      // The finish gate, for the job's own task only.
      if (t.id !== task) throw fail(403, "forbidden", `only this job's own task is finished here; ${t.identifier ?? t.id} is finished by its assignee`);
      if (checks) {
        const tool = String(c.tool ?? "").split(".").pop()!;
        const f = await checks.finish(t.id, { agent, tool, via: tool });
        if (!f.pass) {
          log("cp", { module: mod.module, agent: c.key, method, path, finish: "held" in f ? "held" : "reopened" });
          return answer(202, Buffer.from(JSON.stringify("held" in f ? { held: { state: f.state, reason: f.reason } } : { reopened: { reason: f.reason } })));
        }
      }
      gated = true;
    }
    const blocked = status === "blocked";
    const { blockedByIssueIds, ...rest } = patch;
    const op = opOf(`${c.call}\n${method}\n${path}\n${JSON.stringify(b)}`);
    const d = await send({
      issueId: t.id, tag: tagOf(scope, op), scope,
      ...(typeof comment === "string" && comment.trim() ? { body: comment } : {}),
      ...(status !== undefined ? { status } : {}), ...(gated ? { gated } : {}),
      ...(blocked ? { blockedBy: blockedByIssueIds ?? [] } : {}),
      ...(Object.keys(rest).length || (!blocked && blockedByIssueIds !== undefined) ? { patch: { ...rest, ...(!blocked && blockedByIssueIds !== undefined ? { blockedByIssueIds } : {}) } } : {}),
      delegateTo: Object.keys(table).filter((id) => UUID.test(id)),
    }, op);
    if (!d) return;
    if (method === "POST") return answer(201, Buffer.from(JSON.stringify({ id: d.comment, issueId: t.id })));
    return issueAnswer(t.id, 200);
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

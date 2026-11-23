// A kernel wired as main.ts wires it, against a fake control plane and module servers, in a temp dir.
import http from "node:http";
import net from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { checkJobs as compileCheckJobs } from "../../scripts/modules.ts";
import { watched } from "../src/gateway/lib.ts";
import { createAsserter, loadKey } from "../src/assert.ts";
import { createBackplane } from "../src/backplane.ts";
import { createBrake } from "../src/brake.ts";
import { createChannels } from "../src/channels.ts";
import { createNotify } from "../src/notify.ts";
import { createChecks } from "../src/checks.ts";
import { createLane } from "../src/lane.ts";
import { createOnce } from "../src/once.ts";
import { createAsCaller, createBoardCp, createCp } from "../src/cp.ts";
import { createIdentity, rolesOf } from "../src/identity.ts";
import { mintToken } from "../src/gateway/token.ts";
import { createResolver } from "../src/net.ts";
import { createHealthProbe } from "../src/health.ts";
import { createProxy } from "../src/proxy.ts";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";
import { createWork } from "../src/work.ts";
import { check as productGate } from "../../modules/platform/src/check.ts";
import { check as instanceDetailsCheck } from "../src/instance-details-check.ts";
import { KERNEL_KINDS } from "../src/kinds.ts";
import { taskRoutineCap } from "../src/tier.ts";
import { scopeOf } from "../src/task-scope.ts";
import { createProvenance } from "../src/provenance.ts";
import { createPluginPost } from "../src/outcomes.ts";
import { openFacts } from "../src/facts.ts";
import { createTaskStateRead } from "../src/task-state-read.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";
import { createWakes } from "../src/wakes.ts";
import { createIdle } from "../src/idle.ts";
import { createConnectionState } from "../src/connection-state.ts";

/** The check job recipes of the product's own modules, compiled as the kernel's modules.json carries them. */
export function recipes() {
  const out = {};
  for (const m of ["github", "ai-reviewer", "platform"]) {
    const root = join(dirname(fileURLToPath(import.meta.url)), `../../modules/${m}`);
    Object.assign(out, compileCheckJobs(m, YAML.parse(readFileSync(join(root, "module.yaml"), "utf8")), root));
  }
  return out;
}

/** A check box (checkjobs.ts CheckBox) that runs `run(o)` in process: its runs are this box's own, so another kernel's box finds
 * them gone. */
export function fakeBox(run) {
  const runs = new Map();
  let n = 0;
  return {
    async launch(o) {
      const container = `fake-${++n}`;
      const p = Promise.resolve().then(() => run(o));
      p.catch(() => {});
      runs.set(container, p);
      return { container, pid: 0, log: "", deadline: 0, at: Date.now() };
    },
    async follow(h) { return runs.has(h.container) ? runs.get(h.container) : "gone"; },
  };
}
export const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
/** A raw GET with a request target `fetch` would refuse to send: the status line's code. */
export const rawStatus = (url, target) => new Promise((r) => { const u = new URL(url); const c = net.connect(+u.port, u.hostname, () => c.write(`GET ${target} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`)); let d = ""; c.on("data", (x) => (d += x)).on("close", () => r(+d.split(" ")[1])); });
export const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });

/**
 * agents: { alias: {id, name, task?} }: each alias stands for a running kernel job of that agent on its task (TASK-1 by default; its authority frozen from
 * its grants); `call`, `v1` and `token(alias)` turn the alias into the job's real token. grants: the grants table's agents; connections(urls): config/kernel/connections.json from the fake servers' URLs.
 */
export async function kernel(t, { agents = {}, grants = {}, settings = {}, connections, jobcaps = {}, secrets = {}, onControl, writes: kinds = {}, closed = [], modules = {}, board = async () => ({ status: 404, json: {} }), reviewer, native = {}, parents = {}, issues = {}, repos = {}, jobs: jobsApi, admission, outcomes, checks: checkTable, checkResolver, checkJobs, localChanges, paths, job, routing, graderToken = () => "", connect = false, projects } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kernel-"));
  const control = [];
  const cpServer = await serve(async (req, res) => {
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const body = await readBody(req);
    control.push({ method: req.method, url: req.url, auth, body });
    if (onControl) { const out = await onControl(req, body, auth); if (out) return res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.body)); }
    // Tasks the tests declare (issues[id], read as the kernel reads one for a conn.tool call's named task).
    const asked = /^\/api\/issues\/([^/?]+)/.exec(req.url ?? "");
    if (asked && issues[decodeURIComponent(asked[1])]) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(issues[decodeURIComponent(asked[1])]));
    // The kernel's own read of a task (its routine cap): the task, with no origin.
    if (auth === "board-key" && req.method === "GET" && /^\/api\/issues\/[^/]+$/.test(req.url)) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: decodeURIComponent(req.url.split("/")[3]) }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, url: req.url, as: auth }));
  });
  const conns = connections ?? {};
  writeFileSync(join(dir, "connections.json"), JSON.stringify(conns));
  writeFileSync(join(dir, "jobcaps.json"), JSON.stringify(jobcaps));
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ ...settings, agents: grants }));
  writeFileSync(join(dir, "writes.json"), JSON.stringify(kinds));
  writeFileSync(join(dir, "modules.json"), JSON.stringify(modules));
  const allSecrets = { gateway_job_secret: "job-secret", gateway_lane_secret: "lane-secret", paperclip_board_key: "board-key", gateway_board_key: "the-boards-key", reviewer_key: "the-reviewer-key", health_probe_key: "the-health-key", ...secrets };
  const secret = (n) => allSecrets[n] ?? "";
  // Each alias in `agents`: a running kernel job of its agent, its token minted as the kernel mints one (boxes.ts).
  const aliased = new Map(), tokens = {};
  for (const [alias, a] of Object.entries(agents)) {
    const id = `job-${alias}`, g = grants[a.id] ?? {};
    const task = a.task ?? "TASK-1";
    aliased.set(id, { agent: a.id, task, state: "running", identifier: a.identifier ?? task, authority: { tools: g.tools ?? {}, jobcaps: [], writes: [], roles: rolesOf(g) } });
    tokens[alias] = mintToken(allSecrets.gateway_job_secret, { kind: "job", job: id, agentId: a.id, issueId: task });
  }
  const token = (alias) => tokens[alias] ?? alias;
  const log = [];
  const logf = (msg, fields) => log.push({ msg, ...fields });
  const grantsTable = watched(join(dir, "grants.json"), (j) => j, {});
  const connectionsTable = watched(join(dir, "connections.json"), (j) => j, {});
  const modulesFile = watched(join(dir, "modules.json"), (j) => j, {});
  const whoami = createIdentity({ grants: () => grantsTable().agents ?? {}, connections: connectionsTable, modules: () => modulesFile().modules ?? {}, jobcaps: watched(join(dir, "jobcaps.json"), (j) => j, {}), secret, job: (id) => job?.(id) ?? aliased.get(id) });
  const asserter = createAsserter(loadKey(join(dir, "caller-key.pem")));
  // Records (kernel.db) and the write lifecycle, as main.ts wires them; notices on onTask are kept in `notices`.
  const notices = [];
  const records = openRecords(join(dir, "kernel.db"));
  let replay;
  const moduleKinds = watched(join(dir, "writes.json"), (j) => j, {});
  // The bound reviewer: `reviewer(request)` answers each review as the module would (its verdict); every request is kept.
  const reviewed = [];
  const reviews = { request: async (request) => { reviewed.push(request); if (!reviewer) throw new Error("no reviewer module is installed"); return reviewer(request); } };
  // The control plane as main.ts reads it for a task's routine cap (a fetch that isn't ok throws).
  const cpJson = async (p) => { const r = await fetch(new URL(p, cpServer.url), { headers: { authorization: "Bearer board-key" } }); if (!r.ok) throw Object.assign(new Error(`${p} → ${r.status}`), { status: r.status }); return r.json(); };
  const provenance = createProvenance({ db: records.db, cap: (task) => taskRoutineCap(cpTrace, task, grantsTable().routines) });
  const cpTrace = { issue: (id) => cpJson(`/api/issues/${encodeURIComponent(id)}`), provenance: provenance.trace };
  // `checks` is the finish gate's table and the write.filed checks' too; the platform check's code runs in process, as main.ts wires it.
  const writes = createWrites({ records, registry: () => ({ ...moduleKinds(), ...KERNEL_KINDS }), connections: connectionsTable, secret, resolver: createResolver(), log: logf, replay: (r) => replay(r), reviews, native, repos: () => repos, paths: () => paths,
    checks: typeof checkTable === "function" ? checkTable : () => checkTable ?? {}, filedChecks: { "platform.product-gate": productGate, "code-review.instance-details": instanceDetailsCheck },
    autonomy: () => grantsTable().autonomy ?? "full", onTask: { open: async (task) => !closed.includes(task), notify: async (task, text, o) => { const to = o?.parent ? parents[task] : task; if (to && !closed.includes(to)) notices.push({ task: to, text }); },
      scope: async (task, agent) => { const i = issues[task]; if (!i) return undefined; const read = async (ref) => issues[ref]; return { id: i.id ?? task, identifier: i.identifier, scope: await scopeOf(i, agent, read) }; },
      routineCap: (task) => taskRoutineCap(cpTrace, task, grantsTable().routines) } });
  // `connect`: connect on first use wired as main.ts wires it (facts, the wake inbox, waits, the connection state).
  let connectionState;
  const proxy = createProxy({ whoami, connections: connectionsTable, asserter, resolver: createResolver(), secret, writes, needs: () => connectionState, log: logf });
  replay = proxy.replay;
  // The control plane as the owner (board key) and the board's internal listener (a fake: `board(method, path, body)`).
  const owner = async (method, path, body) => { const r = await fetch(new URL(path, cpServer.url), { method, headers: { authorization: "Bearer board-key", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const boardCalls = [];
  const boardApi = async (method, path, body) => (boardCalls.push({ method, path, body }), board(method, path, body));
  const channels = createChannels({ db: records.db, records, writes, board: boardApi, owner, modules: modulesFile, log: logf });
  const brake = createBrake({ db: records.db, owner });
  // The finish gate (checks.ts) over `checks`, config/kernel/checks.json's shape.
  // `checks` is the table, or a function (to stand for a file that fails to load).
  const checks = checkTable ? createChecks({ db: records.db, registry: typeof checkTable === "function" ? checkTable : () => checkTable, owner, secret, resolver: checkResolver ?? createResolver(), log: logf, agentKey: (id) => grants[id]?.key, graded: (id) => grants[id]?.graded === true, pending: (task) => records.list(["review", "owner", "approved"], 100, { task }), ...(localChanges ? { localChanges } : {}) }) : undefined;
  // The fast lane's exchanges; agent posts (outcomes.ts's, once per job) are kept in `agentPosts`.
  const agentPosts = [];
  const lane = createLane({ once: createOnce(records.db), owner, grantsFile: grantsTable, postAsAgent: async (agent, task, job, body) => {
    const i = agentPosts.findIndex((p) => p.job === job);
    return { id: `ac-${(i >= 0 ? i : agentPosts.push({ agent, task, job, body }) - 1) + 1}` };
  } });
  const notify = createNotify({ db: records.db, modules: modulesFile, secret, resolver: createResolver(), testHosts: true });
  let taskStates, wakes;
  if (connect) {
    const facts = openFacts(records.db);
    taskStates = createTaskStateRead({ file: join(dir, "kernel.db"), stages: () => KERNEL_STAGES });
    wakes = createWakes({ db: records.db, facts, owner, post: async () => ({}), dispatches: { may: () => true, agents: () => Object.keys(grantsTable().agents ?? {}) } });
    const idle = createIdle({ db: records.db, facts, state: taskStates, wakes, owner, log: logf });
    const issue = async (id) => { const r = await owner("GET", `/api/issues/${encodeURIComponent(id)}`); return r.status === 200 && r.json?.id ? r.json : undefined; };
    connectionState = createConnectionState({ db: records.db, idle, wakes, queue: notify.queue, log: logf, issue,
      comments: async (id) => { const r = await owner("GET", `/api/issues/${encodeURIComponent(id)}/comments?order=desc&limit=50`); return Array.isArray(r.json) ? r.json : []; },
      agentName: async () => "Aiden", label: (m) => m.charAt(0).toUpperCase() + m.slice(1), connections: connectionsTable, grants: () => grantsTable().agents ?? {}, boardUrl: () => "http://board.example" });
  }
  const healthProbe = createHealthProbe({ grants: () => grantsTable().agents ?? {}, connections: connectionsTable, kindOf: writes.kindOf, callAs: proxy.callAs, log: logf });
  const work = createWork({ db: records.db, records });
  const backplane = createBackplane({ connectionState, routing, work, graderToken, healthProbe, healthKey: () => secret("health_probe_key"), checks, checkJobs, lane, whoami, asserter, grantsFile: grantsTable, log: logf, writes, records, channels, brake, notify, owner, ownerRaw: (p) => fetch(new URL(p, cpServer.url), { headers: { authorization: "Bearer board-key" } }), modules: modulesFile, boardKey: () => secret("gateway_board_key"), reviewerKey: () => secret("reviewer_key"), reviews, jobs: jobsApi, admission, outcomes, proxy: (req, res, c) => proxy(req, res, c), cp: createCp({ projects, whoami, asserter, once: createOnce(records.db), plugin: createPluginPost({ controlUrl: cpServer.url, agentKey: (id) => secret(`paperclip-agents/${id}`), postKey: () => secret("paperclip_post_key") }), agentKey: (id) => secret(`paperclip-agents/${id}`), grants: () => grantsTable().agents ?? {}, fleetIssues: () => String(grantsTable().fleet_issues ?? ""), controlUrl: cpServer.url, checks, provenance, log: logf }), boardCp: createBoardCp({ controlUrl: cpServer.url, key: () => secret("paperclip_board_key"), log: logf }) });
  const asCaller = createAsCaller({ whoami, connections: connectionsTable, asserter, log: logf });
  const bp = await serve(backplane);
  t.after(() => { for (const s of [cpServer, bp]) { s.s.closeAllConnections?.(); s.s.close(); } });
  /** One JSON-RPC message to /c/<connection>/mcp on the backplane. */
  const call = (connection, token, body, { accept = "application/json, text/event-stream", headers = {} } = {}) => fetch(`${bp.url}/c/${connection}/mcp`, {
    method: "POST", headers: { ...(token ? { authorization: `Bearer ${tokens[token] ?? token}` } : {}), "content-type": "application/json", accept, ...headers }, body: typeof body === "string" ? body : JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  /** The backplane's /v1/writes routes, with a bearer (the board's key by default). */
  const v1 = (method, path, body, token = "the-boards-key") => fetch(`${bp.url}${path}`, { method, headers: { authorization: `Bearer ${tokens[token] ?? token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  return { connectionState, taskStates, wakes, token, dir, url: bp.url, call, control, agentPosts, log, asserter, provenance, asCaller, jwks: asserter.jwks, records, writes, notices, v1, boardCalls, reviewed, channels, grantsFile: join(dir, "grants.json") };
}

/** A module's MCP server: answers tools/list with `tools` and tools/call with `answer(msg, req)`; records what it saw. */
export async function moduleServer(t, { key, tools = [], answer, sse = false } = {}) {
  const seen = [];
  const m = await serve(async (req, res) => {
    const raw = await readBody(req);
    const msg = raw ? JSON.parse(raw) : {};
    seen.push({ auth: req.headers.authorization, caller: req.headers["x-aidenhq-caller"], agentKey: req.headers["x-agent-key"], method: msg.method, name: msg.params?.name, raw, headers: req.headers });
    if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end();
    const result = msg.method === "tools/list" ? { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) } : msg.method === "tools/call" ? await (answer?.(msg, req) ?? { content: [{ type: "text", text: "done" }] }) : {};
    const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    if (sse) { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(`event: message\ndata: ${out}\n\n`); }
    res.writeHead(200, { "content-type": "application/json" }).end(out);
  });
  t.after(() => { m.s.closeAllConnections?.(); m.s.close(); });
  return { ...m, seen };
}

/**
 * Paperclip's plugin host for the paperclip-events `post` action, in memory: `issues` by id (each with companyId), comments,
 * and every write as the agent the action names (createdByAgentId, authorAgentId).
 */
export function pluginHost(issues) {
  const comments = [];
  let n = 0;
  const ctx = { issues: {
    get: async (id, c) => (issues[id]?.companyId === c ? issues[id] : null),
    update: async (id, patch, _c, actor) => Object.assign(issues[id], patch.blockedByIssueIds ? { blockedBy: patch.blockedByIssueIds } : {}, patch, { updatedBy: actor.actorAgentId }),
    list: async ({ originId }) => Object.values(issues).filter((i) => i.originId === originId),
    create: async ({ companyId, actor, ...f }) => { const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; return (issues[id] = { id, identifier: `NEW-${n}`, ...f, createdByAgentId: actor.actorAgentId, companyId }); },
    listComments: async (id) => comments.filter((c) => c.issueId === id),
    createComment: async (issueId, body, _c, { authorAgentId }) => { const c = { id: `cm-${++n}`, issueId, body, authorAgentId }; comments.push(c); return c; },
  } };
  return { ctx, issues, comments };
}

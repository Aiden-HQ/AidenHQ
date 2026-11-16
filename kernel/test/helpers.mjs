// A kernel wired as main.ts wires it, against a fake control plane, launcher and module servers, in a temp dir.
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, watched } from "../src/gateway/lib.ts";
import { createAsserter, loadKey } from "../src/assert.ts";
import { createBackplane } from "../src/backplane.ts";
import { createBrake } from "../src/brake.ts";
import { createChannels } from "../src/channels.ts";
import { createAsCaller, createCp } from "../src/cp.ts";
import { createIdentity } from "../src/identity.ts";
import { createResolver } from "../src/net.ts";
import { createProxy } from "../src/proxy.ts";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";

export const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
export const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });

/**
 * agents: { token: {id, name} } the control plane knows; boxes: { ahqc_token: {agentId, runId, issueId} } the launcher knows;
 * grants: the grants table's agents; connections(urls): config/kernel/connections.json from the fake servers' URLs.
 */
export async function kernel(t, { agents = {}, boxes = {}, grants = {}, settings = {}, connections, jobcaps = {}, secrets = {}, onControl, writes: kinds = {}, closed = [], modules = {}, board = async () => ({ status: 404, json: {} }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kernel-"));
  const control = [];
  const cpServer = await serve(async (req, res) => {
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const body = await readBody(req);
    control.push({ method: req.method, url: req.url, auth, body });
    if (onControl) { const out = await onControl(req, body, auth); if (out) return res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.body)); }
    if (req.url === "/api/agents/me") { const a = agents[auth]; return a ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(a)) : res.writeHead(401).end(); }
    if (req.url.startsWith("/api/heartbeat-runs/")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issueId: "TASK-1" }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, url: req.url, as: auth }));
  });
  const launcher = await serve((req, res) => {
    const b = boxes[String(req.headers.authorization ?? "").replace(/^Bearer /, "")];
    if (req.url === "/whoami") return b ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b)) : res.writeHead(401).end();
    res.writeHead(404).end();
  });
  const conns = connections ?? {};
  writeFileSync(join(dir, "connections.json"), JSON.stringify(conns));
  writeFileSync(join(dir, "jobcaps.json"), JSON.stringify(jobcaps));
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ ...settings, agents: grants }));
  writeFileSync(join(dir, "writes.json"), JSON.stringify(kinds));
  writeFileSync(join(dir, "modules.json"), JSON.stringify(modules));
  const allSecrets = { gateway_job_secret: "job-secret", gateway_lane_secret: "lane-secret", gateway_harness_key: "harness-key", paperclip_board_key: "board-key", gateway_board_key: "the-boards-key", ...secrets };
  const secret = (n) => allSecrets[n] ?? "";
  const log = [];
  const logf = (msg, fields) => log.push({ msg, ...fields });
  const grantsTable = watched(join(dir, "grants.json"), (j) => j, {});
  const connectionsTable = watched(join(dir, "connections.json"), (j) => j, {});
  const modulesFile = watched(join(dir, "modules.json"), (j) => j, {});
  const whoami = createIdentity({ grants: () => grantsTable().agents ?? {}, connections: connectionsTable, modules: () => modulesFile().modules ?? {}, jobcaps: watched(join(dir, "jobcaps.json"), (j) => j, {}), secret, controlUrl: cpServer.url, launcherUrl: launcher.url, runTask: async () => "TASK-1" });
  const asserter = createAsserter(loadKey(join(dir, "caller-key.pem")));
  // Records (kernel.db) and the write lifecycle, as main.ts wires them; notices on onTask are kept in `notices`.
  const notices = [];
  const records = openRecords(join(dir, "kernel.db"));
  let replay;
  const writes = createWrites({ records, registry: watched(join(dir, "writes.json"), (j) => j, {}), connections: connectionsTable, secret, resolver: createResolver(), log: logf, replay: (r) => replay(r),
    autonomy: () => grantsTable().autonomy ?? "full", onTask: { open: async (task) => !closed.includes(task), notify: async (task, text) => void notices.push({ task, text }) } });
  const proxy = createProxy({ whoami, connections: connectionsTable, asserter, resolver: createResolver(), secret, writes, log: logf });
  replay = proxy.replay;
  // The control plane as the owner (board key) and the board's internal listener (a fake: `board(method, path, body)`).
  const owner = async (method, path, body) => { const r = await fetch(new URL(path, cpServer.url), { method, headers: { authorization: "Bearer board-key", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const boardCalls = [];
  const boardApi = async (method, path, body) => (boardCalls.push({ method, path, body }), board(method, path, body));
  const channels = createChannels({ db: records.db, writes, board: boardApi, owner, modules: modulesFile, log: logf });
  const brake = createBrake({ db: records.db, owner, on: () => grantsTable().loop_brake !== "off" });
  const backplane = createBackplane({ whoami, asserter, grantsFile: grantsTable, log: logf, writes, records, channels, brake, owner, modules: modulesFile, boardKey: () => secret("gateway_board_key"), proxy: (req, res, c) => proxy(req, res, c), cp: createCp({ whoami, asserter, controlUrl: cpServer.url, launcherUrl: launcher.url, log: logf }) });
  const asCaller = createAsCaller({ whoami, connections: connectionsTable, asserter, log: logf });
  const gw = createGateway({ asCaller, dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), tools: proxy, secret });
  const bp = await serve(backplane);
  const jobs = await serve((req, res) => gw.handle(req, res));
  t.after(() => { for (const s of [cpServer, launcher, bp, jobs]) s.s.close(); gw.close(); });
  /** One JSON-RPC message to /c/<connection>/mcp on the backplane (or the job listener). */
  const call = (connection, token, body, { jobsListener = false, accept = "application/json, text/event-stream", headers = {} } = {}) => fetch(`${(jobsListener ? jobs : bp).url}/c/${connection}/mcp`, {
    method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept, ...headers }, body: typeof body === "string" ? body : JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  /** The backplane's /v1/writes routes, with a bearer (the board's key by default). */
  const v1 = (method, path, body, token = "the-boards-key") => fetch(`${bp.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  return { dir, url: bp.url, jobsUrl: jobs.url, call, control, log, asserter, asCaller, jwks: asserter.jwks, records, writes, notices, v1, boardCalls };
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
  t.after(() => m.s.close());
  return { ...m, seen };
}

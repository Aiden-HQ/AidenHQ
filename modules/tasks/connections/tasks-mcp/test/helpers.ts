// A fake kernel (keys, directory, /v1/cp/agent/* forwarded to a fake Paperclip) in front of the real tasks server. One fake
// "front" server stands in for Paperclip, the board, apps-mcp and the gateway; each test gives it its own handler.
import { createServer } from "node:http";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIRECTORY = ["key", "roles", "description", "delegate_to", "review_log", "graded", "feedback_for", "profile"];
const SERVICE_KEY = "tasks-service-key";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** The capabilities catalog fleet_catalog reads (a test writes it). */
export const catalogFile = join(tmpdir(), `tasks-mcp-catalog-${process.pid}.json`);

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok(s)); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const read = async (req) => { let b = ""; for await (const c of req) b += c; return b; };

let current = { handler: () => {}, board: undefined, directory: { agents: {} }, states: {}, repos: undefined };
/** Requests the kernel forwarded to the control plane, with the assertion and module key they came with. */
export const cpSeen = [];
/** Waits the tasks server asked the kernel to record (POST /v1/wait), for a bridge made with `acceptWaits`; else /v1/wait is a 404. */
export const waits = [];
/** Memory calls the tasks server forwarded to the kernel (POST /v1/memory/<op>), with the key and assertion they came with. */
export const memorySeen = [];
/** Batch reads the tasks server forwarded to the kernel (GET /v1/events/batch/<id>). */
export const eventsSeen = [];

const front = await listen(async (req, res) => {
  const u = req.url ?? "";
  if ((u.startsWith("/internal/") && u !== "/internal/apps") || u === "/grades") {
    if (current.board) return current.board(req, res);
    await read(req);
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(/\/gate$/.test(u) ? { pass: true } : {}));
  }
  return current.handler(req, res);
});
const kernel = await listen(async (req, res) => {
  const u = req.url ?? "";
  const send = (status, x) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(x));
  if (u === "/v1/jwks") return send(200, jwks);
  const moduleKey = req.headers.authorization === `Bearer ${SERVICE_KEY}`;
  if (u === "/v1/agents") {
    if (!moduleKey) return send(401, {});
    const agents = Object.fromEntries(Object.entries(current.directory.agents).map(([id, g]) => [id, Object.fromEntries(DIRECTORY.filter((k) => g[k] !== undefined).map((k) => [k, g[k]]))]));
    return send(200, { agents, ...(current.repos ? { repos: current.repos } : {}) });
  }
  if (u.startsWith("/v1/tasks/state?ids=")) {
    if (!moduleKey) return send(401, {});
    const ids = decodeURIComponent(u.split("ids=")[1]).split(",");
    return send(200, { as_of: new Date().toISOString(), tasks: ids.filter((id) => current.states[id]).map((id) => ({ task: id, ...current.states[id] })), counts: { needs_you: 0, failed: 0, unexplained_idle: 0 } });
  }
  if (u === "/v1/wait" && req.method === "POST" && current.acceptWaits) {
    waits.push(JSON.parse(await read(req)));
    return send(200, { waiting: true });
  }
  if (u.startsWith("/v1/memory/") && req.method === "POST") {
    memorySeen.push({ op: u.slice("/v1/memory/".length), moduleKey, caller: req.headers["x-aidenhq-caller"], body: JSON.parse(await read(req)) });
    return send(200, { line: "- (2026-11-23, src: WOR-12) noted" });
  }
  if (u.startsWith("/v1/events/batch/") && req.method === "GET") {
    eventsSeen.push({ path: u, moduleKey, caller: req.headers["x-aidenhq-caller"] });
    return send(200, { count: 1, events: [{ resource: "C1", id: "e1", kind: "message", text: "hello" }] });
  }
  if (u.startsWith("/v1/cp/agent/")) {
    if (!moduleKey || !req.headers["x-aidenhq-caller"]) return send(401, {});
    const path = u.slice("/v1/cp/agent".length);
    cpSeen.push({ method: req.method, path, caller: req.headers["x-aidenhq-caller"] });
    const body = await read(req);
    const r = await fetch(`${url(front)}${path}`, { method: req.method, headers: { authorization: "Bearer run-credential", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) });
    let out = Buffer.from(await r.arrayBuffer());
    // The fakes predate companies: an agent without one is in company "co".
    if (path === "/api/agents/me" && r.ok) { const me = JSON.parse(out.toString()); out = Buffer.from(JSON.stringify({ companyId: "co", ...me })); }
    return res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(out);
  }
  send(404, {});
});

Object.assign(process.env, { AIDENHQ_KERNEL_URL: url(kernel), MCP_TOKEN: SERVICE_KEY, AIDENHQ_BOARD_TOKEN: "board-token", AIDENHQ_BOARD_URL: url(front), GRADING_URL: url(front), APPS_MCP_URL: url(front), AIDENHQ_GATEWAY_URL: url(front), AIDENHQ_MODULE: "tasks", AIDENHQ_CATALOG_FILE: catalogFile });
const { server } = await import("../src/main.ts");
const { forget } = await import("../src/tools.ts");
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const mcp = `http://127.0.0.1:${server.address().port}/mcp`;
// The servers never hold the test process open.
for (const s of [front, kernel, server]) s.unref();
export const frontUrl = url(front);

/** A caller assertion as the kernel signs it. */
export function assertion({ agent = "me", key = "", name = "", roles = [], task, run, aud = "tasks", exp = Math.floor(Date.now() / 1000) + 60 } = {}) {
  const body = `${b64({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${b64({ iss: "aidenhq-kernel", agent, key, name, roles, ...(task ? { task } : {}), ...(run ? { run } : {}), tool: "paperclip_tasks.x", kind: "run", aud, jti: randomUUID(), exp })}`;
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
}

/** One JSON-RPC message to the server; resolves with the parsed reply. */
export async function rpc(msg, headers = {}) {
  const r = await fetch(mcp, { method: "POST", headers: { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...msg }) });
  return { status: r.status, json: r.status === 202 ? undefined : await r.json() };
}

/**
 * The tasks server for one agent: `handler` is the fake Paperclip (and apps-mcp, gateway), `board` the fake board (default:
 * every gate passes), `agents` the grants table the directory comes from, `states` the kernel's task state rows by task id, `agent` the caller (its key and roles from
 * `agents`), `task`/`run` what the kernel knows of its run. call(name, args) resolves with the JSON-RPC reply ({ result }).
 */
export function bridge({ handler, board, agents = {}, agent = "me", task, run, states = {}, repos, acceptWaits = false }) {
  current = { handler, board, directory: { agents }, states, repos, acceptWaits };
  forget();
  const g = agents[agent] ?? {};
  const caller = { agent, key: g.key ?? agent, roles: [...(g.roles ?? [])], task, run };
  const call = async (name, args, as = caller) => (await rpc({ method: "tools/call", params: { name, arguments: args } }, { "x-aidenhq-caller": assertion(as) })).json;
  return { call, caller };
}

/** call()'s result as { error } or { out } (the tool's JSON). */
export const parse = (m) => (m.result.isError ? { error: m.result.content[0].text } : { out: JSON.parse(m.result.content[0].text) });

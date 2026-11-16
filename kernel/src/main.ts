#!/usr/bin/env node
// The kernel host service, systemd user unit aidenhq-kernel (ops/units/aidenhq-kernel.service).
// - The model gateway (gateway/lib.ts; CI credentials gateway/ci.ts): the only holder of the model key (read from the vault at
//   each call), on host loopback and the backplane's gateway address (8201), and with CI on, on the CI runners' bridge. Runner
//   jobs' tool calls (their jobcaps) come in on 8201 too, the one port their jail reaches. Fails closed: if it is down, no
//   model or tool call is made.
// - The backplane listener (10.231.0.1:3130, backplane.ts): the tool proxy in front of every connection, caller identity
//   and assertions, the control plane as the calling agent, and the records of every write (writes.ts, kernel.db).
// - The admin listener (127.0.0.1:3120, admin.ts): admins' sign-in (accounts.ts, data/kernel/auth/) and the approval pages.
import http from "node:http";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDir, dataDir, env, secret } from "./env.ts";
import { createGateway, watched } from "./gateway/lib.ts";
import { createAdmin } from "./admin.ts";
import { createAsserter, loadKey } from "./assert.ts";
import { createBackplane } from "./backplane.ts";
import { createBrake } from "./brake.ts";
import { createChannels, type Api, type ModulesFile } from "./channels.ts";
import { createAsCaller, createCp } from "./cp.ts";
import { createIdentity, type Connection, type Grant, type Jobcap } from "./identity.ts";
import { createResolver } from "./net.ts";
import { createProxy } from "./proxy.ts";
import { openRecords } from "./records.ts";
import { createWrites, type Kind } from "./writes.ts";

const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(fields));

const controlUrl = env("PAPERCLIP_URL", "http://127.0.0.1:3100");
const launcherUrl = env("AIDENHQ_LAUNCHER_URL", "http://10.231.0.1:8199"); // names agent computers' run tokens (/whoami)
const grantsFile = path.join(configDir, "grants", "grants.json");
const grantsTable = watched(grantsFile, (j) => j as { agents?: Record<string, Grant> } & Record<string, unknown>, {});
const connections = watched(path.join(configDir, "kernel", "connections.json"), (j) => j as Record<string, Connection>, {});
// The control plane with the board key (only the kernel holds it): the task a run is on (its run record), and a record's task.
const cpApi = (p: string, init: RequestInit = {}) => fetch(new URL(p, controlUrl), { ...init, headers: { authorization: `Bearer ${secret("paperclip_board_key")}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
async function runTask(runId: string): Promise<string | undefined> {
  const res = await cpApi(`/api/heartbeat-runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return undefined;
  const r = (await res.json()) as { issueId?: string; contextSnapshot?: { issueId?: string } };
  return r.issueId ?? r.contextSnapshot?.issueId ?? undefined;
}
// Modules with kernel roles, a privileged entry, a token of their own or a channel (compile).
const modulesFile = watched(path.join(configDir, "kernel", "modules.json"), (j) => j as ModulesFile, {});
const whoami = createIdentity({
  grants: () => grantsTable().agents ?? {}, connections, modules: () => modulesFile().modules ?? {},
  jobcaps: watched(path.join(configDir, "jobcaps.json"), (j) => j as Record<string, Jobcap>, {}), // runner jobs' reads (compile)
  secret, controlUrl, launcherUrl, runTask,
});
const asserter = createAsserter(loadKey(path.join(dataDir, "kernel", "caller-key.pem")));
const resolver = createResolver({ project: env("COMPOSE_PROJECT_NAME", "aidenhq") });
// A record's task: still open, and the notices on it (written with the board key, as the board's approval notices are).
const onTask = {
  open: async (task: string) => { const r = await cpApi(`/api/issues/${encodeURIComponent(task)}`); return r.ok && !["done", "cancelled"].includes(String(((await r.json()) as { status?: string }).status)); },
  notify: async (task: string, body: string) => { const r = await cpApi(`/api/issues/${encodeURIComponent(task)}/comments`, { method: "POST", body: JSON.stringify({ body }) }); if (!r.ok) log("notice failed", { task, status: r.status }); },
};
const records = openRecords(path.join(dataDir, "kernel", "kernel.db"));
const registry = watched(path.join(configDir, "kernel", "writes.json"), (j) => j as Record<string, Kind>, {});
let replay: (r: never) => Promise<{ ok: boolean; text: string }> = async () => ({ ok: false, text: "the proxy isn't up" });
const writes = createWrites({ records, registry, connections, secret, resolver, onTask, log, replay: (r) => replay(r as never), autonomy: () => (["off", "tier0", "full"].includes(grantsTable().autonomy as string) ? grantsTable().autonomy : "off") as never });
const proxy = createProxy({ whoami, connections, asserter, resolver, secret, writes, log });
replay = proxy.replay as never;
// JSON both ways: the control plane as the owner (only the kernel holds the board key), and the board's internal listener with
// the kernel's key (gateway_board_key; the runner's cards stay there until 3b).
const asApi = (call: (p: string, init: RequestInit) => Promise<Response>): Api => async (method, p, body) => {
  const r = await call(p, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ownerApi = asApi(cpApi);
const boardApi = asApi((p, init) => fetch(new URL(p, env("BOARD_INTERNAL_URL", "http://127.0.0.1:3122")), { ...init, headers: { authorization: `Bearer ${secret("board_internal_token")}`, "x-gateway-key": secret("gateway_board_key"), "content-type": "application/json" }, signal: AbortSignal.timeout(20_000) }));
const channels = createChannels({ db: records.db, writes, board: boardApi, owner: ownerApi, modules: modulesFile, log });
const brake = createBrake({ db: records.db, owner: ownerApi, on: () => grantsTable().loop_brake !== "off" });
const backplane = createBackplane({ whoami, asserter, grantsFile: grantsTable, log, writes, records, channels, brake, owner: ownerApi, modules: modulesFile, boardKey: () => secret("gateway_board_key"), proxy: (req, res, c) => proxy(req, res, c!), cp: createCp({ whoami, asserter, controlUrl, launcherUrl, log }) as never });
// The admin listener's accounts (data/kernel/auth/auth.db). Not moved yet (the board still holds them): the listener refuses
// while every other part of the kernel serves.
const adminUrl = env("AIDENHQ_ADMIN_URL", "");
// The front door's name with and without its port (proxies differ in the Host they pass on).
const adminHosts = [...env("AIDENHQ_ADMIN_HOSTS", "localhost:3120,127.0.0.1:3120").split(","), ...(adminUrl ? [new URL(adminUrl).host, new URL(adminUrl).hostname] : [])].map((h) => h.trim().toLowerCase()).filter(Boolean);
const accounts = await import("./accounts.ts").then((a) => a.openAccounts({ dataDir, hosts: adminHosts, origins: adminUrl ? [new URL(adminUrl).origin] : [], edgeSecret: () => secret("edge_board_secret"), notify: (line) => channels.ownerLine(line), log: { info: (o, m) => log(m, o as never), warn: (o, m) => log(m, o as never), error: (o, m) => log(m, o as never) } }))
  .catch((e: Error) => (log("accounts off", { err: e.message }), undefined));
const boardOrigins = env("AIDENHQ_BOARD_ORIGINS", env("BOARD_LAN_URL", "") ? new URL(env("BOARD_LAN_URL", "")).origin : "").split(",").map((o) => o.trim()).filter(Boolean);
const admin = accounts && createAdmin({ accounts, cards: channels, ownerMessage: (b) => channels.ownerMessageAs("web", b, () => Object.entries(grantsTable().agents ?? {}).find(([, g]) => g.key === "chief-of-staff")?.[0]), owner: ownerApi, hosts: () => adminHosts, origin: () => (adminUrl ? new URL(adminUrl).origin : ""), frameOrigins: () => boardOrigins, log });

// Claimed records a restart left without an outcome: their executors say how they went (never replayed). Executors may
// still be starting at boot, so once, a minute in.
setTimeout(() => void writes.reconcile().then((u) => u.length && log("records left unknown", { records: u }), (e: Error) => log("reconcile failed", { err: e.message })), 60_000).unref();

const gw = createGateway({
  dbFile: path.join(dataDir, "gateway", "usage.db"),
  grantsFile,
  settingsFile: path.join(configDir, "gateway.json"),
  tools: proxy, // runner jobs' reads of connections (POST /c/<connection>/mcp, job tokens only)
  asCaller: createAsCaller({ whoami, connections, asserter, log }), // a module's model calls for its caller (cp.ts)
  secret,
  upstream: env("AIDENHQ_GATEWAY_UPSTREAM", "https://openrouter.ai/api/v1"),
  paperclipUrl: controlUrl,
  boardUrl: env("BOARD_INTERNAL_URL", "http://127.0.0.1:3122"),
  launcherUrl,
  log,
});

// host:port pairs. Each binds on its own: the backplane address exists only once compose is up, so a failed bind is retried
// (backoff up to a minute) while the others keep serving.
function listen(addr: string, ci = false, handler: http.RequestListener = (req, res) => gw.handle(req, res, { ci })) {
  const i = addr.lastIndexOf(":");
  const server = http.createServer(handler);
  // A model stream can run for many minutes (requestTimeout covers receiving the request, not the answer). The CI listener
  // faces jobs that run untrusted code: a request must arrive within a minute, and few connections at once.
  server.requestTimeout = ci ? 60_000 : 0;
  if (ci) server.maxConnections = 32;
  let wait = 1000;
  const bind = () => server.listen(Number(addr.slice(i + 1)), addr.slice(0, i));
  server.on("listening", () => { wait = 1000; log("listening", { addr }); });
  server.on("error", (e) => {
    log("listen failed; retrying", { addr, err: e.message, inMs: wait });
    setTimeout(bind, wait);
    wait = Math.min(wait * 2, 60_000);
  });
  bind();
}
for (const addr of env("AIDENHQ_GATEWAY_LISTEN", "127.0.0.1:8201,10.231.0.1:8201").split(",").map((s) => s.trim()).filter(Boolean)) listen(addr);
// The backplane listener: containers on the backplane reach it (Codex in the control plane, modules); jobs never do.
listen(env("AIDENHQ_KERNEL_BACKPLANE", "10.231.0.1:3130"), false, backplane);

// The admin listener: loopback only; the front door reaches it there.
listen(env("AIDENHQ_KERNEL_ADMIN", "127.0.0.1:3120"), false, admin ?? ((_req, res) => void res.writeHead(503, { "content-type": "text/plain" }).end("accounts are off: see the kernel's log")));

// The CI listener, on the CI runners' bridge address (modules/ci; ops/units/aidenhq-ci-net.service lets that bridge reach this
// port only): CI routes and CI tokens only (lib.ts). Bound once config/gateway.json turns CI on (checked every minute, so
// an apply that enables the ci module needs no restart); a host without the CI network never tries.
const ciAddr = env("AIDENHQ_GATEWAY_CI_LISTEN", "10.231.4.1:8201");
let ciBound = false;
const ciCheck = () => { if (!ciBound && ciAddr && gw.ciEnabled()) { ciBound = true; listen(ciAddr, true); } };
ciCheck();
setInterval(ciCheck, 60_000);

// The monitoring module's metrics (lib.ts metricsText): a node-exporter textfile every 30 seconds, written only while the
// module's directory exists. A file, not a route: nothing new listens, and a stale file shows the gateway is down.
const textfile = path.join(dataDir, "modules", "monitoring", "textfile");
setInterval(() => {
  if (!existsSync(textfile)) return;
  try {
    const tmp = path.join(textfile, ".gateway.prom.tmp");
    writeFileSync(tmp, gw.metricsText());
    renameSync(tmp, path.join(textfile, "gateway.prom"));
  } catch (e) {
    log("metrics write failed", { err: String((e as Error).message).slice(0, 200) });
  }
}, 30_000).unref();

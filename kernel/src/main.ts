#!/usr/bin/env node
// The kernel host service, systemd user unit aidenhq-kernel (ops/units/aidenhq-kernel.service).
// - The model gateway (gateway/lib.ts; CI credentials gateway/ci.ts): the only holder of the model key (read from the vault at
//   each call), on host loopback and the backplane's gateway address (8201), and with CI on, on the CI runners' bridge. Runner
//   jobs' tool calls (their jobcaps) come in on 8201 too, the one port their jail reaches. Fails closed: if it is down, no
//   model or tool call is made.
// - The backplane listener (10.231.0.1:3130, backplane.ts): the tool proxy in front of every connection, caller identity
//   and assertions, and the control plane as the calling agent.
import http from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway, watched } from "./gateway/lib.ts";
import { createAsserter, loadKey } from "./assert.ts";
import { createBackplane } from "./backplane.ts";
import { createAsCaller, createCp } from "./cp.ts";
import { createIdentity, type Connection, type Grant, type Jobcap } from "./identity.ts";
import { createResolver } from "./net.ts";
import { createProxy } from "./proxy.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dotenv: Record<string, string> = {};
if (existsSync(path.join(repo, ".env"))) {
  for (const line of readFileSync(path.join(repo, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) dotenv[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
function env(k: string): string | undefined;
function env(k: string, d: string): string;
function env(k: string, d?: string) { return process.env[k] ?? dotenv[k] ?? d; }
const secretsDir = env("AIDENHQ_SECRETS_DIR");
if (!secretsDir) throw new Error("AIDENHQ_SECRETS_DIR is not set (.env)");
const configDir = path.resolve(repo, env("AIDENHQ_CONFIG_DIR", "config"));
const dataDir = path.resolve(repo, env("AIDENHQ_DATA_DIR", "data"));
const secret = (n: string) => { try { return readFileSync(path.join(secretsDir, n), "utf8").trim(); } catch { return ""; } };
const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(fields));

const controlUrl = env("PAPERCLIP_URL", "http://127.0.0.1:3100");
const launcherUrl = env("AIDENHQ_LAUNCHER_URL", "http://10.231.0.1:8199"); // names agent computers' run tokens (/whoami)
const grantsFile = path.join(configDir, "grants", "grants.json");
const grantsTable = watched(grantsFile, (j) => j as { agents?: Record<string, Grant> } & Record<string, unknown>, {});
const connections = watched(path.join(configDir, "kernel", "connections.json"), (j) => j as Record<string, Connection>, {});
// The task a control-plane run is on: its run record, read with the board key (only the kernel holds it).
async function runTask(runId: string): Promise<string | undefined> {
  const res = await fetch(new URL(`/api/heartbeat-runs/${encodeURIComponent(runId)}`, controlUrl), { headers: { authorization: `Bearer ${secret("paperclip_board_key")}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return undefined;
  const r = (await res.json()) as { issueId?: string; contextSnapshot?: { issueId?: string } };
  return r.issueId ?? r.contextSnapshot?.issueId ?? undefined;
}
const whoami = createIdentity({
  grants: () => grantsTable().agents ?? {}, connections,
  jobcaps: watched(path.join(configDir, "jobcaps.json"), (j) => j as Record<string, Jobcap>, {}), // runner jobs' reads (compile)
  secret, controlUrl, launcherUrl, runTask,
});
const asserter = createAsserter(loadKey(path.join(dataDir, "kernel", "caller-key.pem")));
const resolver = createResolver({ project: env("COMPOSE_PROJECT_NAME", "aidenhq") });
const proxy = createProxy({ whoami, connections, asserter, resolver, secret, log });
const backplane = createBackplane({ whoami, asserter, grantsFile: grantsTable, log, proxy: (req, res, c) => proxy(req, res, c!), cp: createCp({ whoami, asserter, controlUrl, launcherUrl, log }) as never });

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
const textfile = path.join(dataDir, "monitoring", "textfile");
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

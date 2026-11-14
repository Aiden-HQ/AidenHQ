#!/usr/bin/env node
// The model gateway: the only holder of the OpenRouter key (read from the vault at each call). Host service, systemd user
// unit aidenhq-gateway (ops/units/aidenhq-gateway.service). Listens on host loopback (runner jobs through their netjail
// port, the AI reviewer, the intake, the computer launcher forwarding its boxes' calls) and on the backplane's gateway address (Codex in Paperclip, source writers, the
// board's usage pull), and, with the ci module on, on the CI runners' bridge (app CI code review, CI tokens only). Logic and
// routes: lib.mjs; CI credentials: ci.mjs. Fails closed: if it is down, no model call is made.
import http from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./lib.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dotenv = {};
if (existsSync(path.join(repo, ".env"))) {
  for (const line of readFileSync(path.join(repo, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = (k, d) => process.env[k] ?? dotenv[k] ?? d;
const secretsDir = env("AIDENHQ_SECRETS_DIR");
if (!secretsDir) throw new Error("AIDENHQ_SECRETS_DIR is not set (.env)");
const configDir = path.resolve(repo, env("AIDENHQ_CONFIG_DIR", "config"));
const dataDir = path.resolve(repo, env("AIDENHQ_DATA_DIR", "data"));
const secret = (n) => { try { return readFileSync(path.join(secretsDir, n), "utf8").trim(); } catch { return ""; } };
const log = (msg, fields = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(fields));

const gw = createGateway({
  dbFile: path.join(dataDir, "gateway", "usage.db"),
  grantsFile: path.join(configDir, "grants", "grants.json"),
  settingsFile: path.join(configDir, "gateway.json"),
  secret,
  upstream: env("AIDENHQ_GATEWAY_UPSTREAM", "https://openrouter.ai/api/v1"),
  paperclipUrl: env("PAPERCLIP_URL", "http://127.0.0.1:3100"),
  boardUrl: env("BOARD_INTERNAL_URL", "http://127.0.0.1:3122"),
  launcherUrl: env("AIDENHQ_LAUNCHER_URL", "http://10.231.0.1:8199"), // names agent computers' run tokens (/whoami)
  log,
});

// host:port pairs. Each binds on its own: the backplane address exists only once compose is up, so a failed bind is retried
// (backoff up to a minute) while the others keep serving.
function listen(addr, ci = false) {
  const i = addr.lastIndexOf(":");
  const server = http.createServer((req, res) => gw.handle(req, res, { ci }));
  // A model stream can run for many minutes (requestTimeout covers receiving the request, not the answer). The CI listener
  // faces jobs that run untrusted code: a request must arrive within a minute, and few connections at once.
  server.requestTimeout = ci ? 60_000 : 0;
  if (ci) server.maxConnections = 32;
  let wait = 1000;
  const bind = () => server.listen(Number(addr.slice(i + 1)), addr.slice(0, i));
  server.on("listening", () => { wait = 1000; log("gateway listening", { addr }); });
  server.on("error", (e) => {
    log("listen failed; retrying", { addr, err: e.message, inMs: wait });
    setTimeout(bind, wait);
    wait = Math.min(wait * 2, 60_000);
  });
  bind();
}
for (const addr of env("AIDENHQ_GATEWAY_LISTEN", "127.0.0.1:8201,10.231.0.1:8201").split(",").map((s) => s.trim()).filter(Boolean)) listen(addr);

// The CI listener, on the CI runners' bridge address (modules/ci; ops/units/aidenhq-ci-net.service lets that bridge reach this
// port only): CI routes and CI tokens only (lib.mjs). Bound once config/gateway.json turns CI on (checked every minute, so
// an apply that enables the ci module needs no restart); a host without the CI network never tries.
const ciAddr = env("AIDENHQ_GATEWAY_CI_LISTEN", "10.231.4.1:8201");
let ciBound = false;
const ciCheck = () => { if (!ciBound && ciAddr && gw.ciEnabled()) { ciBound = true; listen(ciAddr, true); } };
ciCheck();
setInterval(ciCheck, 60_000);

// The monitoring module's metrics (lib.mjs metricsText): a node-exporter textfile every 30 seconds, written only while the
// module's directory exists. A file, not a route: nothing new listens, and a stale file shows the gateway is down.
const textfile = path.join(dataDir, "monitoring", "textfile");
setInterval(() => {
  if (!existsSync(textfile)) return;
  try {
    const tmp = path.join(textfile, ".gateway.prom.tmp");
    writeFileSync(tmp, gw.metricsText());
    renameSync(tmp, path.join(textfile, "gateway.prom"));
  } catch (e) {
    log("metrics write failed", { err: String(e.message).slice(0, 200) });
  }
}, 30_000).unref();

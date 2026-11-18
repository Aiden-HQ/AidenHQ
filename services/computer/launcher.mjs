#!/usr/bin/env node
// The computer launcher: runs on the host as the AidenHQ user (docker group), systemd user unit aidenhq-computers.
//
// Control API, on the backplane gateway:
//   POST /progress {agentId}  the tail of that agent's Codex session log from its live box → {lines} (the board's live view;
//                             bearer = secret computer_progress_token, which opens nothing else)
//   GET /health (no auth)
// Gateway, on the computers network gateway (only boxes reach it; ops/vm/computer-net.sh). A box's only credential is its
// kernel job's token (ahqj_), which the launcher knows by its hash (the job record):
//   POST /api/v1/responses | /api/v1/chat/completions   model calls, passed on to the kernel's model gateway with that token
//   /c/<connection>/mcp       tool calls to a connection (X-Agent-Key = the job token), passed on to the kernel's proxy
//                             (aidenhq-kernel) with that token as the bearer: the kernel checks the grants and holds the keys
//   POST /repo {repo, sha}    the box's `repo-checkout`: a snapshot (no .git, no credentials) of an agents-org repo at a commit,
//                             from the cache clone, into /workspace/repos/<name>; jobs with the repo-checkout role
//   POST /v1/writes, /v1/jobtools/<cmd>  a kernel job box's `aidenhq` commands (bearer = its job token), on to the kernel as it
//
// Jobs (bearer = secret launcher_kernel_key, the kernel's; it opens nothing else).
// A job's process runs in the box through the kernel's own `docker exec`.
//   POST /job {agentId, issueId, identifier, workspace, engine, state, image, token, mcp, roles}   the kernel's (boxes.ts): the
//                             image its admission froze, its job token (ahqj_) as the box's only credential and the job's
//                             Codex MCP config → {container, envFile, outDir}
//   POST /job/renew {container, issueId}   the kernel still follows it (also on adoption): a new lease
//   POST /job/release {container}   destroy; idempotent → {state} ("missing" once the box is gone)
//   POST /check {check, image, workspace, out, readOnly, token?, timeoutMs}   the kernel's only: a box for one run of a check
//                             (kernel/src/checkjobs.ts), with only its snapshot and out folder → {container}; /job/release ends it
//
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveArgs, forwardModel, PROGRESS_SCRIPT, UNTAR_SCRIPT, boxOf, checkoutRequest, Jobs, mayCheckout, tokenHash, JOB_HOME, JOB_ROUTES, CHECK_ROUTES, checkMounts, admit, controlAllowed, jobEnvFile, jobFolder, jobMounts, reapLapsed, builtImage, dockerRunArgs, stale } from "./lib.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dotenv = {};
if (existsSync(path.join(repo, ".env"))) {
  for (const line of readFileSync(path.join(repo, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = (k, d) => process.env[k] ?? dotenv[k] ?? d;
const configDir = path.resolve(repo, env("AIDENHQ_CONFIG_DIR", "config"));
const secretsDir = env("AIDENHQ_SECRETS_DIR");
if (!secretsDir) throw new Error("AIDENHQ_SECRETS_DIR is not set (.env)");
const secret = (n) => { try { return readFileSync(path.join(secretsDir, n), "utf8").trim(); } catch { return ""; } };

const CFG = {
  control: { host: "10.231.0.1", port: 8199 },
  gateway: { host: "10.231.2.1", port: 8200 },
  network: "aidenhq-computers",
  prefix: "aidenhq-computer-",
  idleMs: 10 * 60_000,
  limits: { memory: env("AIDENHQ_COMPUTERS_MEMORY", "6g"), cpus: Number(env("AIDENHQ_COMPUTERS_CPUS", 2)), shm: "1g", pids: 1024 },
  computersFile: path.join(configDir, "computers.json"),
  composeProject: env("COMPOSE_PROJECT_NAME", "aidenhq"),
  // The host's work and state dirs (work_dir and state_dir in config/runner.yaml): the task folders, the clones' guard hooks
  // and the per-task Codex homes.
  runnerWork: runnerDir("work_dir", "~/aidenhq-work"),
  runnerState: runnerDir("state_dir", "~/.local/state/aidenhq-runner"),
};
CFG.runnerRepos = path.join(CFG.runnerWork, "repos");
function runnerDir(key, fallback) {
  let dir = fallback;
  try { dir = new RegExp(`^${key}:\\s*["']?([^"'#\\n]+?)["']?\\s*(#.*)?$`, "m").exec(readFileSync(path.join(configDir, "runner.yaml"), "utf8"))?.[1] ?? dir; } catch {}
  return dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}
const GATEWAY_URL = `http://${CFG.gateway.host}:${CFG.gateway.port}`;
// The model gateway on host loopback (kernel/src/gateway): every box's model call goes on to it.
const MODEL_GATEWAY_URL = "http://127.0.0.1:8201";
// The kernel's backplane listener: every box's tool call and `aidenhq` command goes on to it.
const KERNEL_URL = "http://10.231.0.1:3130";
const PROGRESS_TOKEN = secret("computer_progress_token");
// The kernel's key: the job and check routes. Unset, jobs are off (every /job call is refused).
const KERNEL_KEY = secret("launcher_kernel_key");

// Docker's embedded DNS (127.0.0.11) relies on iptables inside the netns, which gVisor's netstack never sees.
const stateDir = path.join(os.homedir(), ".local/state/aidenhq-computers");
mkdirSync(stateDir, { recursive: true });
const resolvConf = path.join(stateDir, "resolv.conf");
writeFileSync(resolvConf, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const DEBUG = env("AIDENHQ_COMPUTERS_DEBUG") === "1"; // log every exec, with its env keys (never values)
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
/** The pool's size: settings.computers_max (compile writes it to computers.json; the kernel admits jobs against the same number). */
const maxBoxes = () => {
  const n = readJson(CFG.computersFile).max;
  if (!Number.isInteger(n) || n < 1) throw fail(500, "computers.json has no max (run scripts/compile.mjs)");
  return n;
};
const boxes = new Map(); // container → { agentId, lastUsed, busy }
// Jobs' records (lease, task, token hash), saved as a 0600 file: a restart reloads them before it admits or reaps.
const jobs = new Jobs();
const jobsFile = path.join(stateDir, "jobs.json");
try { jobs.load(readJson(jobsFile)); } catch {}
// Written whole then renamed, so a crash never leaves a half file.
const saveJobs = () => { try { writeFileSync(`${jobsFile}.tmp`, JSON.stringify(jobs.dump()), { mode: 0o600 }); renameSync(`${jobsFile}.tmp`, jobsFile); } catch (e) { log("couldn't save jobs:", e.message); } };
const held = (name) => jobs.leased(name);
const jobEnvDir = path.join(stateDir, "jobs");
mkdirSync(jobEnvDir, { recursive: true, mode: 0o700 });

function docker(args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn("docker", args, { stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const t = opts.timeoutMs > 0 ? setTimeout(() => { timedOut = true; c.kill("SIGKILL"); }, opts.timeoutMs) : null;
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code, signal) => { if (t) clearTimeout(t); resolve({ exitCode: timedOut ? null : code, signal, timedOut, stdout: out, stderr: err }); });
    if (opts.stdin != null) c.stdin.end(opts.stdin);
  });
}
// "missing" only when Docker says so: a daemon that doesn't answer is not a box that is gone (a job's release waits on this).
const jobState = async (name) => {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", name]);
  if (r.exitCode === 0) return r.stdout.trim();
  return /no such (object|container)/i.test(r.stderr) ? "missing" : "unknown";
};
const ours = (name) => typeof name === "string" && name.startsWith(CFG.prefix) && /^[a-z0-9-]+$/.test(name);
const fail = (status, msg) => Object.assign(new Error(msg), { status });

async function destroy(name, why) {
  boxes.delete(name);
  if (jobs.delete(name)) saveJobs();
  rmSync(path.join(jobEnvDir, `${name}.env`), { force: true });
  rmSync(path.join(jobEnvDir, name), { recursive: true, force: true });
  await docker(["rm", "-f", name]);
  log("destroyed", name, why);
}

/** A kernel job's image, by the name its admission froze: one compile tagged (computers.json). */
async function imageNamed(name) {
  const tag = typeof name === "string" ? readJson(CFG.computersFile).images?.[name] : undefined;
  if (!tag) throw fail(400, `no computer image ${name} (computers.json)`);
  return builtImage(tag, docker, log);
}
/** A free slot for a new box: the least recently used idle box goes (never a leased job's); all busy → wait up to 45 s. */
async function makeRoom() {
  for (let waited = 0; ; waited += 1000) {
    const max = maxBoxes();
    const evict = admit(boxes, max, held);
    if (evict === null) return;
    if (evict !== "wait") return destroy(evict, "evicted (computers full)");
    if (waited >= 45_000) throw fail(503, `all ${max} computers are busy; try again shortly`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const newName = () => CFG.prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** The board's live line for an agent in its own computer: the tail of its Codex session log. */
async function progress({ agentId }) {
  const box = typeof agentId === "string" ? boxOf(boxes, agentId) : undefined;
  if (!box) return { lines: [] };
  const r = await docker(["exec", box, "sh", "-c", PROGRESS_SCRIPT], { timeoutMs: 8000 });
  return { lines: r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : [] };
}

// A job's box: the launcher's uid (workspace files stay the host user's), a HOME outside every clone.
const JOB_USER = `${process.getuid()}:${process.getgid()}`;
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

/** The job and check routes (lib.mjs controlAllowed). */
const jobControl = {
  async "/job"({ agentId, issueId, identifier, workspace, engine, state, identity, image: imageName, token, mcp, roles }, { kernel = false } = {}) {
    if (!kernel) throw fail(403, "job boxes are the kernel's");
    if (typeof agentId !== "string" || !agentId || typeof issueId !== "string" || !issueId) throw fail(400, "agentId and issueId required");
    if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) throw fail(400, "identifier must be the task's, e.g. PEN-7");
    if (typeof token !== "string" || !token.startsWith("ahqj_") || /\s/.test(token) || typeof mcp !== "string") throw fail(400, "the kernel sends the job's token and its MCP config");
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string")) throw fail(400, "the kernel sends the job's frozen roles");
    // The job's engine (engine@1): a kind the compiled registry says runs in a box, its module mounted read-only.
    const entry = (() => { try { return readJson(path.join(configDir, "engines.json"))[engine]; } catch { return undefined; } })();
    if (typeof engine !== "string" || entry?.box !== true || !/^modules\/[a-z0-9-]+$/.test(entry.dir ?? "")) throw fail(400, `engine ${engine} doesn't run in a box (config/engines.json)`);
    const image = await imageNamed(imageName);
    // Exactly this task's folder and its engine's state folder, real directories with no symlink below the work dirs: never
    // the cache clones, another task's folder or anything a path trick reaches. A job's state is its agent's on this task
    // (kernel/src/sandbox.ts engineState), so two agents never share one.
    jobFolder(workspace, path.join(CFG.runnerWork, "tasks"), identifier);
    jobFolder(state, path.join(CFG.runnerState, engine), `${agentId}/${issueId}`.replace(/[^\w.-]/g, "_"));
    const codexHome = state;
    // Two executions never share a workspace: the task's last box must be gone first (the kernel releases it).
    const before = jobs.byIssue(issueId);
    if (before) throw fail(409, `the task's last box ${before.container} is still up: release it first`);
    await makeRoom();
    const name = newName();
    boxes.set(name, { agentId, lastUsed: Date.now(), busy: 1 }); // reserve the slot while starting
    // The job's only credential is the kernel's job token: the launcher keeps only its hash.
    jobs.add({ container: name, agentId, issueId, identifier, workspace, codexHome, kernel: true, tokenHash: tokenHash(token), roles }); saveJobs();
    const envFile = path.join(jobEnvDir, `${name}.env`);
    // The job's last message lands here, outside the workspace: a folder of the launcher's, mounted at /aidenhq-out.
    const outDir = path.join(jobEnvDir, name);
    try {
      mkdirSync(outDir, { mode: 0o700 });
      const mounts = jobMounts({ resolvConf, workspace, outDir, codexHome, runnerWork: CFG.runnerWork, repo, engineDir: entry.dir });
      // aidenhq-browse uses the image's own agent-browser and Chrome (the browser image every computer builds on).
      const r = await docker(dockerRunArgs({ name, image, agentId, network: CFG.network, limits: CFG.limits, mounts, user: JOB_USER, labels: [`aidenhq.job=${issueId}`], home: JOB_HOME }));
      if (r.exitCode !== 0) throw fail(500, `docker run failed: ${r.stderr.trim()}`);
      writeFileSync(envFile, jobEnvFile({ token, mcp, gatewayUrl: GATEWAY_URL, identity }), { mode: 0o600 });
    } catch (e) {
      await destroy(name, "job box failed to start");
      throw e;
    }
    boxes.get(name).busy = 0;
    return { container: name, envFile, outDir };
  },
  async "/job/renew"({ container, issueId }, { kernel = false } = {}) {
    if (!ours(container)) throw fail(400, "not a computer");
    if (!kernel) throw fail(403, `not your job's box: ${container}`);
    if ((await jobState(container)) === "missing") {
      if (jobs.has(container)) await destroy(container, "gone before its renewal");
      throw fail(404, `box gone: ${container}`);
    }
    const r = jobs.renew(container, { issueId });
    if (!r) throw fail(404, `no live job ${container} for that task (its lease lapsed, or it is another task's)`);
    saveJobs();
    return { container, issueId: r.issueId, identifier: r.identifier, workspace: r.workspace, leaseUntil: r.leaseUntil };
  },
  /**
   * The kernel's check box (kernel/src/checkbox.ts): one run of a check, in the image its run names, with only the check's
   * snapshot, its out folder and the product's supply-chain checks mounted (lib.mjs checkMounts). No agent or task: only the
   * eval's model token, by its hash, so the gateway below passes its model calls on (fast and tests have
   * none). Its lease is its time limit: a kernel that dies mid-run leaves nothing behind. The kernel runs the command itself
   * (docker exec) and ends it with /job/release.
   */
  async "/check"({ check, image: imageName, workspace, out, readOnly, token, timeoutMs }, { kernel = false } = {}) {
    if (!kernel) throw fail(403, "check boxes are the kernel's");
    if (typeof check !== "string" || !/^c-[0-9a-f]{16}$/.test(check)) throw fail(400, "check is the kernel's check id");
    if (token != null && (typeof token !== "string" || !token.startsWith("ahqj_") || /\s/.test(token))) throw fail(400, "a check's token is the kernel's (ahqj_)");
    const ms = Number(timeoutMs);
    if (!Number.isInteger(ms) || ms < 1000 || ms > 2 * 3600_000) throw fail(400, "timeoutMs is the run's time limit");
    // Exactly this check's own folders under the kernel's work_dir/checks/<check>: the snapshot (ws, tree) and an out folder.
    const root = path.join(CFG.runnerWork, "checks", check);
    if (!["ws", "tree"].includes(path.basename(String(workspace))) || !/^out(-\d)?$/.test(path.basename(String(out)))) throw fail(400, "not a check's folders");
    const ws = jobFolder(workspace, root, path.basename(workspace));
    const o = jobFolder(out, root, path.basename(out));
    const image = await imageNamed(imageName);
    await makeRoom();
    const name = newName();
    boxes.set(name, { agentId: "check", lastUsed: Date.now(), busy: 1 }); // reserve the slot while starting
    jobs.add({ container: name, agentId: "check", issueId: `check:${check}`, check, kernel: true, ...(token ? { tokenHash: tokenHash(token) } : {}) }, Date.now(), ms + 5 * 60_000); saveJobs();
    try {
      const mounts = checkMounts({ resolvConf, workspace: ws, out: o, readOnly: readOnly === true, supplyChain: path.join(repo, "scripts/supply-chain") });
      const r = await docker(dockerRunArgs({ name, image, agentId: "check", network: CFG.network, limits: CFG.limits, mounts, user: JOB_USER, labels: [`aidenhq.check=${check}`], home: "/aidenhq-out/home" }));
      if (r.exitCode !== 0) throw fail(500, `docker run failed: ${r.stderr.trim()}`);
    } catch (e) {
      await destroy(name, "check box failed to start");
      throw e;
    }
    boxes.get(name).busy = 0;
    return { container: name };
  },
  async "/job/release"({ container }, { kernel = false } = {}) {
    if (!ours(container)) throw fail(400, "not a computer");
    if (!kernel) throw fail(403, `not your job's box: ${container}`);
    if (jobs.has(container) || (await jobState(container)) !== "missing") await destroy(container, "released");
    return { state: await jobState(container) };
  },
};

/**
 * `repo-checkout <org/name> <sha>` from a box: `git archive` of that commit in the cache clone, streamed into the calling
 * box (its own job token names it). Read-only on the cache: a commit it doesn't have yet is refused, never fetched.
 */
async function checkout(who, raw) {
  if (!mayCheckout(who)) throw fail(403, "repo-checkout needs the repo-checkout role");
  let p;
  try { p = JSON.parse(raw || "{}"); } catch { throw fail(400, "bad json"); }
  let { cache, sha, dest } = checkoutRequest(p, { agentsOrg: readJson(CFG.computersFile).agents_org, agentsOrgs: readJson(CFG.computersFile).agents_orgs, cacheRoot: CFG.runnerRepos });
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const has = spawn("git", ["-C", cache, "rev-parse", "--verify", "--quiet", `${sha ?? "refs/remotes/origin/HEAD"}^{commit}`], { env: gitEnv, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  has.stdout.on("data", (x) => (out += x));
  if ((await new Promise((r) => has.on("close", r))) !== 0) throw fail(404, `${p.repo}${sha ? ` at ${sha.slice(0, 12)}` : ""} isn't in the runner's copy yet (the runner fetches when an Engineer pushes or works on it); try again in a minute`);
  sha = out.trim();
  const b = boxes.get(who.container);
  if (b) { b.busy++; b.lastUsed = Date.now(); }
  try {
    // Piped straight from git to the box (binary; never through docker()'s string buffer).
    const g = spawn("git", archiveArgs(cache, sha), { env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
    const d = spawn("docker", ["exec", "-i", who.container, "sh", "-c", UNTAR_SCRIPT, "sh", dest], { stdio: ["pipe", "ignore", "pipe"] });
    // A box gone mid-stream (evicted, tar failed) is an EPIPE here: the exit codes report it; it must never crash the launcher.
    for (const s of [g, d, g.stdout, d.stdin]) s.on("error", () => {});
    g.stdout.pipe(d.stdin);
    let err = "";
    g.stderr.on("data", (x) => (err += x));
    d.stderr.on("data", (x) => (err += x));
    const t = setTimeout(() => { g.kill("SIGKILL"); d.kill("SIGKILL"); }, 120_000);
    const [gc, dc] = await Promise.all([g, d].map((c) => new Promise((r) => c.on("close", r))));
    clearTimeout(t);
    if (gc !== 0 || dc !== 0) throw fail(500, `checkout failed: ${err.trim().slice(-300) || `git ${gc}, tar ${dc}`}`);
  } finally {
    if (b) { b.busy--; b.lastUsed = Date.now(); }
  }
  log("/repo", who.container, p.repo, sha.slice(0, 12), "→", dest);
  return { path: dest, repo: p.repo, sha, note: "a snapshot of that commit: no .git, no credentials; nothing here can be pushed" };
}


const bearer = (req) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const controlServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    try { return send(res, 200, { ok: true, computers: boxes.size, max: maxBoxes() }); } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }
  // Only these routes exist; anything else is a 404 before any key is looked at.
  const fn = req.method !== "POST" ? undefined : req.url === "/progress" ? progress : Object.hasOwn(jobControl, req.url) ? jobControl[req.url] : undefined;
  if (!fn) return send(res, 404, { error: "no such route" });
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    // The board's progress key opens /progress only; the kernel's key the job and check routes only.
    if (!controlAllowed(bearer(req), req.method, req.url, { kernel: KERNEL_KEY, progress: PROGRESS_TOKEN })) return send(res, 401, { error: "unauthorized" });
    const byKernel = Boolean(KERNEL_KEY) && bearer(req) === KERNEL_KEY;
    const t0 = Date.now();
    try {
      const p = JSON.parse(body || "{}");
      const out = await fn(p, { kernel: byKernel });
      if (req.url !== "/progress" || DEBUG) log(req.url, p.container ?? p.agentId ?? "", `${Date.now() - t0}ms`, out.state ?? out.container ?? "");
      send(res, 200, out);
    } catch (e) {
      log(req.url, "ERROR", e.message);
      send(res, e.status ?? 500, { error: e.message });
    }
  });
});

// ------------------------------------------------------------------ gateway (boxes only)

/** The live box a box-side credential is: a kernel job's token for the box made for it. */
const liveBox = (token) => jobs.byKernelToken(token);

const gatewayServer = http.createServer(async (req, res) => {
  const deny = (status, msg) => { log("gateway", req.method, req.url, status, msg); res.writeHead(status, { "content-type": "text/plain" }).end(`gateway: ${msg}`); };
  try {
    if (req.method === "POST" && (req.url === "/api/v1/responses" || req.url === "/api/v1/chat/completions")) {
      // The model: the box's "API key" is its job token; the model gateway, not a box or the launcher, holds the real key.
      const token = bearer(req);
      const who = liveBox(token);
      if (!who) return deny(401, "not a live computer");
      boxes.get(who.container) && (boxes.get(who.container).lastUsed = Date.now());
      return await forwardModel(req, res, `${MODEL_GATEWAY_URL}${req.url}`, token);
    }
    if (req.method === "POST" && req.url === "/repo") {
      const who = liveBox(String(req.headers["x-agent-key"] ?? ""));
      if (!who) return deny(401, "not a live computer");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return checkout(who, Buffer.concat(chunks).toString("utf8").slice(0, 4096)).then(
        (out) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out)),
        (e) => deny(e.status ?? 500, e.message),
      );
    }
    if (req.method === "POST" && /^\/v1\/(writes|jobtools\/[a-z]+)$/.test(req.url ?? "")) {
      // A kernel job's `aidenhq` commands (images/engineer/bin/aidenhq): its writes and next-turn requests, to the kernel as itself.
      const token = bearer(req);
      if (!liveBox(token)) return deny(401, "not a live computer");
      const k = new URL(req.url, KERNEL_URL);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}) };
      const up = http.request({ host: k.hostname, port: Number(k.port || 80), path: k.pathname, method: "POST", headers }, (ur) => { res.writeHead(ur.statusCode ?? 502, { "content-type": ur.headers["content-type"] ?? "application/json" }); ur.pipe(res); });
      up.on("error", (e) => { if (!res.headersSent) deny(502, e.message); else res.destroy(); });
      return void req.pipe(up);
    }
    const m = /^\/c\/([a-z0-9_]+)\/mcp$/.exec(req.url.split("?")[0]);
    if (!m) return deny(403, "refused");
    if (!readJson(CFG.computersFile).connections?.[m[1]]) return deny(404, `no connection ${m[1]}`);
    const token = String(req.headers["x-agent-key"] ?? "");
    if (!liveBox(token)) return deny(401, "not a live computer");
    // The kernel's proxy decides: the job token is the caller; only MCP transport headers go on.
    const k = new URL(`/c/${m[1]}/mcp`, KERNEL_URL);
    const headers = { authorization: `Bearer ${token}` };
    for (const h of ["accept", "content-type", "content-length", "mcp-session-id", "mcp-protocol-version"]) if (req.headers[h]) headers[h] = req.headers[h];
    const up = http.request({ host: k.hostname, port: Number(k.port || 80), path: k.pathname, method: req.method, headers }, (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); });
    up.on("error", (e) => { if (!res.headersSent) deny(502, e.message); else res.destroy(); });
    req.pipe(up);
  } catch (e) {
    if (!res.headersSent) deny(502, e.message); else res.destroy();
  }
});

// ------------------------------------------------------------------ boxes from before a restart, and idle reaping

const existing = await docker(["ps", "-a", "--filter", "label=aidenhq.computer=1", "--format", "{{.Names}}"]);
const orphans = [];
for (const name of existing.stdout.trim().split("\n").filter(Boolean)) {
  if (!ours(name)) continue;
  // A box without its job record has lost its binding: nothing may run in it.
  if (jobs.has(name)) boxes.set(name, { agentId: jobs.get(name).agentId, lastUsed: Date.now(), busy: 0 });
  else orphans.push(name);
}
// A job record whose box is gone never comes back; its lease goes with it.
for (const name of jobs.containers()) if (!boxes.has(name)) jobs.delete(name);
saveJobs();
for (const name of orphans) await destroy(name, "a box without its job record");
if (boxes.size) log(`found ${boxes.size} job box(es) from before`);
// Listen only now: a call answered before the boxes from before are known would miss them.
controlServer.listen(CFG.control.port, CFG.control.host, () => log(`launcher on ${CFG.control.host}:${CFG.control.port}`));
gatewayServer.listen(CFG.gateway.port, CFG.gateway.host, () => log(`gateway on ${CFG.gateway.host}:${CFG.gateway.port}`));
// Idle boxes go; a leased job's never does. A lapsed lease (the kernel gone 15 minutes) takes its box.
setInterval(() => {
  const lapsed = reapLapsed(jobs);
  if (lapsed.length) saveJobs();
  for (const n of lapsed) destroy(n, "lease lapsed");
  for (const n of stale(boxes, CFG.idleMs, Date.now(), held)) destroy(n, "idle");
}, 60_000).unref();

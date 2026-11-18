#!/usr/bin/env node
// The computer launcher: runs on the host as the AidenHQ user (docker group), systemd user unit aidenhq-computers.
//
// Control API, on the backplane gateway (the plugin in paperclip calls it; bearer = secret computer_launcher_token):
//   POST /acquire {agentId}   a fresh gVisor box for this agent's run; image, limits and mounts from config, never the caller
//   POST /resume {container}  the same box for the next run of the same task (Paperclip scopes reuse); a new run token
//   POST /exec {container, command, args, cwd, env, stdin, timeoutMs, execId?}   with an execId (a long exec) it runs detached in
//                             the box and outlives a launcher restart; POST /attach {container, execId, timeoutMs} collects it
//   POST /release {container, destroy}   the run ended: its token is revoked (destroy: the box goes too)
//   POST /inspect {container}
//   POST /progress {agentId}  the tail of that agent's Codex session log from its live box → {lines} (the board's live view)
//   GET /health (no auth)     GET /whoami (Bearer <run token>) → {agentId, runId, issueId}: connections and the model gateway
//                             resolve run tokens here (runId, issueId: the Paperclip run and task the token's first exec named)
//   POST /cp {method, path, body?} (Bearer <run token>): one control-plane call as the run itself, made inside its box through
//                             Paperclip's bridge with the run's own credential (the kernel's /v1/cp/agent/*, which checks
//                             the path, calls it for a computer's run) → {status, type, body} (bodies base64)
// Gateway, on the computers network gateway (only boxes reach it; ops/vm/computer-net.sh):
//   POST /api/v1/responses    model calls: the "API key" must be a live run token; passed on to the model gateway
//                             (the kernel's model gateway, which counts and caps them like every agent's) with that token
//   /c/<connection>/mcp       tool calls to a connection: X-Agent-Key must be a live run token; passed on to the kernel's proxy
//                             (aidenhq-kernel) with that token as the bearer: the kernel checks the grants and holds the keys
//   POST /repo {repo, sha}    the box's `repo-checkout`: a snapshot (no .git, no credentials) of an agents-org repo at a commit,
//                             from the runner's cache clone, into /workspace/repos/<name>; agents with the repo-checkout role
//   POST /v1/writes, /v1/jobtools/<cmd>  a kernel job box's `aidenhq` commands (bearer = its job token), on to the kernel as it
//   POST /helper/<command>  a runner job box's `aidenhq` command (bearer = its run token), to the runner's helper bound to that job
//
// Jobs (bearer = secret computers_runner_key for the runner, launcher_kernel_key for the kernel; neither opens anything else and
// the plugin's key opens neither). A job's process runs in the box through the caller's own `docker exec`.
//   POST /job {agentId, issueId, identifier, helperPort, helperToken, identity}   a box for one turn of a runner job: image
//                             from the grants table, the task folder and Codex home the launcher derives, a lease, a run token
//                             bound to the task → {container, envFile}
//   POST /job {agentId, issueId, identifier, workspace, engine, state, image, token, mcp}   the kernel's (boxes.ts): the image
//                             its admission froze, its job token (ahqj_) as the box's only credential and the job's Codex MCP
//                             config; no run token of the launcher's, no helper
//   POST /job/renew {container, issueId, helperPort, helperToken}   the runner still follows it (also on adoption): a new lease
//   POST /job/release {container}   destroy and revoke; idempotent → {state} ("missing" once the box is gone)
//
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerSlowly, archiveArgs, forwardModel, PROGRESS_SCRIPT, CP_SCRIPT, UNTAR_SCRIPT, WRITE_RUN_TOKEN_SCRIPT, CLEAR_RUN_TOKEN_SCRIPT, boxOf, checkoutRequest, EXEC_ID, EXEC_ROOT, EXEC_MISSING, EXEC_PREP_SCRIPT, EXEC_RUN_SCRIPT, EXEC_WAIT_SCRIPT, Tokens, Creds, Jobs, mayCheckout, tokenHash, JOB_HOME, JOB_ROUTES, admit, controlAllowed, jobEnvFile, jobFolder, jobMounts, reapLapsed, serveHelper, builtImage, dockerRunArgs, oomMessage, execEnv, mcpBlock, runCredential, stale, wrapExec, routineArgs } from "./lib.mjs";

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
  grantsFile: path.join(configDir, "grants", "grants.json"),
  computersFile: path.join(configDir, "computers.json"),
  composeProject: env("COMPOSE_PROJECT_NAME", "aidenhq"),
  // The runner's work and state dirs (services/runner/src/config.mjs: work_dir and state_dir in config/runner.yaml): its cache
  // clones, and for runner jobs the task folders, the clones' guard hooks and the per-task Codex homes.
  runnerWork: runnerDir("work_dir", "~/aidenhq-work"),
  runnerState: runnerDir("state_dir", "~/.local/state/aidenhq-runner"),
  // A runner job's box: its own memory limit (the pool's RAM: docs/design/sandboxing.md, launcher pool).
  jobMemory: env("AIDENHQ_COMPUTERS_JOB_MEMORY", "3g"),
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
// The kernel's backplane listener: every box's tool call goes on to its proxy, and it asks /v1/whoami what a run is granted.
const KERNEL_URL = "http://10.231.0.1:3130";
const TOKEN = secret("computer_launcher_token");
const PROGRESS_TOKEN = secret("computer_progress_token");
// The runner's key and the kernel's: the job routes only. Unset, that caller's jobs are off (its /job calls are refused).
const RUNNER_KEY = secret("computers_runner_key");
const KERNEL_KEY = secret("launcher_kernel_key");
if (!TOKEN) throw new Error("the secret computer_launcher_token is missing (scripts/compile.mjs creates it)");

// Docker's embedded DNS (127.0.0.11) relies on iptables inside the netns, which gVisor's netstack never sees.
const stateDir = path.join(os.homedir(), ".local/state/aidenhq-computers");
mkdirSync(stateDir, { recursive: true });
const resolvConf = path.join(stateDir, "resolv.conf");
writeFileSync(resolvConf, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
const MOUNTS = [
  `${resolvConf}:/etc/resolv.conf:ro`,
  // The codex-model launcher (a routine's own model). One file: a mount of the folder at /opt/aidenhq would hide the image's
  // own /opt/aidenhq (app-starter, design-system).
  `${path.join(repo, "services/paperclip-tasks-mcp/codex-model")}:/opt/aidenhq/codex-model:ro`,
];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const DEBUG = env("AIDENHQ_COMPUTERS_DEBUG") === "1"; // log every exec, with its env keys (never values)
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
/** The pool's size: settings.computers_max (compile writes it to computers.json; the kernel admits jobs against the same number). */
const maxBoxes = () => {
  const n = readJson(CFG.computersFile).max;
  if (!Number.isInteger(n) || n < 1) throw fail(500, "computers.json has no max (run scripts/compile.mjs)");
  return n;
};
// The boxes' Paperclip credentials, saved like the tokens: an agent's turn is one detached exec that outlives a launcher
// restart, so /cp must still find the credential the turn started with.
const creds = new Creds();
const credsFile = path.join(stateDir, "run-creds.json");
try { creds.load(readJson(credsFile)); } catch {}
const saveCreds = () => { try { writeFileSync(`${credsFile}.tmp`, JSON.stringify(creds.dump()), { mode: 0o600 }); renameSync(`${credsFile}.tmp`, credsFile); } catch (e) { log("couldn't save run credentials:", e.message); } };
// A container's credential goes when its token does, expiry included: a later box reusing the name never inherits one.
const tokens = new Tokens({ onRevoke: (container) => { if (creds.delete(container)) saveCreds(); } });
// Run tokens survive a launcher restart (a running box keeps its token in its env): a 0600 file, rewritten on every change.
const tokensFile = path.join(stateDir, "run-tokens.json");
try { tokens.load(readJson(tokensFile)); } catch {}
// Written whole then renamed, so a crash never leaves a half file.
const saveTokens = () => { try { writeFileSync(`${tokensFile}.tmp`, JSON.stringify(tokens.dump()), { mode: 0o600 }); renameSync(`${tokensFile}.tmp`, tokensFile); } catch (e) { log("couldn't save run tokens:", e.message); } };
const boxes = new Map(); // container → { agentId, lastUsed, busy, cred? } (cred: the current run's Paperclip credential, for /cp)
// Runner jobs' records (lease, task, helper binding), saved the same way: a restart reloads them before it admits or reaps.
const jobs = new Jobs();
const jobsFile = path.join(stateDir, "jobs.json");
try { jobs.load(readJson(jobsFile)); } catch {}
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
const state = async (name) => (await docker(["inspect", "-f", "{{.State.Status}}", name])).stdout.trim() || "missing";
// "missing" only when Docker says so: a daemon that doesn't answer is not a box that is gone (a job's release waits on this).
const jobState = async (name) => {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", name]);
  if (r.exitCode === 0) return r.stdout.trim();
  return /no such (object|container)/i.test(r.stderr) ? "missing" : "unknown";
};
const ours = (name) => typeof name === "string" && name.startsWith(CFG.prefix) && /^[a-z0-9-]+$/.test(name);
const fail = (status, msg) => Object.assign(new Error(msg), { status });
// The plugin's routes never touch a runner job's box.
const pluginBox = (container) => { if (jobs.has(container)) throw fail(404, `not a computer of Paperclip's: ${container}`); };

async function destroy(name, why) {
  tokens.revoke(name); saveTokens();
  boxes.delete(name);
  if (jobs.delete(name)) saveJobs();
  rmSync(path.join(jobEnvDir, `${name}.env`), { force: true });
  rmSync(path.join(jobEnvDir, name), { recursive: true, force: true });
  await docker(["rm", "-f", name]);
  log("destroyed", name, why);
}

/**
 * Hand the box its current run token for shell tools: on stdin, never argv, so it can't reach the launcher's log or the
 * host's process list. The box's `repo-checkout` reads it at use time; the run's own exec env still carries the token for
 * the model and MCP clients.
 */
async function writeRunToken(container, token) {
  if (!token) return;
  const r = await docker(["exec", "-i", container, "sh", "-c", WRITE_RUN_TOKEN_SCRIPT], { stdin: token });
  if (r.exitCode !== 0) throw fail(500, `could not give ${container} its run token: ${r.stderr.trim().slice(0, 200)}`);
}

/** End of the run: no token file is left for a process from it to reuse. */
async function clearRunToken(container) {
  await docker(["exec", container, "sh", "-c", CLEAR_RUN_TOKEN_SCRIPT]);
}

/** A kernel job's image, by the name its admission froze: one compile tagged (computers.json). */
async function imageNamed(name) {
  const tag = typeof name === "string" ? readJson(CFG.computersFile).images?.[name] : undefined;
  if (!tag) throw fail(400, `no computer image ${name} (computers.json)`);
  return builtImage(tag, docker, log);
}
/** The image this agent's computer runs: the grants table setup writes (agent id → image) and compile's tags. Never the caller. */
async function imageFor(agentId) {
  const g = readJson(CFG.grantsFile).agents?.[agentId];
  if (!g?.image) throw fail(403, `agent ${agentId} has no computer (no image: in its definition)`);
  const tag = readJson(CFG.computersFile).images?.[g.image];
  if (!tag) throw fail(500, `image ${g.image} has no tag in computers.json (run scripts/compile.mjs and ops/computer-images.sh)`);
  return builtImage(tag, docker, log);
}
/** The box's Codex config: the tools the kernel says this run token's agent is granted (GET /v1/whoami), never the caller's word. */
async function mcpFor(token) {
  const res = await fetch(new URL("/v1/whoami", KERNEL_URL), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw fail(502, `the kernel didn't name this computer's agent (${res.status})`);
  return mcpBlock((await res.json()).tools, readJson(CFG.computersFile).connections ?? {}, GATEWAY_URL);
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
/** A detached exec's result: waits for its exit code in the box, then its output. */
async function collect(container, dir, timeoutMs) {
  const r = await docker(["exec", container, "sh", "-c", EXEC_WAIT_SCRIPT, "sh", dir], { timeoutMs });
  if (r.exitCode === 97 && r.stderr.includes(EXEC_MISSING)) throw fail(404, `no exec ${path.basename(dir)} in ${container}: it never started`);
  return unlessGone(container, r);
}

/** A failed exec in a box that is no longer running says so (the run ends with that reason), not as a bare exit code. */
async function unlessGone(container, r) {
  if (r.exitCode === 0) return r;
  if (!boxes.has(container) || ["missing", "exited", "dead", "removing"].includes(await jobState(container))) {
    const oom = (await docker(["inspect", "-f", "{{.State.OOMKilled}}", container])).stdout.trim() === "true";
    const msg = oomMessage(container, jobs.has(container) ? CFG.jobMemory : CFG.limits.memory);
    if (oom) log(msg);
    throw fail(404, oom ? msg : `computer gone: ${container} went away during the command (destroyed or stopped)`);
  }
  return r;
}
const newName = () => CFG.prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const control = {
  async acquire({ agentId }) {
    if (typeof agentId !== "string" || !agentId) throw fail(400, "agentId required");
    const image = await imageFor(agentId);
    await makeRoom();
    const name = newName();
    boxes.set(name, { agentId, lastUsed: Date.now(), busy: 1 }); // reserve the slot while starting
    const r = await docker(dockerRunArgs({ name, image, agentId, network: CFG.network, limits: CFG.limits, mounts: MOUNTS }));
    if (r.exitCode !== 0) { boxes.delete(name); throw fail(500, `docker run failed: ${r.stderr.trim()}`); }
    boxes.get(name).busy = 0;
    const token = tokens.issue(name, agentId); saveTokens();
    try { await writeRunToken(name, token); } catch (e) { await destroy(name, "no run token"); throw e; }
    return { container: name, image };
  },
  async resume({ container }) {
    if (!ours(container)) throw fail(400, "not a computer");
    pluginBox(container);
    const s = await state(container);
    if (s === "missing" || !boxes.has(container)) { if (s !== "missing") await destroy(container, "unknown to the launcher"); throw fail(404, `computer gone: ${container}`); }
    if (s !== "running" && (await docker(["start", container])).exitCode !== 0) throw fail(500, `could not restart ${container}`);
    const b = boxes.get(container);
    b.lastUsed = Date.now();
    delete b.cred;
    const token = tokens.issue(container, b.agentId); saveTokens();
    await writeRunToken(container, token);
    return { container };
  },
  async exec({ container, command, args = [], cwd, env: e = {}, stdin, timeoutMs, execId }) {
    const b = boxes.get(container);
    if (!ours(container) || !b) throw fail(404, `computer gone: ${container}`);
    pluginBox(container);
    if (execId != null && !EXEC_ID.test(String(execId))) throw fail(400, "bad execId");
    const token = tokens.current(container);
    if (token) await writeRunToken(container, token); // a launcher restart, or a box from before this code, still gets it
    const cred = token && runCredential(e);
    if (cred) { b.cred = cred; creds.set(container, cred); saveCreds(); }
    // The run's token names its Paperclip run and task from here on: the model gateway attributes and caps by them.
    if (cred && tokens.bind(container, { runId: e.PAPERCLIP_RUN_ID, issueId: cred.taskId })) saveTokens();
    const xenv = execEnv(e, { token, mcp: e.CODEX_HOME && token ? await mcpFor(token) : undefined });
    const [cmd, cargs] = wrapExec(command, routineArgs(command, args, e), xenv);
    if (DEBUG) log("exec env keys", container, Object.keys(xenv).sort().join(","));
    // Env through a 0600 file so values never show in the host's process list; multi-line values can't go that way.
    const dir = mkdtempSync(path.join(os.tmpdir(), "aidenhq-exec-"));
    const f = path.join(dir, "env");
    writeFileSync(f, Object.entries(xenv).filter(([, v]) => !v.includes("\n")).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    const w = cwd ? ["-w", cwd] : [];
    b.busy++;
    b.lastUsed = Date.now();
    try {
      if (!execId) return await unlessGone(container, await docker(["exec", "-i", ...w, "--env-file", f, container, cmd, ...cargs], { stdin, timeoutMs }));
      // A long one runs detached (lib.mjs EXEC_RUN_SCRIPT): a launcher restart leaves it running; the plugin collects it (/attach).
      const inBox = `${EXEC_ROOT}/${execId}`;
      const prep = await docker(["exec", "-i", container, "sh", "-c", EXEC_PREP_SCRIPT, "sh", inBox], { stdin: stdin ?? "" });
      if (prep.exitCode !== 0) return await unlessGone(container, prep);
      const start = await docker(["exec", "-d", ...w, "--env-file", f, container, "sh", "-c", EXEC_RUN_SCRIPT, "sh", inBox, cmd, ...cargs]);
      if (start.exitCode !== 0) return await unlessGone(container, start);
      return await collect(container, inBox, timeoutMs);
    } finally {
      b.busy--;
      b.lastUsed = Date.now();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  /** A long exec's result, from a launcher that wasn't there when it started (a restart mid-turn): the plugin asks again. */
  async attach({ container, execId, timeoutMs }) {
    const b = boxes.get(container);
    if (!ours(container) || !b) throw fail(404, `computer gone: ${container}`);
    pluginBox(container);
    if (!EXEC_ID.test(String(execId))) throw fail(400, "execId required");
    b.busy++;
    b.lastUsed = Date.now();
    try {
      return await collect(container, `${EXEC_ROOT}/${execId}`, timeoutMs);
    } finally {
      b.busy--;
      b.lastUsed = Date.now();
    }
  },
  async release({ container, destroy: d }) {
    if (!ours(container)) throw fail(400, "not a computer");
    pluginBox(container);
    tokens.revoke(container); saveTokens();
    if (!d) await clearRunToken(container);
    if (boxes.has(container)) delete boxes.get(container).cred;
    if (d) await destroy(container, "released");
    return { state: await state(container) };
  },
  /** The board's live line for an agent in its own computer: the tail of its Codex session log. */
  async progress({ agentId }) {
    const box = typeof agentId === "string" ? boxOf(boxes, agentId) : undefined;
    if (!box) return { lines: [] };
    const r = await docker(["exec", box, "sh", "-c", PROGRESS_SCRIPT], { timeoutMs: 8000 });
    return { lines: r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : [] };
  },
  async inspect({ container }) {
    if (!ours(container)) throw fail(400, "not a computer");
    pluginBox(container);
    return { state: boxes.has(container) ? await state(container) : "missing" };
  },
};

// A runner job's box: the runner's uid (workspace files stay the runner's), a HOME outside every clone.
const JOB_USER = `${process.getuid()}:${process.getgid()}`;
const HELPER_TOKEN = /^[0-9a-f]{16,128}$/;
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

/** The runner's job routes (computers_runner_key only). */
const runnerControl = {
  async "/job"({ agentId, issueId, identifier, workspace, engine, state, helperPort, helperToken, identity, image: imageName, token: kernelToken, mcp: kernelMcp, roles }, { kernel = false } = {}) {
    if (typeof agentId !== "string" || !agentId || typeof issueId !== "string" || !issueId) throw fail(400, "agentId and issueId required");
    if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) throw fail(400, "identifier must be the task's, e.g. PEN-7");
    if (kernel) {
      if (typeof kernelToken !== "string" || !kernelToken.startsWith("ahqj_") || /\s/.test(kernelToken) || typeof kernelMcp !== "string") throw fail(400, "the kernel sends the job's token and its MCP config");
      if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string")) throw fail(400, "the kernel sends the job's frozen roles");
    } else if (!Number.isInteger(helperPort) || helperPort < 1 || helperPort > 65535 || !HELPER_TOKEN.test(String(helperToken))) throw fail(400, "helperPort and helperToken required");
    // The job's engine (engine@1): a kind the compiled registry says runs in a box, its module mounted read-only.
    const entry = (() => { try { return readJson(path.join(configDir, "engines.json"))[engine]; } catch { return undefined; } })();
    if (typeof engine !== "string" || entry?.box !== true || !/^modules\/[a-z0-9-]+$/.test(entry.dir ?? "")) throw fail(400, `engine ${engine} doesn't run in a box (config/engines.json)`);
    const image = kernel ? await imageNamed(imageName) : await imageFor(agentId);
    // Exactly this task's folder and its engine's state folder, real directories with no symlink below the runner's dirs:
    // never the cache clones, another task's folder or anything a path trick reaches. A kernel job's state is its agent's
    // on this task (kernel/src/sandbox.ts engineState), so two agents never share one.
    jobFolder(workspace, path.join(CFG.runnerWork, "tasks"), identifier);
    jobFolder(state, path.join(CFG.runnerState, engine), (kernel ? `${agentId}/${issueId}` : issueId).replace(/[^\w.-]/g, "_"));
    const codexHome = state;
    // Two executions never share a workspace: the task's last box must be gone first (the runner releases it).
    const before = jobs.byIssue(issueId);
    if (before) throw fail(409, `the task's last box ${before.container} is still up: release it first`);
    await makeRoom();
    const name = newName();
    boxes.set(name, { agentId, lastUsed: Date.now(), busy: 1 }); // reserve the slot while starting
    jobs.add({ container: name, agentId, issueId, identifier, workspace, codexHome, ...(kernel ? { kernel: true, tokenHash: tokenHash(kernelToken), roles } : { helperPort, helperToken }) }); saveJobs();
    // A kernel job's only credential is the kernel's job token; a runner job gets a run token bound to its task.
    const token = kernel ? kernelToken : tokens.issue(name, agentId);
    if (!kernel) {
      tokens.bind(name, { issueId }); // the model gateway bills and caps the job by its task
      saveTokens();
    }
    const envFile = path.join(jobEnvDir, `${name}.env`);
    // The job's last message lands here, outside the workspace: a folder of the launcher's, mounted at /aidenhq-out.
    const outDir = path.join(jobEnvDir, name);
    try {
      mkdirSync(outDir, { mode: 0o700 });
      const mounts = jobMounts({ resolvConf, workspace, outDir, codexHome, runnerWork: CFG.runnerWork, repo, engineDir: entry.dir });
      // aidenhq-browse uses the image's own agent-browser and Chrome (the browser image every computer builds on).
      const r = await docker(dockerRunArgs({ name, image, agentId, network: CFG.network, limits: { ...CFG.limits, memory: CFG.jobMemory }, mounts, user: JOB_USER, labels: [`aidenhq.job=${issueId}`], home: JOB_HOME }));
      if (r.exitCode !== 0) throw fail(500, `docker run failed: ${r.stderr.trim()}`);
      writeFileSync(envFile, jobEnvFile({ token, mcp: kernel ? kernelMcp : await mcpFor(token), gatewayUrl: GATEWAY_URL, identity }), { mode: 0o600 });
    } catch (e) {
      await destroy(name, "job box failed to start");
      throw e;
    }
    boxes.get(name).busy = 0;
    return { container: name, envFile, outDir };
  },
  async "/job/renew"({ container, issueId, helperPort, helperToken }, { kernel = false } = {}) {
    if (!ours(container)) throw fail(400, "not a computer");
    if (jobs.has(container) && Boolean(jobs.get(container).kernel) !== kernel) throw fail(403, `not your job's box: ${container}`);
    if (helperPort != null && (!Number.isInteger(helperPort) || !HELPER_TOKEN.test(String(helperToken)))) throw fail(400, "bad helper binding");
    if ((await jobState(container)) === "missing") {
      if (jobs.has(container)) await destroy(container, "gone before its renewal");
      throw fail(404, `box gone: ${container}`);
    }
    const r = jobs.renew(container, { issueId, helperPort, helperToken });
    if (!r) throw fail(404, `no live job ${container} for that task (its lease lapsed, or it is another task's)`);
    saveJobs();
    return { container, issueId: r.issueId, identifier: r.identifier, workspace: r.workspace, leaseUntil: r.leaseUntil };
  },
  async "/job/release"({ container }, { kernel = false } = {}) {
    if (!ours(container)) throw fail(400, "not a computer");
    if (!jobs.has(container) && boxes.has(container)) throw fail(403, `not a job's box: ${container}`);
    if (jobs.has(container) && Boolean(jobs.get(container).kernel) !== kernel) throw fail(403, `not your job's box: ${container}`);
    if (jobs.has(container) || (await jobState(container)) !== "missing") await destroy(container, kernel ? "released (kernel job)" : "released (runner job)");
    return { state: await jobState(container) };
  },
};

/**
 * POST /cp from the kernel: one control-plane call as a computer's run, whose credential works only inside its box (Paperclip's
 * bridge). The kernel has already checked the path against its agent routes; the run token names the box.
 */
async function cp(req, raw) {
  const who = tokens.whoami(bearer(req));
  if (!who) return { status: 401, body: { error: "unknown run token" } };
  let p;
  try { p = JSON.parse(raw || "{}"); } catch { return { status: 400, body: { error: "bad json" } }; }
  const b = boxes.get(who.container);
  if (!b?.cred) return { status: 409, body: { error: "this run has no control-plane credential yet (no exec from Paperclip)" } };
  if (!/^[A-Z]{3,6}$/.test(String(p.method)) || typeof p.path !== "string" || !p.path.startsWith("/api/")) return { status: 400, body: { error: "send {method, path: /api/..., body?}" } };
  const r = await docker(["exec", "-i", who.container, "node", "-e", CP_SCRIPT], { stdin: JSON.stringify({ url: b.cred.apiUrl, key: b.cred.apiKey, method: p.method, path: p.path, body: p.body }), timeoutMs: 60_000 });
  try { return { status: 200, body: JSON.parse(r.stdout.trim().split("\n").pop()) }; } catch { return { status: 502, body: { error: `the box answered ${(r.stderr || r.stdout).trim().slice(0, 200)}` } }; }
}

/**
 * `repo-checkout <org/name> <sha>` from a box: `git archive` of that commit in the runner's cache clone, streamed into the
 * calling box (its own run token names it). Read-only on the cache: a commit it doesn't have yet is refused, never fetched.
 */
async function checkout(who, raw) {
  if (!mayCheckout(who, readJson(CFG.grantsFile))) throw fail(403, "repo-checkout needs the repo-checkout role");
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
  if (req.method === "GET" && req.url === "/whoami") {
    const who = tokens.whoami(bearer(req));
    return who ? send(res, 200, { agentId: who.agentId, runId: who.runId, issueId: who.issueId }) : send(res, 401, { error: "unknown run token" });
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    if (req.method === "POST" && req.url === "/cp") return cp(req, body).then((r) => send(res, r.status, r.body));
    // The board's progress key opens /progress only, the runner's key the job routes only; the rest needs the plugin's key.
    if (!controlAllowed(bearer(req), req.method, req.url, { plugin: TOKEN, runner: RUNNER_KEY, kernel: KERNEL_KEY, progress: PROGRESS_TOKEN })) return send(res, 401, { error: "unauthorized" });
    const byKernel = Boolean(KERNEL_KEY) && bearer(req) === KERNEL_KEY;
    const fn = JOB_ROUTES.includes(req.url) ? runnerControl[req.url] : req.method === "POST" && Object.hasOwn(control, req.url.slice(1)) ? control[req.url.slice(1)] : null;
    if (!fn) return send(res, 404, { error: "no such route" });
    const t0 = Date.now();
    if (req.url === "/exec" || req.url === "/attach") {
      // The agent's whole turn: answer at once and keep the line busy (see answerSlowly).
      let p;
      try { p = JSON.parse(body || "{}"); } catch { return send(res, 400, { error: "invalid JSON" }); }
      return answerSlowly(res, fn(p).then((out) => {
        if (out.exitCode !== 0 || DEBUG) log(req.url, p.container ?? "", `${p.command} ${(p.args ?? []).join(" ").slice(0, 60)}`, `${Date.now() - t0}ms`, out.exitCode ?? "");
        return out;
      }, (e) => (log(req.url, "ERROR", e.message), Promise.reject(e))));
    }
    try {
      const p = JSON.parse(body || "{}");
      const out = await fn(p, { kernel: byKernel });
      if (req.url === "/progress" ? DEBUG : req.url !== "/exec" || out.exitCode !== 0 || DEBUG) log(req.url, p.container ?? p.agentId ?? "", p.command ? `${p.command} ${(p.args ?? []).join(" ").slice(0, 60)}` : "", `${Date.now() - t0}ms`, out.exitCode ?? out.state ?? out.container ?? "");
      send(res, 200, out);
    } catch (e) {
      log(req.url, "ERROR", e.message);
      send(res, e.status ?? 500, { error: e.message });
    }
  });
});

// ------------------------------------------------------------------ gateway (boxes only)

/** The live box a box-side credential is: a run token of ours, or a kernel job's token for the box made for it. */
const liveBox = (token) => tokens.whoami(token) ?? jobs.byKernelToken(token);

const gatewayServer = http.createServer(async (req, res) => {
  const deny = (status, msg) => { log("gateway", req.method, req.url, status, msg); res.writeHead(status, { "content-type": "text/plain" }).end(`gateway: ${msg}`); };
  try {
    // A runner job's `aidenhq` commands, to the helper its run token is bound to (lib.mjs serveHelper).
    if (req.url?.startsWith("/helper/")) return await serveHelper(req, res, { tokens, jobs });
    if (req.method === "POST" && req.url === "/api/v1/responses") {
      // The model: the box's "API key" is its run token; the model gateway, not a box or the launcher, holds the real key.
      const token = bearer(req);
      const who = liveBox(token);
      if (!who) return deny(401, "not a live computer");
      boxes.get(who.container) && (boxes.get(who.container).lastUsed = Date.now());
      return await forwardModel(req, res, `${MODEL_GATEWAY_URL}/api/v1/responses`, token);
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
      if (!jobs.byKernelToken(token)) return deny(401, "not a kernel job's computer");
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
    // The kernel's proxy decides: the run token is the caller (it asks /whoami here); only MCP transport headers go on.
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

const existing = await docker(["ps", "-a", "--filter", "label=aidenhq.computer=1", "--format", '{{.Names}} {{.Label "aidenhq.agent"}} {{.Label "aidenhq.job"}}']);
const orphans = [];
for (const line of existing.stdout.trim().split("\n").filter(Boolean)) {
  const [name, agentId, job] = line.split(" ");
  if (!ours(name) || !agentId) continue;
  boxes.set(name, { agentId, lastUsed: Date.now(), busy: 0 });
  // A runner job's box without its record has lost its binding: nothing may run in it.
  if (job && !jobs.has(name)) orphans.push(name);
}
// A job record whose box is gone never comes back; its lease and helper binding go with it.
for (const name of jobs.containers()) if (!boxes.has(name)) jobs.delete(name);
saveJobs();
// A saved token whose computer is gone never comes back.
for (const t of tokens.dump()) if (!boxes.has(t.container)) tokens.revoke(t.container);
saveTokens();
// A saved credential whose computer is gone never comes back either.
for (const c of creds.dump()) if (!boxes.has(c.container) || !tokens.current(c.container)) creds.delete(c.container);
saveCreds();
for (const name of orphans) await destroy(name, "a runner job's box without its record");
// A box from before the restart keeps its turn (a detached exec runs on): /cp answers from the saved credential again.
for (const [name, b] of boxes) { const cred = creds.get(name); if (cred) b.cred = cred; }
// A box from before the restart keeps its run: put the saved token back where its shell tools read it (Paperclip's boxes;
// a runner job's token is in its env file).
for (const name of boxes.keys()) { const token = tokens.current(name); if (token && !jobs.has(name)) await writeRunToken(name, token).catch((e) => log("couldn't restore a run token:", name, e.message)); }
if (boxes.size) log(`found ${boxes.size} computer(s) from before (${jobs.containers().length} runner job(s))`);
// Listen only now: an /exec answered before the boxes from before are known says "computer gone" to a live run (2026-11-13).
controlServer.listen(CFG.control.port, CFG.control.host, () => log(`launcher on ${CFG.control.host}:${CFG.control.port}`));
gatewayServer.listen(CFG.gateway.port, CFG.gateway.host, () => log(`gateway on ${CFG.gateway.host}:${CFG.gateway.port}`));
// Idle boxes go; a leased job's never does. A lapsed lease (the runner gone 15 minutes) takes its box and token.
setInterval(() => {
  const lapsed = reapLapsed(jobs, tokens);
  if (lapsed.length) { saveJobs(); saveTokens(); }
  for (const n of lapsed) destroy(n, "lease lapsed");
  for (const n of stale(boxes, CFG.idleMs, Date.now(), held)) destroy(n, "idle");
}, 60_000).unref();

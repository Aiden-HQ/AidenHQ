#!/usr/bin/env node
// The computer launcher: runs on the host as the AidenHQ user (docker group), systemd user unit aidenhq-computers.
//
// Control API, on the backplane gateway (the plugin in paperclip calls it; bearer = secret computer_launcher_token):
//   POST /acquire {agentId}   a fresh gVisor box for this agent's run; image, limits and mounts from config, never the caller
//   POST /resume {container}  the same box for the next run of the same task (Paperclip scopes reuse); a new run token
//   POST /exec {container, command, args, cwd, env, stdin, timeoutMs}
//   POST /release {container, destroy}   the run ended: its token is revoked (destroy: the box goes too)
//   POST /inspect {container}
//   POST /progress {agentId}  the tail of that agent's Codex session log from its live box → {lines} (the board's live view)
//   GET /health (no auth)     GET /whoami (Bearer <run token>) → {agentId, runId, issueId}: connections and the model gateway
//                             resolve run tokens here (runId, issueId: the Paperclip run and task the token's first exec named)
//   POST /reply {issueId, body} (Bearer <run token>): a comment on the run's own task, posted inside the box through Paperclip's
//                             bridge with the run's own credential (notify_owner from a computer; slack-live calls it)
// Gateway, on the computers network gateway (only boxes reach it; ops/vm/computer-net.sh):
//   POST /api/v1/responses    model calls: the "API key" must be a live run token; passed on to the model gateway
//                             (services/gateway, which counts and caps them like every agent's) with that token
//   /c/<connection>/mcp       tool calls to a connection: X-Agent-Key must be a live run token; the service's bearer is added here
//   POST /repo {repo, sha}    the box's `repo-checkout`: a snapshot (no .git, no credentials) of an agents-org repo at a commit,
//                             from the runner's cache clone, into /workspace/repos/<name>; agents with the repo-checkout role
//   POST /helper/<command>  a runner job box's `aidenhq` command (bearer = its run token), to the runner's helper bound to that job
//   POST /board/internal/grades/<task>/gate   the tasks bridge's completion gate (graded done), passed to the board with
//                             the run token as the caller and the internal token added here; no other board route
//
// Runner jobs (the runner calls these; bearer = secret computers_runner_key, which opens nothing else and which the plugin's
// key can't open). A job's process runs in the box through the runner's own `docker exec`; the runner keeps workspace and git.
//   POST /job {agentId, issueId, identifier, helperPort, helperToken, identity}   a box for one turn of a runner job: image
//                             from the grants table, the task folder and Codex home the launcher derives, a lease, a run token
//                             bound to the task → {container, envFile}
//   POST /job/renew {container, issueId, helperPort, helperToken}   the runner still follows it (also on adoption): a new lease
//   POST /job/release {container}   destroy and revoke; idempotent → {state} ("missing" once the box is gone)
//
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerSlowly, archiveArgs, forwardModel, PROGRESS_SCRIPT, REPLY_SCRIPT, UNTAR_SCRIPT, WRITE_RUN_TOKEN_SCRIPT, CLEAR_RUN_TOKEN_SCRIPT, boxOf, checkoutRequest, Tokens, Jobs, JOB_HOME, JOB_ROUTES, admit, controlAllowed, jobEnvFile, jobFolder, reapLapsed, serveHelper, builtImage, dockerRunArgs, execEnv, mcpBlock, replyRefusal, runCredential, stale, wrapExec, routineArgs } from "./lib.mjs";

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
  control: { host: env("AIDENHQ_LAUNCHER_HOST", "10.231.0.1"), port: Number(env("AIDENHQ_LAUNCHER_PORT", 8199)) },
  gateway: { host: env("AIDENHQ_GATEWAY_HOST", "10.231.2.1"), port: Number(env("AIDENHQ_GATEWAY_PORT", 8200)) },
  network: env("AIDENHQ_COMPUTERS_NETWORK", "aidenhq-computers"),
  prefix: env("AIDENHQ_COMPUTERS_PREFIX", "aidenhq-computer-"),
  // 7: the 5 Paperclip computer agents' max_parallel plus the App Engineer's 2 (2026-11-13, a 15 GB host with no swap).
  max: Number(env("AIDENHQ_COMPUTERS_MAX", 7)),
  idleMs: Number(env("AIDENHQ_COMPUTERS_IDLE_MIN", 10)) * 60_000,
  limits: { memory: env("AIDENHQ_COMPUTERS_MEMORY", "2g"), cpus: Number(env("AIDENHQ_COMPUTERS_CPUS", 2)), shm: "512m", pids: 1024 },
  grantsFile: path.join(configDir, "grants", "grants.json"),
  catalogFile: path.join(path.resolve(repo, env("AIDENHQ_DATA_DIR", "data")), "paperclip", "catalog.static.json"),
  computersFile: env("AIDENHQ_COMPUTERS_FILE", path.join(configDir, "computers.json")),
  composeProject: env("COMPOSE_PROJECT_NAME", "aidenhq"),
  // The runner's work and state dirs (services/runner/src/config.mjs: work_dir and state_dir in config/runner.yaml): its cache
  // clones, and for runner jobs the task folders, the clones' guard hooks and the per-task Codex homes.
  runnerWork: runnerDir("work_dir", "~/aidenhq-work"),
  runnerState: runnerDir("state_dir", "~/.local/state/aidenhq-runner"),
  // A runner job's box: its own memory limit (the pool's RAM: docs/design/sandboxing.md, launcher pool).
  jobMemory: env("AIDENHQ_COMPUTERS_JOB_MEMORY", "1536m"),
};
CFG.runnerRepos = path.join(CFG.runnerWork, "repos");
function runnerDir(key, fallback) {
  let dir = fallback;
  try { dir = new RegExp(`^${key}:\\s*["']?([^"'#\\n]+?)["']?\\s*(#.*)?$`, "m").exec(readFileSync(path.join(configDir, "runner.yaml"), "utf8"))?.[1] ?? dir; } catch {}
  return dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}
const GATEWAY_URL = `http://${CFG.gateway.host}:${CFG.gateway.port}`;
// The model gateway on host loopback (services/gateway): every box's model call goes on to it.
const MODEL_GATEWAY_URL = env("AIDENHQ_MODEL_GATEWAY_URL", "http://127.0.0.1:8201");
const TOKEN = secret("computer_launcher_token");
const PROGRESS_TOKEN = secret("computer_progress_token");
// The runner's key: the job routes only. Unset, runner jobs are off (every /job call is refused).
const RUNNER_KEY = secret("computers_runner_key");
if (!TOKEN) throw new Error("the secret computer_launcher_token is missing (scripts/compile.mjs creates it)");

// Docker's embedded DNS (127.0.0.11) relies on iptables inside the netns, which gVisor's netstack never sees.
const stateDir = path.join(os.homedir(), ".local/state/aidenhq-computers");
mkdirSync(stateDir, { recursive: true });
const resolvConf = path.join(stateDir, "resolv.conf");
writeFileSync(resolvConf, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
const MOUNTS = [
  `${resolvConf}:/etc/resolv.conf:ro`,
  // The tasks bridge (stdio MCP, through Paperclip's own bridge) and the grants table it checks; no secrets. File by file:
  // a mount of the whole folder at /opt/aidenhq would hide the image's own /opt/aidenhq (app-starter, design-system).
  ...readdirSync(path.join(repo, "services/paperclip-tasks-mcp")).map((f) => `${path.join(repo, "services/paperclip-tasks-mcp", f)}:/opt/aidenhq/${f}:ro`),
  `${path.dirname(CFG.grantsFile)}:/aidenhq-grants:ro`,
  // fleet_catalog's static half (agents, tools, modules; no secrets): the one file, never the data dir around it.
  ...(existsSync(CFG.catalogFile) ? [`${CFG.catalogFile}:/paperclip/catalog.static.json:ro`] : []),
];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const DEBUG = env("AIDENHQ_COMPUTERS_DEBUG") === "1"; // log every exec, with its env keys (never values)
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const tokens = new Tokens();
// Run tokens survive a launcher restart (a running box keeps its token in its env): a 0600 file, rewritten on every change.
const tokensFile = path.join(stateDir, "run-tokens.json");
try { tokens.load(readJson(tokensFile)); } catch {}
// Written whole then renamed, so a crash never leaves a half file.
const saveTokens = () => { try { writeFileSync(`${tokensFile}.tmp`, JSON.stringify(tokens.dump()), { mode: 0o600 }); renameSync(`${tokensFile}.tmp`, tokensFile); } catch (e) { log("couldn't save run tokens:", e.message); } };
const boxes = new Map(); // container → { agentId, lastUsed, busy, cred? } (cred: the current run's Paperclip credential, for /reply)
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

/** The image this agent's computer runs: the grants table setup writes (agent id → image) and compile's tags. Never the caller. */
async function imageFor(agentId) {
  const g = readJson(CFG.grantsFile).agents?.[agentId];
  if (!g?.image) throw fail(403, `agent ${agentId} has no computer (no image: in its definition)`);
  const tag = readJson(CFG.computersFile).images?.[g.image];
  if (!tag) throw fail(500, `image ${g.image} has no tag in computers.json (run scripts/compile.mjs and ops/computer-images.sh)`);
  return builtImage(tag, docker, log);
}
const mcpFor = (agentId) => mcpBlock(readJson(CFG.grantsFile).agents?.[agentId]?.tools, readJson(CFG.computersFile).connections ?? {}, GATEWAY_URL);

/** A free slot for a new box: the least recently used idle box goes (never a leased job's); all busy → wait up to 45 s. */
async function makeRoom() {
  for (let waited = 0; ; waited += 1000) {
    const evict = admit(boxes, CFG.max, held);
    if (evict === null) return;
    if (evict !== "wait") return destroy(evict, "evicted (computers full)");
    if (waited >= 45_000) throw fail(503, `all ${CFG.max} computers are busy; try again shortly`);
    await new Promise((r) => setTimeout(r, 1000));
  }
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
  async exec({ container, command, args = [], cwd, env: e = {}, stdin, timeoutMs }) {
    const b = boxes.get(container);
    if (!ours(container) || !b) throw fail(404, `computer gone: ${container}`);
    pluginBox(container);
    const token = tokens.current(container);
    if (token) await writeRunToken(container, token); // a launcher restart, or a box from before this code, still gets it
    const cred = token && runCredential(e);
    if (cred) b.cred = cred;
    // The run's token names its Paperclip run and task from here on: the model gateway attributes and caps by them.
    if (cred && tokens.bind(container, { runId: e.PAPERCLIP_RUN_ID, issueId: cred.taskId })) saveTokens();
    const xenv = execEnv(e, { token, mcp: e.CODEX_HOME && token ? mcpFor(b.agentId) : undefined });
    const [cmd, cargs] = wrapExec(command, routineArgs(command, args, e), xenv);
    if (DEBUG) log("exec env keys", container, Object.keys(xenv).sort().join(","));
    // Env through a 0600 file so values never show in the host's process list; multi-line values can't go that way.
    const dir = mkdtempSync(path.join(os.tmpdir(), "aidenhq-exec-"));
    const f = path.join(dir, "env");
    writeFileSync(f, Object.entries(xenv).filter(([, v]) => !v.includes("\n")).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    b.busy++;
    b.lastUsed = Date.now();
    try {
      return await docker(["exec", "-i", ...(cwd ? ["-w", cwd] : []), "--env-file", f, container, cmd, ...cargs], { stdin, timeoutMs });
    } finally {
      b.busy--;
      b.lastUsed = Date.now();
      rmSync(dir, { recursive: true, force: true });
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
  async "/job"({ agentId, issueId, identifier, workspace, codexHome, helperPort, helperToken, identity }) {
    if (typeof agentId !== "string" || !agentId || typeof issueId !== "string" || !issueId) throw fail(400, "agentId and issueId required");
    if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) throw fail(400, "identifier must be the task's, e.g. PEN-7");
    if (!Number.isInteger(helperPort) || helperPort < 1 || helperPort > 65535 || !HELPER_TOKEN.test(String(helperToken))) throw fail(400, "helperPort and helperToken required");
    const image = await imageFor(agentId);
    // Exactly this task's folder and Codex home, real directories with no symlink below the runner's dirs: never the cache
    // clones, another task's folder or anything a path trick reaches.
    jobFolder(workspace, path.join(CFG.runnerWork, "tasks"), identifier);
    jobFolder(codexHome, path.join(CFG.runnerState, "codex-openrouter"), issueId.replace(/[^\w.-]/g, "_"));
    // Two executions never share a workspace: the task's last box must be gone first (the runner releases it).
    const before = jobs.byIssue(issueId);
    if (before) throw fail(409, `the task's last box ${before.container} is still up: release it first`);
    await makeRoom();
    const name = newName();
    boxes.set(name, { agentId, lastUsed: Date.now(), busy: 1 }); // reserve the slot while starting
    jobs.add({ container: name, agentId, issueId, identifier, workspace, codexHome, helperPort, helperToken }); saveJobs();
    const token = tokens.issue(name, agentId);
    tokens.bind(name, { issueId }); // the model gateway bills and caps the job by its task
    saveTokens();
    const envFile = path.join(jobEnvDir, `${name}.env`);
    // The job's last message lands here, outside the workspace: a folder of the launcher's, mounted at /aidenhq-out.
    const outDir = path.join(jobEnvDir, name);
    try {
      mkdirSync(outDir, { mode: 0o700 });
      const mounts = [`${resolvConf}:/etc/resolv.conf:ro`, `${workspace}:/workspace`, `${outDir}:/aidenhq-out`, `${codexHome}:/codex-home`, `${path.join(CFG.runnerWork, ".guard-hooks")}:/opt/aidenhq/hooks:ro`, `${path.join(repo, "services/runner/bin")}:/opt/aidenhq/bin:ro`];
      // aidenhq-browse uses the image's own agent-browser and Chrome (the browser image every computer builds on).
      const r = await docker(dockerRunArgs({ name, image, agentId, network: CFG.network, limits: { ...CFG.limits, memory: CFG.jobMemory }, mounts, user: JOB_USER, labels: [`aidenhq.job=${issueId}`], home: JOB_HOME }));
      if (r.exitCode !== 0) throw fail(500, `docker run failed: ${r.stderr.trim()}`);
      writeFileSync(envFile, jobEnvFile({ token, mcp: mcpFor(agentId), gatewayUrl: GATEWAY_URL, identity }), { mode: 0o600 });
    } catch (e) {
      await destroy(name, "job box failed to start");
      throw e;
    }
    boxes.get(name).busy = 0;
    return { container: name, envFile, outDir };
  },
  async "/job/renew"({ container, issueId, helperPort, helperToken }) {
    if (!ours(container)) throw fail(400, "not a computer");
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
  async "/job/release"({ container }) {
    if (!ours(container)) throw fail(400, "not a computer");
    if (!jobs.has(container) && boxes.has(container)) throw fail(403, `not a runner job's box: ${container}`);
    if (jobs.has(container) || (await jobState(container)) !== "missing") await destroy(container, "released (runner job)");
    return { state: await jobState(container) };
  },
};

/**
 * notify_owner(task) from a computer: the agent's key is a run token, which Paperclip doesn't know. The reply is posted inside the
 * run's box through Paperclip's own bridge with the run's credential (the author is the agent and its run), on its own task only.
 */
async function reply(req, raw) {
  const who = tokens.whoami(bearer(req));
  if (!who) return { status: 401, body: { error: "unknown run token" } };
  let p;
  try { p = JSON.parse(raw || "{}"); } catch { return { status: 400, body: { error: "bad json" } }; }
  const b = boxes.get(who.container);
  const why = replyRefusal(b?.cred, p.issueId, p.body);
  if (why) { log("/reply", who.container, "refused:", why); return { status: 403, body: { error: why } }; }
  const t0 = Date.now();
  const r = await docker(["exec", "-i", who.container, "node", "-e", REPLY_SCRIPT], { stdin: JSON.stringify({ url: b.cred.apiUrl, key: b.cred.apiKey, issueId: p.issueId, body: p.body }), timeoutMs: 30_000 });
  const out = r.stdout.trim() || r.stderr.trim().slice(0, 200) || "nothing";
  log("/reply", who.container, p.issueId, `${Date.now() - t0}ms`, out);
  return r.exitCode === 0 ? { status: 200, body: { ok: true } } : { status: 502, body: { error: `the bridge answered ${out}` } };
}

/**
 * `repo-checkout <org/name> <sha>` from a box: `git archive` of that commit in the runner's cache clone, streamed into the
 * calling box (its own run token names it). Read-only on the cache: a commit it doesn't have yet is refused, never fetched.
 */
async function checkout(who, raw) {
  const grant = readJson(CFG.grantsFile).agents?.[who.agentId];
  if (!grant?.roles?.includes("repo-checkout")) throw fail(403, "repo-checkout needs the repo-checkout role");
  let p;
  try { p = JSON.parse(raw || "{}"); } catch { throw fail(400, "bad json"); }
  let { cache, sha, dest } = checkoutRequest(p, { agentsOrg: readJson(CFG.computersFile).agents_org, cacheRoot: CFG.runnerRepos });
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

/**
 * POST /board/internal/grades/<task>/gate from a box: graded done's completion gate, the only board route a box reaches. The
 * run token (X-Agent-Key) must be live; it goes on as the caller's identity (the board asks /whoami), with the board's internal
 * token added here. Nothing else from the request is forwarded.
 */
const BOARD_INTERNAL_URL = env("BOARD_INTERNAL_URL", "http://127.0.0.1:3122");
async function boardGate(req, res, route, deny) {
  const token = String(req.headers["x-agent-key"] ?? "");
  if (!tokens.whoami(token)) return deny(401, "not a live computer");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const up = await fetch(`${BOARD_INTERNAL_URL}${route}`, { method: "POST", headers: { authorization: `Bearer ${secret("board_internal_token")}`, "x-agent-key": token, "content-type": "application/json" }, body: Buffer.concat(chunks).toString("utf8").slice(0, 4096), signal: AbortSignal.timeout(30_000) });
  res.writeHead(up.status, { "content-type": "application/json" }).end(await up.text());
}

const bearer = (req) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const controlServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, computers: boxes.size, max: CFG.max });
  if (req.method === "GET" && req.url === "/whoami") {
    const who = tokens.whoami(bearer(req));
    return who ? send(res, 200, { agentId: who.agentId, runId: who.runId, issueId: who.issueId }) : send(res, 401, { error: "unknown run token" });
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    if (req.method === "POST" && req.url === "/reply") return reply(req, body).then((r) => send(res, r.status, r.body));
    // The board's progress key opens /progress only, the runner's key the job routes only; the rest needs the plugin's key.
    if (!controlAllowed(bearer(req), req.method, req.url, { plugin: TOKEN, runner: RUNNER_KEY, progress: PROGRESS_TOKEN })) return send(res, 401, { error: "unauthorized" });
    const fn = JOB_ROUTES.includes(req.url) ? runnerControl[req.url] : req.method === "POST" && Object.hasOwn(control, req.url.slice(1)) ? control[req.url.slice(1)] : null;
    if (!fn) return send(res, 404, { error: "no such route" });
    const t0 = Date.now();
    if (req.url === "/exec") {
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
      const out = await fn(p);
      if (req.url === "/progress" ? DEBUG : req.url !== "/exec" || out.exitCode !== 0 || DEBUG) log(req.url, p.container ?? p.agentId ?? "", p.command ? `${p.command} ${(p.args ?? []).join(" ").slice(0, 60)}` : "", `${Date.now() - t0}ms`, out.exitCode ?? out.state ?? out.container ?? "");
      send(res, 200, out);
    } catch (e) {
      log(req.url, "ERROR", e.message);
      send(res, e.status ?? 500, { error: e.message });
    }
  });
});

// ------------------------------------------------------------------ gateway (boxes only)

const upstreamIps = new Map(); // service host → { ip, at }
async function upstream(urlStr) {
  const u = new URL(urlStr);
  const hit = upstreamIps.get(u.hostname);
  if (!hit || Date.now() - hit.at > 60_000) {
    const r = await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${CFG.composeProject}_backplane").IPAddress}}`, `${CFG.composeProject}-${u.hostname}-1`]);
    const ip = r.stdout.trim();
    if (r.exitCode !== 0 || !/^[0-9.]+$/.test(ip)) throw new Error(`connection service ${u.hostname} isn't running`);
    upstreamIps.set(u.hostname, { ip, at: Date.now() });
  }
  return { ip: upstreamIps.get(u.hostname).ip, port: Number(u.port || 80), path: u.pathname };
}

const gatewayServer = http.createServer(async (req, res) => {
  const deny = (status, msg) => { log("gateway", req.method, req.url, status, msg); res.writeHead(status, { "content-type": "text/plain" }).end(`gateway: ${msg}`); };
  try {
    // A runner job's `aidenhq` commands, to the helper its run token is bound to (lib.mjs serveHelper).
    if (req.url?.startsWith("/helper/")) return await serveHelper(req, res, { tokens, jobs });
    if (req.method === "POST" && req.url === "/api/v1/responses") {
      // The model: the box's "API key" is its run token; the model gateway, not a box or the launcher, holds the real key.
      const token = bearer(req);
      const who = tokens.whoami(token);
      if (!who) return deny(401, "not a live computer");
      boxes.get(who.container) && (boxes.get(who.container).lastUsed = Date.now());
      return await forwardModel(req, res, `${MODEL_GATEWAY_URL}/api/v1/responses`, token);
    }
    if (req.method === "POST" && req.url === "/repo") {
      const who = tokens.whoami(String(req.headers["x-agent-key"] ?? ""));
      if (!who) return deny(401, "not a live computer");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return checkout(who, Buffer.concat(chunks).toString("utf8").slice(0, 4096)).then(
        (out) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out)),
        (e) => deny(e.status ?? 500, e.message),
      );
    }
    const g = req.method === "POST" ? /^\/board(\/internal\/grades\/[A-Za-z0-9-]{1,64}\/gate)$/.exec(req.url) : null;
    if (g) return await boardGate(req, res, g[1], deny);
    const m = /^\/c\/([a-z0-9_]+)\/mcp$/.exec(req.url.split("?")[0]);
    if (!m) return deny(403, "refused");
    const conn = readJson(CFG.computersFile).connections?.[m[1]];
    if (!conn?.url) return deny(404, `no connection ${m[1]}`);
    const who = tokens.whoami(String(req.headers["x-agent-key"] ?? ""));
    if (!who) return deny(401, "not a live computer");
    const to = await upstream(conn.url);
    const headers = { ...req.headers, host: `${new URL(conn.url).host}` };
    delete headers.authorization;
    if (conn.bearer_secret) headers.authorization = `Bearer ${secret(conn.bearer_secret)}`;
    const up = http.request({ host: to.ip, port: to.port, path: to.path, method: req.method, headers }, (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); });
    up.on("error", (e) => { upstreamIps.delete(new URL(conn.url).hostname); if (!res.headersSent) deny(502, e.message); else res.destroy(); });
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
for (const name of orphans) await destroy(name, "a runner job's box without its record");
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

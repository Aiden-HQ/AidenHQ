#!/usr/bin/env node
// The computer launcher: runs on the host as the AidenHQ user (docker group), systemd user unit aidenhq-computers.
//
// Control API, on the backplane gateway:
//   POST /progress {agentId}  the tail of that agent's Codex session log from its live box → {lines} (the board's live view;
//                             bearer = secret computer_progress_token, which opens nothing else)
//   GET /health (no auth)
// Gateway, on the computers network gateway (only boxes reach it; ops/vm/computer-net.sh). A box's only credential is its
// kernel job's token (ahqj_), which the launcher knows by its hash (the job record):
//   POST /api/v1/responses | /api/v1/chat/completions | /api/v1/messages   model calls (messages: Claude Code's Anthropic format),
//                             passed on to the kernel's model gateway with that token
//   /c/<connection>/mcp       tool calls to a connection (X-Agent-Key = the job token), passed on to the kernel's proxy
//                             (aidenhq-kernel) with that token as the bearer: the kernel checks the grants and holds the keys
//   POST /repo {repo, sha}    the box's `repo-checkout`: the kernel's code host snapshot (no .git, no credentials) of an agents-org
//                             repo at a commit, into /workspace/repos/<name>; the kernel checks the repo-checkout role
//   POST /v1/writes, GET /v1/writes/<id>, POST /v1/jobtools/<cmd>  a kernel job box's `aidenhq` commands (bearer = its job token), on to the kernel as it
//
// Jobs (bearer = secret launcher_kernel_key, the kernel's; it opens nothing else).
// A job's process runs in the box through the kernel's own `docker exec`.
//   POST /job {job, agentId, issueId, identifier, workspace, engine, state, image, token, mcp, roles}   the kernel's (boxes.ts):
//                             the image its admission froze, its job token (ahqj_) as the box's only credential and the job's
//                             Codex MCP config → {container, envFile, outDir, gen}. The task's parked box when it fits the job
//                             (lib.ts compatKey), else a new one.
//   POST /job/renew {container, issueId, gen}   the kernel still follows it (also on adoption): a new lease
//   POST /job/release {container, gen?, destroy?}   the job is over: its token is revoked and its box parked for the task's
//                             next job (restarted, so nothing of the job runs on), or destroyed (`destroy`, a check's box, or
//                             parking failed); idempotent, and a release of an earlier lease touches nothing →
//                             {released, state} (state "missing" once the box is gone)
//   POST /check {check, image, workspace, out, readOnly, token?, timeoutMs}   the kernel's only: a box for one run of a check
//                             (kernel/src/checkjobs.ts), with only its snapshot and out folder → {container}; /job/release ends it
//
import http from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CHECK_MIN, WARM_MS, forwardModel, PROGRESS_SCRIPT, UNTAR_SCRIPT, boxOf, checkoutDest, compatKey, npmCacheDir, Jobs, tokenHash, JOB_HOME, JOB_ROUTES, CHECK_ROUTES, checkMounts, admit, controlAllowed, jobEnvFile, jobFolder, jobMounts, reapLapsed, builtImage, dockerRunArgs, stale, drainServers } from "./lib.ts";
import type { Box } from "./lib.ts";

type Failure = Error & { status?: number };

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dotenv: Record<string, string> = {};
if (existsSync(path.join(repo, ".env"))) {
  for (const line of readFileSync(path.join(repo, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) dotenv[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
const env = (k: string, d?: string | number) => (process.env[k] ?? dotenv[k] ?? d) as string; // undefined when unset and no default
const configDir = path.resolve(repo, env("AIDENHQ_CONFIG_DIR", "config"));
const secretsDir = env("AIDENHQ_SECRETS_DIR");
if (!secretsDir) throw new Error("AIDENHQ_SECRETS_DIR is not set (.env)");
const secret = (n: string) => { try { return readFileSync(path.join(secretsDir, n), "utf8").trim(); } catch { return ""; } };

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
// A fresh install enables this unit before the compile writes computers.json: wait for it quietly, no crash loop.
const computersJson = path.join(configDir, "computers.json");
if (!existsSync(computersJson)) {
  console.log(new Date().toISOString(), `${computersJson} isn't written yet; waiting for the compile`);
  while (!existsSync(computersJson)) await new Promise((r) => setTimeout(r, 1000));
}
const CFG = {
  control: { host: "10.231.0.1", port: 8199 },
  gateway: { host: "10.231.2.1", port: 8200 },
  network: "aidenhq-computers",
  prefix: "aidenhq-computer-",
  limits: { memory: env("AIDENHQ_COMPUTERS_MEMORY", "6g"), cpus: Number(env("AIDENHQ_COMPUTERS_CPUS", 2)), shm: "1g", pids: 1024 },
  computersFile: path.join(configDir, "computers.json"),
  composeProject: env("COMPOSE_PROJECT_NAME", "aidenhq"),
  // The host's work and state dirs (computers.json work_dir and state_dir, from config/runner.yaml at compile): the task
  // folders, the clones' guard hooks and the per-task Codex homes.
  runnerWork: readJson(path.join(configDir, "computers.json")).work_dir,
  runnerState: readJson(path.join(configDir, "computers.json")).state_dir,
};
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
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const DEBUG = env("AIDENHQ_COMPUTERS_DEBUG") === "1"; // log every exec, with its env keys (never values)
/** The pool's size: settings.computers_max plus settings.check_computers_max (compile writes both to computers.json; the kernel
 * admits agent jobs and check jobs each against its own). */
const maxBoxes = () => {
  const { max, checks } = readJson(CFG.computersFile);
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(checks) || checks < 1) throw fail(500, "computers.json has no max or checks (run scripts/compile.ts)");
  return max + checks;
};
const boxes = new Map<string, Box>(); // container → { agentId, lastUsed, busy }
// Jobs' records (lease, task, token hash), saved as a 0600 file: a restart reloads them before it admits or reaps.
const jobs = new Jobs();
const jobsFile = path.join(stateDir, "jobs.json");
try { jobs.load(readJson(jobsFile)); } catch {}
// A restart drains this launcher beside the next one (SIGUSR2, below): from then on the next one owns the jobs file.
let draining = false;
// Written whole then renamed, so a crash never leaves a half file.
const saveJobs = () => { if (draining) return; try { writeFileSync(`${jobsFile}.tmp`, JSON.stringify(jobs.dump()), { mode: 0o600 }); renameSync(`${jobsFile}.tmp`, jobsFile); } catch (e) { log("couldn't save jobs:", (e as Error).message); } };
const held = (name: string) => jobs.leased(name);
const jobEnvDir = path.join(stateDir, "jobs");
mkdirSync(jobEnvDir, { recursive: true, mode: 0o700 });

function docker(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}) {
  return new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }>((resolve) => {
    const c = spawn("docker", args, { stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const t = opts.timeoutMs! > 0 ? setTimeout(() => { timedOut = true; c.kill("SIGKILL"); }, opts.timeoutMs) : null;
    c.stdout!.on("data", (d) => (out += d));
    c.stderr!.on("data", (d) => (err += d));
    c.on("error", (e) => { if (t) clearTimeout(t); resolve({ exitCode: 1, signal: null, timedOut: false, stdout: out, stderr: e.message }); });
    c.on("close", (code, signal) => { if (t) clearTimeout(t); resolve({ exitCode: timedOut ? null : code, signal, timedOut, stdout: out, stderr: err }); });
    if (opts.stdin != null) c.stdin!.end(opts.stdin);
  });
}
// "missing" only when Docker says so: a daemon that doesn't answer is not a box that is gone (a job's release waits on this).
const jobState = async (name: string) => {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", name], { timeoutMs: 15_000 });
  if (r.exitCode === 0) return r.stdout.trim();
  return /no such (object|container)/i.test(r.stderr) ? "missing" : "unknown";
};
const ours = (name: unknown): name is string => typeof name === "string" && name.startsWith(CFG.prefix) && /^[a-z0-9-]+$/.test(name);
const fail = (status: number, msg: string) => Object.assign(new Error(msg), { status });

// A box Docker didn't remove keeps its records (it still holds a slot, never picked to evict) and is tried again every minute
// until it goes. Its token opens nothing from the start; while it is being removed it counts as busy, and every caller shares
// the one removal in flight.
const unremoved = new Set<string>();
const removing = new Map<string, Promise<boolean>>();
function destroy(name: string, why: string) {
  let p = removing.get(name);
  if (!p) {
    p = remove(name, why).finally(() => removing.delete(name));
    removing.set(name, p);
  }
  return p;
}
async function remove(name: string, why: string) {
  const b = boxes.get(name);
  if (b) b.busy++;
  const j = jobs.get(name);
  if (j?.tokenHash) { delete j.tokenHash; saveJobs(); }
  const r = await docker(["rm", "-f", name], { timeoutMs: 30_000 });
  if (r.exitCode !== 0 && (await jobState(name)) !== "missing") {
    if (b) b.busy--;
    unremoved.add(name);
    log("couldn't destroy", name, why, r.stderr.trim());
    return false;
  }
  unremoved.delete(name);
  boxes.delete(name);
  if (jobs.delete(name)) saveJobs();
  rmSync(path.join(jobEnvDir, `${name}.env`), { force: true });
  rmSync(path.join(jobEnvDir, name), { recursive: true, force: true });
  log("destroyed", name, why);
  return true;
}

/** A box that is not to be reused goes: retired first, so no lease picks it and the task's next job waits for its removal. */
function retire(name: string, why: string) {
  if (jobs.retire(name)) saveJobs();
  return destroy(name, why);
}

/**
 * What a released job left in its box's out folder goes (the folder itself is the box's mount, so it stays), off the event
 * loop. Throws unless the folder is then empty.
 */
const outTrash = path.join(stateDir, "trash");
function emptyOut(outDir: string) {
  mkdirSync(outTrash, { recursive: true, mode: 0o700 });
  for (const n of readdirSync(outDir)) {
    const to = path.join(outTrash, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    renameSync(path.join(outDir, n), to);
    void rm(to, { recursive: true, force: true }).catch(() => {});
  }
  if (readdirSync(outDir).length) throw new Error("its out folder isn't empty");
}

/**
 * The job is over: its token is revoked at once, and the box is parked for the task's next job. A restart ends every process
 * the job left in it (a stopped job's engine, a server it started) and keeps its mounts and files; the env file and the out
 * folder's contents go. Any step failing destroys the box instead. While it parks it is busy, and a lease waits for it.
 */
const parking = new Map<string, Promise<boolean>>();
function park(name: string) {
  let p = parking.get(name);
  if (!p) {
    p = (async () => {
      const b = boxes.get(name);
      if (b) b.busy++;
      jobs.revoke(name); saveJobs();
      try {
        rmSync(path.join(jobEnvDir, `${name}.env`), { force: true });
        // The restart first, so nothing of the job still writes while its out folder is cleared.
        const r = await docker(["restart", "-t", "0", name], { timeoutMs: 60_000 });
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `docker restart ${r.exitCode ?? r.signal}`);
        emptyOut(path.join(jobEnvDir, name));
        if (draining || !jobs.park(name)) throw new Error(draining ? "the launcher is restarting" : "its record went");
        saveJobs();
        log("parked", name);
        return true;
      } catch (e) {
        await retire(name, `couldn't be parked (${(e as Error).message})`);
        return false;
      } finally {
        if (b) { b.busy--; b.lastUsed = Date.now(); }
      }
    })().finally(() => parking.delete(name));
    parking.set(name, p);
  }
  return p;
}

/** A kernel job's image tag, by the name its admission froze: one compile tagged (computers.json). */
function imageTag(name: unknown): string {
  const tag = typeof name === "string" ? readJson(CFG.computersFile).images?.[name] : undefined;
  if (!tag) throw fail(400, `no computer image ${name} (computers.json)`);
  return tag;
}
const imageNamed = (name: unknown) => builtImage(imageTag(name), docker, log);
/**
 * A free slot for a new box: the least recently used idle box goes (never a leased job's; one Docker didn't remove, the next is
 * tried); all busy → wait. 45 s in all, so the kernel (120 s a call) is still waiting for the box this frees.
 */
async function makeRoom() {
  for (const end = Date.now() + 45_000; ;) {
    const max = maxBoxes();
    const evict = admit(boxes, max, (n) => held(n) || unremoved.has(n));
    if (evict === null) return;
    if (evict !== "wait" && (await retire(evict, "evicted (computers full)"))) return;
    if (Date.now() >= end) throw fail(503, `all ${max} computers are busy; try again shortly`);
    if (evict === "wait") await new Promise((r) => setTimeout(r, 1000));
  }
}
const newName = () => CFG.prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** The board's live line for an agent in its own computer: the tail of its Codex session log. */
async function progress({ agentId }: { agentId?: unknown }) {
  // Only a leased box runs a job: a parked one holds the last job's log, not live work.
  const box = typeof agentId === "string" ? boxOf(new Map([...boxes].filter(([n]) => held(n))), agentId) : undefined;
  if (!box) return { lines: [] };
  const r = await docker(["exec", box, "sh", "-c", PROGRESS_SCRIPT], { timeoutMs: 8000 });
  return { lines: r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : [] };
}

// A job's box: the launcher's uid (workspace files stay the host user's), a HOME outside every clone.
const JOB_USER = `${process.getuid!()}:${process.getgid!()}`;
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

/** The job and check routes (lib.ts controlAllowed). */
const jobControl = {
  async "/job"({ job, agentId, issueId, identifier, workspace, engine, state, identity, image: imageName, token, mcp, roles }: { job?: string; agentId: string; issueId: string; identifier: string; workspace: string; engine: string; state: string; identity?: { name?: unknown; email?: unknown; agent?: unknown }; image: unknown; token: string; mcp: string; roles: string[] }, { kernel = false }: { kernel?: boolean } = {}) {
    if (!kernel) throw fail(403, "job boxes are the kernel's");
    if (job !== undefined && (typeof job !== "string" || !job)) throw fail(400, "a job id is a string");
    if (typeof agentId !== "string" || !agentId || typeof issueId !== "string" || !issueId) throw fail(400, "agentId and issueId required");
    if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) throw fail(400, "identifier must be the task's, e.g. PEN-7");
    if (typeof token !== "string" || !token.startsWith("ahqj_") || /\s/.test(token) || typeof mcp !== "string") throw fail(400, "the kernel sends the job's token and its MCP config");
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string")) throw fail(400, "the kernel sends the job's frozen roles");
    // The job's engine (engine@1): a kind the compiled registry says runs in a box, its module mounted read-only.
    const entry = (() => { try { return readJson(path.join(configDir, "engines.json"))[engine]; } catch { return undefined; } })();
    if (typeof engine !== "string" || entry?.box !== true || !/^modules\/[a-z0-9-]+$/.test(entry.dir ?? "")) throw fail(400, `engine ${engine} doesn't run in a box (config/engines.json)`);
    const tag = imageTag(imageName);
    // Exactly this task's folder and its engine's state folder, real directories with no symlink below the work dirs: never
    // the cache clones, another task's folder or anything a path trick reaches. A job's state is its agent's on this task
    // (kernel/src/sandbox.ts engineState), so two agents never share one.
    jobFolder(workspace, path.join(CFG.runnerWork, "tasks"), identifier);
    jobFolder(state, path.join(CFG.runnerState, engine), `${agentId}/${issueId}`.replace(/[^\w.-]/g, "_"));
    const codexHome = state;
    const runArgs = (name: string, outDir: string) => dockerRunArgs({ name, image: tag, agentId, network: CFG.network, limits: CFG.limits, mounts: jobMounts({ resolvConf, workspace, outDir, codexHome, runnerWork: CFG.runnerWork, repo, engineDir: entry.dir, roles }), user: JOB_USER, labels: [`aidenhq.job=${issueId}`], home: JOB_HOME });
    const compat = compatKey(runArgs("", "/aidenhq-out"), [workspace, codexHome, npmCacheDir(CFG.runnerWork)]);
    const envText = jobEnvFile({ token, mcp, gatewayUrl: GATEWAY_URL, identity });
    // One box per task, leased to one job at a time. A box still parking is waited for; a box leased to a job is never shared.
    let before = jobs.byIssue(issueId);
    if (before && parking.has(before.container)) { await parking.get(before.container); before = jobs.byIssue(issueId); }
    // A box going (retired) holds the task until Docker has removed it; one Docker couldn't remove is still up.
    if (before?.retired) { await removing.get(before.container); before = jobs.byIssue(issueId); }
    if (before?.retired) throw fail(409, `the task's last box ${before.container} is still being removed`);
    // A record whose box is gone (a draining launcher gave it back) holds nothing: it goes.
    if (before && !before.parked && (await jobState(before.container)) === "missing") { await destroy(before.container, "gone before the task's next box"); before = undefined; }
    else if (before && !before.parked) throw fail(409, `the task's last box ${before.container} is still up: release it first`);
    if (before) {
      // The task's parked box, warm: the next job leases it when it fits (same image, mounts and folders) and is still running.
      const name = before.container;
      const fits = before.compat === compat && !removing.has(name) && !draining && (await jobState(name)) === "running";
      if (fits && jobs.get(name) === before && before.parked) {
        // The env file first: a lease is only ever committed with a box the kernel can run in.
        const envFile = path.join(jobEnvDir, `${name}.env`);
        writeFileSync(`${envFile}.tmp`, envText, { mode: 0o600 }); renameSync(`${envFile}.tmp`, envFile);
        jobs.lease(name, { job, tokenHash: tokenHash(token), roles }); saveJobs();
        const b = boxes.get(name);
        if (b) b.lastUsed = Date.now();
        return { container: name, envFile, outDir: path.join(jobEnvDir, name), gen: before.gen, warm: true };
      }
      await retire(name, "doesn't fit the task's next job");
    }
    await builtImage(tag, docker, log);
    await makeRoom();
    const name = newName();
    boxes.set(name, { agentId, lastUsed: Date.now(), busy: 1 }); // reserve the slot while starting
    // The job's only credential is the kernel's job token: the launcher keeps only its hash.
    jobs.add({ container: name, agentId, issueId, identifier, workspace, codexHome, kernel: true, tokenHash: tokenHash(token), roles, ...(job ? { job } : {}), gen: 1, compat }); saveJobs();
    const envFile = path.join(jobEnvDir, `${name}.env`);
    // The job's last message lands here, outside the workspace: a folder of the launcher's, mounted at /aidenhq-out.
    const outDir = path.join(jobEnvDir, name);
    try {
      mkdirSync(outDir, { mode: 0o700 });
      // aidenhq-browse uses the image's own agent-browser and Chrome (the browser image every computer builds on).
      const r = await docker(runArgs(name, outDir));
      if (r.exitCode !== 0) throw fail(500, `docker run failed: ${r.stderr.trim()}`);
      writeFileSync(envFile, envText, { mode: 0o600 });
      // A launcher draining for its successor hands out no box the successor may not know: it goes back, and the kernel asks again.
      if (draining) throw fail(503, "the launcher is restarting; ask the next one");
    } catch (e) {
      await destroy(name, "job box failed to start");
      throw e;
    }
    boxes.get(name)!.busy = 0;
    return { container: name, envFile, outDir, gen: 1 };
  },
  async "/job/renew"({ container, issueId, gen }: { container: string; issueId?: string; gen?: number }, { kernel = false }: { kernel?: boolean } = {}) {
    if (!ours(container)) throw fail(400, "not a computer");
    if (!kernel) throw fail(403, `not your job's box: ${container}`);
    if ((await jobState(container)) === "missing") {
      if (jobs.has(container)) await destroy(container, "gone before its renewal");
      throw fail(404, `box gone: ${container}`);
    }
    const r = jobs.renew(container, { issueId, gen });
    if (!r) throw fail(404, `no live job ${container} for that task (its lease lapsed, or it is another task's)`);
    saveJobs();
    return { container, issueId: r.issueId, identifier: r.identifier, workspace: r.workspace, leaseUntil: r.leaseUntil };
  },
  /**
   * The kernel's check box (kernel/src/checkbox.ts): one run of a check, in the image its run names, with only the check's
   * snapshot, its out folder and the product's supply-chain checks mounted (lib.ts checkMounts). No agent or task: only the
   * eval's model token, by its hash, so the gateway below passes its model calls on (fast and tests have
   * none). Its lease is its time limit: a kernel that dies mid-run leaves nothing behind. The kernel runs the command itself
   * (docker exec) and ends it with /job/release.
   */
  async "/check"({ check, image: imageName, workspace, out, readOnly, token, timeoutMs }: { check: string; image: unknown; workspace: string; out: string; readOnly?: boolean; token?: string | null; timeoutMs: unknown }, { kernel = false }: { kernel?: boolean } = {}) {
    if (!kernel) throw fail(403, "check boxes are the kernel's");
    if (typeof check !== "string" || !/^c-[0-9a-f]{16}$/.test(check)) throw fail(400, "check is the kernel's check id");
    if (token != null && (typeof token !== "string" || !token.startsWith("ahqj_") || /\s/.test(token))) throw fail(400, "a check's token is the kernel's (ahqj_)");
    const ms = Number(timeoutMs);
    if (!Number.isInteger(ms) || ms < 1000 || ms > MAX_CHECK_MIN * 60_000) throw fail(400, "timeoutMs is the run's time limit");
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
      if (draining) throw fail(503, "the launcher is restarting; ask the next one");
    } catch (e) {
      await destroy(name, "check box failed to start");
      throw e;
    }
    boxes.get(name)!.busy = 0;
    return { container: name };
  },
  async "/job/release"({ container, gen, destroy: wipe }: { container: string; gen?: number; destroy?: boolean }, { kernel = false }: { kernel?: boolean } = {}) {
    if (!ours(container)) throw fail(400, "not a computer");
    if (!kernel) throw fail(403, `not your job's box: ${container}`);
    const rec = jobs.get(container);
    // A kernel job's box: an earlier lease's release touches nothing (the box is its successor's now, or parked for it).
    if (rec && !rec.check && !jobs.current(container, gen)) return { released: true, state: "superseded" };
    if (rec && !rec.check && !rec.retired && wipe !== true && !draining && (rec.parked || (await park(container)))) return { released: true, state: "parked" };
    if (jobs.has(container) || (await jobState(container)) !== "missing") await retire(container, "released");
    const state = await jobState(container);
    return { released: state === "missing", state };
  },
};

/**
 * `repo-checkout <org/name> [sha]` from a box: the kernel's code host snapshot (POST /v1/checkout with the box's own job token;
 * the kernel checks the repo-checkout role and the agents org), streamed into the calling box.
 */
async function checkout(who: { container: string }, token: string, raw: string) {
  let p;
  try { p = JSON.parse(raw || "{}"); } catch { throw fail(400, "bad json"); }
  const dest = checkoutDest(p.repo);
  const r = await fetch(new URL("/v1/checkout", KERNEL_URL), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ repo: p.repo, sha: p.sha }), signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw fail(r.status, String(await r.json().then((j) => j.error ?? j.message, () => "")).slice(0, 300) || `the kernel answered ${r.status}`);
  const sha = r.headers.get("x-aidenhq-commit") ?? "";
  if (p.sha && sha !== String(p.sha).toLowerCase()) throw fail(502, `the snapshot is of ${sha.slice(0, 12)}, not ${String(p.sha).slice(0, 12)}`);
  // The snapshot took a while: the box must still be this job's (a parked and re-leased box is the next job's).
  if (liveBox(token)?.container !== who.container) throw fail(409, "the job's lease on its box has ended");
  const b = boxes.get(who.container);
  if (b) { b.busy++; b.lastUsed = Date.now(); }
  try {
    const d = spawn("docker", ["exec", "-i", who.container, "sh", "-c", UNTAR_SCRIPT, "sh", dest], { stdio: ["pipe", "ignore", "pipe"] });
    // A box gone mid-stream (evicted, tar failed) is an EPIPE here: the exit code reports it; it must never crash the launcher.
    d.on("error", () => {}); d.stdin.on("error", () => {});
    Readable.fromWeb(r.body! as WebReadableStream).on("error", () => d.kill("SIGKILL")).pipe(d.stdin);
    let err = "";
    d.stderr.on("data", (x) => (err += x));
    const t = setTimeout(() => d.kill("SIGKILL"), 120_000);
    const dc = await new Promise((ok) => d.on("close", ok));
    clearTimeout(t);
    if (dc !== 0) throw fail(500, `checkout failed: ${err.trim().slice(-300) || `tar ${dc}`}`);
  } finally {
    if (b) { b.busy--; b.lastUsed = Date.now(); }
  }
  log("/repo", who.container, p.repo, sha.slice(0, 12), "→", dest);
  return { path: dest, repo: p.repo, sha, note: "a snapshot of that commit: no .git, no credentials; nothing here can be pushed" };
}


const bearer = (req: http.IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
const send = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

// Every answer names this launcher's process, so an apply can tell the next launcher from a draining one (apply-config-work.sh
// launcherRestart).
const LAUNCHER_PID = String(process.pid);
const controlServer = http.createServer((req, res) => {
  res.setHeader("x-aidenhq-launcher-pid", LAUNCHER_PID);
  if (req.method === "GET" && req.url === "/health") {
    try { return send(res, 200, { ok: true, computers: boxes.size, max: maxBoxes() }); } catch (e) { return send(res, 500, { ok: false, error: (e as Error).message }); }
  }
  // Only these routes exist; anything else is a 404 before any key is looked at.
  const fn: ((p: any, o: { kernel: boolean }) => Promise<Record<string, unknown>>) | undefined = req.method !== "POST" ? undefined : req.url === "/progress" ? progress : Object.hasOwn(jobControl, req.url!) ? jobControl[req.url as keyof typeof jobControl] : undefined;
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
      log(req.url, "ERROR", (e as Failure).message);
      send(res, (e as Failure).status ?? 500, { error: (e as Failure).message });
    }
  });
});

// ------------------------------------------------------------------ gateway (boxes only)

/** The live box a box-side credential is: a kernel job's token for the box made for it. */
const liveBox = (token: string) => jobs.byKernelToken(token);

const gatewayServer = http.createServer(async (req, res) => {
  res.setHeader("x-aidenhq-launcher-pid", LAUNCHER_PID);
  const deny = (status: number, msg: string) => { log("gateway", req.method, req.url, status, msg); res.writeHead(status, { "content-type": "text/plain" }).end(`gateway: ${msg}`); };
  try {
    const model = /^\/api\/v1\/(responses|chat\/completions|messages)$/.exec((req.url ?? "").split("?")[0]!);
    if (req.method === "POST" && model) {
      // The model: the box's "API key" is its job token; the model gateway, not a box or the launcher, holds the real key.
      const token = bearer(req);
      const who = liveBox(token);
      if (!who) return deny(401, "not a live computer");
      boxes.get(who.container) && (boxes.get(who.container)!.lastUsed = Date.now());
      return await forwardModel(req, res, `${MODEL_GATEWAY_URL}/api/v1/${model[1]}`, token);
    }
    if (req.method === "POST" && req.url === "/repo") {
      const who = liveBox(String(req.headers["x-agent-key"] ?? ""));
      if (!who) return deny(401, "not a live computer");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      return checkout(who, String(req.headers["x-agent-key"]), Buffer.concat(chunks).toString("utf8").slice(0, 4096)).then(
        (out) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out)),
        (e) => deny(e.status ?? 500, e.message),
      );
    }
    if ((req.method === "POST" && /^\/v1\/(writes|jobtools\/[a-z]+)$/.test(req.url ?? "")) || (req.method === "GET" && /^\/v1\/writes\/[\w-]+$/.test(req.url ?? ""))) {
      // A kernel job's `aidenhq` commands (images/engineer/bin/aidenhq): its writes and next-turn requests, to the kernel as itself.
      const token = bearer(req);
      if (!liveBox(token)) return deny(401, "not a live computer");
      const k = new URL(req.url!, KERNEL_URL);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}) };
      const up = http.request({ host: k.hostname, port: Number(k.port || 80), path: k.pathname, method: req.method, headers }, (ur) => { res.writeHead(ur.statusCode ?? 502, { "content-type": ur.headers["content-type"] ?? "application/json" }); ur.pipe(res); });
      up.on("error", (e) => { if (!res.headersSent) deny(502, e.message); else res.destroy(); });
      return void req.pipe(up);
    }
    const m = /^\/c\/([a-z0-9_]+)\/mcp$/.exec(req.url!.split("?")[0]!);
    if (!m) return deny(403, "refused");
    if (!readJson(CFG.computersFile).connections?.[m[1]!]) return deny(404, `no connection ${m[1]}`);
    const token = String(req.headers["x-agent-key"] ?? "");
    if (!liveBox(token)) return deny(401, "not a live computer");
    // The kernel's proxy decides: the job token is the caller; only MCP transport headers go on.
    const k = new URL(`/c/${m[1]}/mcp`, KERNEL_URL);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    for (const h of ["accept", "content-type", "content-length", "mcp-session-id", "mcp-protocol-version"]) if (req.headers[h]) headers[h] = req.headers[h] as string;
    const up = http.request({ host: k.hostname, port: Number(k.port || 80), path: k.pathname, method: req.method, headers }, (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); });
    up.on("error", (e) => { if (!res.headersSent) deny(502, e.message); else res.destroy(); });
    req.pipe(up);
  } catch (e) {
    if (!res.headersSent) deny(502, (e as Error).message); else res.destroy();
  }
});

// ------------------------------------------------------------------ boxes from before a restart, and idle reaping

// A job's records outlive the launcher (jobs.json): its leases and its parked boxes are reconciled against Docker here.
const existing = await docker(["ps", "-a", "--filter", "label=aidenhq.computer=1", "--format", "{{.Names}}"]);
// A failed scan is not an empty one: starting would prune every saved lease, so fail and let the supervisor restart us.
if (existing.exitCode !== 0) throw new Error(`docker ps failed: ${existing.stderr.trim() || existing.signal}`);
const orphans = [];
for (const name of existing.stdout.trim().split("\n").filter(Boolean)) {
  if (!ours(name)) continue;
  // A box without its job record has lost its binding: nothing may run in it.
  // A parked box keeps its idle age (its WARM_MS runs from when it was parked); a retired one goes.
  const rec = jobs.get(name);
  if (rec && !rec.retired) boxes.set(name, { agentId: rec.agentId, lastUsed: rec.parked ?? Date.now(), busy: 0 });
  else orphans.push(name);
}
// A job record whose box is gone never comes back; its lease goes with it.
for (const name of jobs.containers()) if (!boxes.has(name)) jobs.delete(name);
saveJobs();
for (const name of orphans) await retire(name, "a box without a live job record");
// What a launcher stopped mid-removal left in its trash goes.
for (const n of (() => { try { return readdirSync(outTrash); } catch { return []; } })()) void rm(path.join(outTrash, n), { recursive: true, force: true }).catch(() => {});
if (boxes.size) log(`found ${boxes.size} job box(es) from before`);
// Listen only now: a call answered before the boxes from before are known would miss them.
// The bridge's address can come up after the launcher starts (a fresh install): wait for it quietly, no crash loop.
const listen = async (server: http.Server, { host, port }: { host: string; port: number }, what: string) => {
  for (let waited = false; ; waited = true) {
    try {
      await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, host, () => { server.off("error", fail); ok(); }); });
      return log(`${what} on ${host}:${port}`);
    } catch (e) {
      // EADDRINUSE: the last launcher, draining, hasn't closed its listener yet.
      if (!["EADDRNOTAVAIL", "EADDRINUSE"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      if (!waited) log(`${host}:${port} isn't free yet; waiting for it (${what})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
};
await Promise.all([listen(controlServer, CFG.control, "launcher"), listen(gatewayServer, CFG.gateway, "gateway")]);
// Idle boxes go (a parked one WARM_MS after its task's last job); a leased job's never does. A lapsed lease (the kernel gone 15
// minutes) takes its box.
const reaper = setInterval(() => {
  const lapsed = reapLapsed(jobs);
  if (lapsed.length) saveJobs();
  for (const n of lapsed) destroy(n, "lease lapsed");
  for (const n of stale(boxes, WARM_MS, Date.now(), held)) retire(n, "idle");
  for (const n of unremoved) destroy(n, "removal retried");
}, 60_000).unref();
// A restart (ops/run-draining.sh): the next launcher is starting. This one stops reaping and saving (the next one adopts the
// boxes from jobs.json) and closes its listeners so the next one can bind them; it serves only the calls it holds (a box's model
// stream, tool call or checkout; a /job in flight gives its box back) and exits when they have finished, or at DRAIN_MS.
process.on("SIGUSR2", () => {
  if (draining) return;
  draining = true;
  clearInterval(reaper);
  log("draining: the next launcher takes new calls; calls in flight finish here");
  void drainServers([controlServer, gatewayServer]).then(() => { log("drained: exiting"); process.exit(0); });
});

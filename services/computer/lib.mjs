// The computer launcher's logic, kept free of Docker so it can be tested: run tokens, the env an exec gets, the Codex
// config the box gets, the `docker run` line and the model call's hand-off to the gateway. launcher.mjs wires it up.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const RUN_TOKEN_PREFIX = "ahqc_"; // the kernel resolves these through /whoami
const RUN_TOKEN_ENV = "AIDENHQ_RUN_TOKEN";
const MCP_BLOCK_ENV = "AIDENHQ_MCP_B64";
const TOKEN_TTL_MS = 6 * 3600_000; // longer than any run (Paperclip's sandbox backstop is 4 h)

// The box's shell tools (repo-checkout) read the current run token here, not from the env: the Codex shell allowlist drops
// a launcher-issued *TOKEN* variable, so an env-only token reaches the model and MCP clients but not the shell.
// /dev/shm is the box's tmpfs (Docker's --shm-size): the file cannot outlive a stopped box, and release removes it too.
export const RUN_TOKEN_PATH = "/dev/shm/aidenhq/run-token";
export const WRITE_RUN_TOKEN_SCRIPT = `mkdir -p /dev/shm/aidenhq && chmod 700 /dev/shm/aidenhq && cat > ${RUN_TOKEN_PATH} && chmod 600 ${RUN_TOKEN_PATH}`;
export const CLEAR_RUN_TOKEN_SCRIPT = `rm -f ${RUN_TOKEN_PATH}`;

/**
 * Run tokens: one live token per container, issued when a run starts there, gone when it ends. The first exec from Paperclip
 * binds the token to its Paperclip run and task (the model gateway reads them from /whoami to attribute and cap the run).
 */
export class Tokens {
  #byToken = new Map(); // token → { container, agentId, at, runId?, issueId? }
  #byContainer = new Map(); // container → token
  #onRevoke;
  /** `onRevoke(container)` runs whenever a container's token goes: expiry included, so nothing keyed by the token outlives it. */
  constructor({ onRevoke } = {}) { this.#onRevoke = onRevoke; }
  issue(container, agentId, now = Date.now()) {
    this.revoke(container);
    const token = RUN_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    this.#byToken.set(token, { container, agentId, at: now });
    this.#byContainer.set(container, token);
    return token;
  }
  revoke(container) {
    const t = this.#byContainer.get(container);
    if (t) this.#byToken.delete(t);
    this.#byContainer.delete(container);
    if (t) this.#onRevoke?.(container);
  }
  current(container) { return this.#byContainer.get(container); }
  /** The container's current token names this Paperclip run and task; true when that changed (save the tokens). */
  bind(container, { runId, issueId }) {
    const hit = this.#byToken.get(this.#byContainer.get(container));
    const next = { runId: runId ? String(runId) : null, issueId: issueId ? String(issueId) : null };
    if (!hit || (!next.runId && !next.issueId) || (hit.runId === next.runId && hit.issueId === next.issueId)) return false;
    Object.assign(hit, next);
    return true;
  }
  /** The live tokens as plain data, to survive a launcher restart (the box's env file holds its token). */
  dump() { return [...this.#byToken].map(([token, v]) => ({ token, ...v })); }
  load(rows, now = Date.now()) {
    for (const r of rows) if (r?.token?.startsWith(RUN_TOKEN_PREFIX) && now - r.at <= TOKEN_TTL_MS) { this.#byToken.set(r.token, { container: r.container, agentId: r.agentId, at: r.at, runId: r.runId ?? null, issueId: r.issueId ?? null }); this.#byContainer.set(r.container, r.token); }
  }
  whoami(token, now = Date.now()) {
    const hit = typeof token === "string" ? this.#byToken.get(token) : undefined;
    if (!hit) return undefined;
    if (now - hit.at > TOKEN_TTL_MS) { this.revoke(hit.container); return undefined; }
    return { agentId: hit.agentId, container: hit.container, runId: hit.runId ?? null, issueId: hit.issueId ?? null };
  }
}

const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(", ")}]` : JSON.stringify(String(v)));

/**
 * The agent's granted connections as Codex config, for the box only: each through the launcher's gateway with the run token
 * as X-Agent-Key (the launcher passes it on to the kernel's proxy). Wrapped in markers so applying it twice replaces it.
 */
export function mcpBlock(tools, connections, gatewayUrl) {
  const lines = ["# >>> aidenhq-computer (written by the launcher)"];
  for (const [name, list] of Object.entries(tools ?? {})) {
    const c = connections[name];
    if (!c || !/^[a-z0-9_]+$/.test(name)) continue;
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`url = ${toml(`${gatewayUrl}/c/${name}/mcp`)}`, `env_http_headers = { "X-Agent-Key" = ${toml(RUN_TOKEN_ENV)} }`);
    lines.push(`enabled_tools = ${toml(list)}`, "startup_timeout_sec = 20", `tool_timeout_sec = ${Number(c.tool_timeout_sec) || 300}`, 'default_tools_approval_mode = "approve"', "");
  }
  lines.push("# <<< aidenhq-computer", "");
  return lines.join("\n");
}

// Paperclip hands some execs its own server env (seen live: BETTER_AUTH_SECRET, PAPERCLIP_AGENT_JWT_SECRET, PAPERCLIP_AGENT_PRIVATE_KEY,
// PAPERCLIP_SECRETS_MASTER_KEY_FILE, PAPERCLIP_GITHUB_BROKER_TOKEN, every compose secret). None of it may enter a box. The run's own
// bridge credential stays (PAPERCLIP_API_KEY, PAPERCLIP_BRIDGE_TOKEN: valid only on the box's own bridge).
const SERVER_SECRET = /SECRET|PRIVATE|MASTER_KEY|PASSWORD|(^|_)TOKEN$|DATABASE_URL/;
const BOX_KEYS = new Set(["PAPERCLIP_BRIDGE_TOKEN"]);

/**
 * A routine's own model and reasoning effort (AIDENHQ_MODEL, AIDENHQ_REASONING_EFFORT in the exec's env, which execEnv then strips)
 * swapped into a `codex exec` for the agent's: the box's equivalent of services/paperclip-tasks-mcp/codex-model.
 */
export function routineArgs(command, args, env) {
  const model = env?.AIDENHQ_MODEL, effort = env?.AIDENHQ_REASONING_EFFORT;
  // Paperclip puts its global -c pairs before `exec` (codex -c k=v ... exec ...): skip them to find the subcommand.
  let at = 0;
  while (args[at] === "-c" && at + 1 < args.length) at += 2;
  if (!/(^|\/)codex$/.test(command) || args[at] !== "exec" || (!model && !effort)) return args;
  const out = [...args.slice(0, at), "exec", ...(model ? ["--model", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
  for (let i = at + 1; i < args.length; i++) {
    if (model && args[i] === "--model" && i + 1 < args.length) { i++; continue; }
    if (effort && args[i] === "-c" && String(args[i + 1]).startsWith("model_reasoning_effort=")) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

/**
 * What an exec in a box gets: Paperclip's env minus every real secret (the OpenRouter key from adapterConfig, our AIDENHQ_* tokens),
 * plus this run's token; with CODEX_HOME, the agent's Codex config as base64 for the wrapper.
 */
export function execEnv(env, { token, mcp }) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (k === "OPENROUTER_API_KEY" || k.startsWith("AIDENHQ_") || (SERVER_SECRET.test(k) && !BOX_KEYS.has(k))) continue;
    out[k] = String(v);
  }
  if ("OPENAI_API_KEY" in out) out.OPENAI_API_KEY = "unused"; // Codex wants one even on OpenRouter; never a real one
  if (token) out[RUN_TOKEN_ENV] = token;
  if (out.CODEX_HOME && mcp) out[MCP_BLOCK_ENV] = Buffer.from(mcp).toString("base64");
  return out;
}

// Before anything runs with a CODEX_HOME: drop Paperclip's managed MCP block (its gateway JWTs) and our shared block from the box's
// config.toml, append this agent's granted servers, and refuse to start if a JWT is still there.
export const CODEX_CONFIG_SCRUB = [
  'f="$CODEX_HOME/config.toml"',
  'mkdir -p "$CODEX_HOME"',
  '[ -n "$HOME" ] && mkdir -p "$HOME"', // a job's HOME (in its workspace) is made here, inside the box: the kernel never writes there
  "if [ -f \"$f\" ]; then sed -e '/^# BEGIN PAPERCLIP MANAGED MCP/,/^# END PAPERCLIP MANAGED MCP/d' -e '/^# >>> aidenhq/,/^# <<< aidenhq/d' \"$f\" > \"$f.aidenhq\" && mv \"$f.aidenhq\" \"$f\" || exit 97; fi",
  `[ -n "$${MCP_BLOCK_ENV}" ] && printf '%s' "$${MCP_BLOCK_ENV}" | base64 -d >> "$f"`,
  `unset ${MCP_BLOCK_ENV}`,
  "if [ -f \"$f\" ] && grep -q 'eyJ' \"$f\"; then echo 'aidenhq: a token is still in the Codex config; refusing to start' >&2; exit 97; fi",
  'exec "$@"',
].join("\n");

/** What a job's engine runs under in its box (docker exec): the scrub above, then the engine. */
export const BOX_EXEC_WRAP = CODEX_CONFIG_SCRUB;

/** [command, args] for docker exec: wrapped in the scrub when the exec carries a CODEX_HOME. */
export function wrapExec(command, args, env) {
  return env?.CODEX_HOME ? ["sh", ["-c", CODEX_CONFIG_SCRUB, "aidenhq-computer", command, ...(args ?? [])]] : [command, args ?? []];
}

/**
 * compile publishes a new image tag before ops/computer-images.sh has built it. Until it exists, run the newest built image
 * of the same name (never a pull) rather than failing the agent's run.
 */
export async function builtImage(tag, docker, log = () => {}) {
  if ((await docker(["image", "inspect", tag])).exitCode === 0) return tag;
  const r = await docker(["images", "--filter", `reference=${tag.split(":")[0]}`, "--format", "{{.Repository}}:{{.Tag}}"]); // newest first
  const older = r.stdout.split("\n").find((t) => t && !t.endsWith(":<none>"));
  if (!older) throw Object.assign(new Error(`image ${tag} is not built yet (ops/computer-images.sh)`), { status: 500 });
  log("image", tag, "not built yet; using", older);
  return older;
}

/**
 * A long exec (the plugin names it with an execId: an agent's whole turn) runs detached in the box, its stdin, output and exit
 * code in a folder there, so a launcher restart (a deploy) mid-turn never ends it: the next launcher collects the result for the
 * plugin (/attach). Three shell scripts, each `sh -c SCRIPT sh <folder> ...`: write the stdin (and remove folders finished over
 * 10 minutes ago); run the command; wait for its exit code and print its output. Waiting is idempotent: the old launcher's
 * waiter lives on in the box after a restart, and both see the same result. A folder that isn't there prints EXEC_MISSING and
 * exits 97.
 */
export const EXEC_ID = /^[a-z0-9-]{8,64}$/;
export const EXEC_ROOT = "/tmp/aidenhq-exec";
export const EXEC_MISSING = "aidenhq: no such exec";
export const EXEC_PREP_SCRIPT = 'find "${1%/*}" -mindepth 2 -maxdepth 2 -name code -mmin +10 2>/dev/null | while read -r f; do rm -rf "${f%/code}"; done; mkdir -p "$1" && cat > "$1/in"';
export const EXEC_RUN_SCRIPT = 'd=$1; shift; "$@" < "$d/in" > "$d/out" 2> "$d/err"; echo $? > "$d/code.tmp" && mv "$d/code.tmp" "$d/code"';
export const EXEC_WAIT_SCRIPT = `d=$1; while [ ! -f "$d/code" ]; do [ -d "$d" ] || { echo "${EXEC_MISSING}" >&2; exit 97; }; sleep 1; done; cat "$d/out"; cat "$d/err" >&2; exit "$(cat "$d/code")"`;

/** What a box killed by its memory limit is called in the launcher's log and in the failed command's error (never a bare exit 137). */
export const oomMessage = (container, limit) => `computer ${container} was killed for running out of memory (limit ${limit}); gVisor counts the box's tmpfs, /dev/shm and browser memory against it: raise AIDENHQ_COMPUTERS_MEMORY or run less at once`;

/** `docker run` arguments: image, limits, network and mounts all come from the launcher's own config. */
export function dockerRunArgs({ name, image, agentId, network, limits, mounts, user, labels = [], home = "/root" }) {
  const args = ["run", "-d", "--name", name, "--runtime=runsc", "--network", network,
    "--memory", limits.memory, "--memory-swap", limits.memory, "--cpus", String(limits.cpus), "--shm-size", limits.shm, "--pids-limit", String(limits.pids),
    "--label", "aidenhq.computer=1", "--label", `aidenhq.agent=${agentId}`, ...labels.flatMap((l) => ["--label", l]),
    ...(user ? ["--user", user] : []), "-e", `HOME=${home}`, "-w", "/workspace"];
  for (const m of mounts) args.push("-v", m);
  args.push(image, "sleep", "infinity");
  return args;
}

/**
 * Admission: with `max` boxes already up, the least recently used idle one (no exec in flight) is evicted; none idle → wait.
 * A box `held(name)` (a job's live lease) is never idle: its `docker exec` comes from the kernel, not through here.
 * Returns the container to evict, or null when there is room, or "wait".
 */
export function admit(boxes, max, held = () => false) {
  if (boxes.size < max) return null;
  const idle = [...boxes].filter(([n, b]) => !b.busy && !held(n)).sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
  return idle.length ? idle[0][0] : "wait";
}

/** The live box of this agent (the busy one, else the latest used), for reading its session log. */
export function boxOf(boxes, agentId) {
  return [...boxes].filter(([, b]) => b.agentId === agentId).sort(([, a], [, b]) => (b.busy ? 1 : 0) - (a.busy ? 1 : 0) || b.lastUsed - a.lastUsed)[0]?.[0];
}

/** Last lines of the newest Codex session log in a box (sh -c). */
export const PROGRESS_SCRIPT = 'f=$(ls -t $(find /workspace/.paperclip-runtime/codex/home/sessions -name "rollout-*.jsonl" 2>/dev/null) 2>/dev/null | head -1); [ -n "$f" ] && tail -n 400 "$f"';

/** Boxes idle longer than idleMs; a held one (a job's live lease) never is. */
export const stale = (boxes, idleMs, now = Date.now(), held = () => false) => [...boxes].filter(([n, b]) => !b.busy && !held(n) && now - b.lastUsed > idleMs).map(([n]) => n);

/** A job's lease: renewed by the kernel while it follows the job. Lapsed (the kernel gone this long), the box goes. */
export const LEASE_MS = 15 * 60_000;

/**
 * Jobs' boxes (POST /job, POST /check): one record per box, saved like the run tokens so a launcher restart keeps the lease.
 * { container, agentId, issueId, identifier, workspace, codexHome, kernel, tokenHash, roles, leaseUntil }.
 */
/**
 * Whether a box may use repo-checkout: a kernel job's box by the roles its admission froze (the launcher's job record, never
 * the grants table again); any other box by its agent's grants.
 */
export const mayCheckout = (who, grants) => (Array.isArray(who?.roles) ? who.roles : grants?.agents?.[who?.agentId]?.roles ?? []).includes("repo-checkout");

export const tokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");

export class Jobs {
  #by = new Map();
  add(rec, now = Date.now(), leaseMs = LEASE_MS) {
    this.#by.set(rec.container, { ...rec, leaseUntil: now + leaseMs });
    return this.#by.get(rec.container);
  }
  get(container) { return this.#by.get(container); }
  has(container) { return this.#by.has(container); }
  delete(container) { return this.#by.delete(container); }
  byIssue(issueId) { return [...this.#by.values()].find((r) => r.issueId === issueId); }
  /** A kernel job's box by its job token (the kernel minted it; only its hash is kept): its container and agent, else undefined. */
  byKernelToken(token) {
    if (typeof token !== "string" || !token.startsWith("ahqj_")) return undefined;
    const h = tokenHash(token);
    const r = [...this.#by.values()].find((x) => x.kernel && x.tokenHash === h);
    return r && { container: r.container, agentId: r.agentId, roles: [...(r.roles ?? [])] };
  }
  containers() { return [...this.#by.keys()]; }
  /** A live lease: admission and idle reaping leave the box alone. */
  leased(container, now = Date.now()) { return (this.#by.get(container)?.leaseUntil ?? 0) > now; }
  /** The kernel still follows the job (after its own restart too): a new lease. Undefined: no such job. */
  renew(container, { issueId } = {}, now = Date.now()) {
    const r = this.#by.get(container);
    if (!r || r.issueId !== issueId || r.leaseUntil <= now) return undefined;
    r.leaseUntil = now + LEASE_MS;
    return r;
  }
  /** Jobs whose lease ran out: the kernel has been gone too long. */
  lapsed(now = Date.now()) { return [...this.#by.values()].filter((r) => r.leaseUntil <= now).map((r) => r.container); }
  dump() { return [...this.#by.values()]; }
  load(rows) { for (const r of rows ?? []) if (r?.container && r.issueId) this.#by.set(r.container, r); }
}

/**
 * A folder the kernel asks to mount into a job's box, checked: exactly `<root>/<name>` as given (no `..`, no other path),
 * an existing directory, and no symlink anywhere below the root (its real path is the root's real path plus `name`).
 * `name` is the task's own (its identifier for the task folder, its id for the Codex home), never the caller's choice.
 */
export function jobFolder(given, root, name) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { status: 403 }); };
  if (typeof given !== "string" || !/^[\w.-]+$/.test(name) || name === "." || name === "..") fail("not a task folder");
  if (given !== path.join(root, name)) fail(`${given} isn't this task's folder (${path.join(root, name)})`);
  let real;
  try { real = realpathSync(given); } catch { fail(`${given} doesn't exist`); }
  if (real !== path.join(realpathSync(root), name)) fail(`${given} goes through a symlink`);
  if (!statSync(real).isDirectory()) fail(`${given} isn't a directory`);
  return real;
}

/**
 * A job box's bind mounts. The guard hooks folder is made here, as the launcher's user: a missing bind source
 * is created by Docker as root, and a pre-push hook then can't be written into it (EACCES on every repo command).
 */
export function jobMounts({ resolvConf, workspace, outDir, codexHome, runnerWork, repo, engineDir }) {
  const hooks = path.join(runnerWork, ".guard-hooks");
  mkdirSync(hooks, { recursive: true });
  return [`${resolvConf}:/etc/resolv.conf:ro`, `${workspace}:/workspace`, `${outDir}:/aidenhq-out`, `${codexHome}:/codex-home`, `${hooks}:/opt/aidenhq/hooks:ro`, `${path.join(repo, engineDir)}:/opt/aidenhq/engine:ro`];
}

/** A job box's HOME (outside every clone); its wrappers (the image's /opt/aidenhq/bin) first on its PATH. */
export const JOB_HOME = "/workspace/.aidenhq/home";
const JOB_PATH = "/opt/aidenhq/bin:/opt/rust/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Every name a job box's env file may hold: the job's revocable capabilities and plain settings. Nothing of the kernel's own env (it adds only the job's read-only gh token, by docker exec -e). */
export const JOB_ENV_NAMES = [
  "AIDENHQ_RUN_TOKEN", "AIDENHQ_GATEWAY_URL", "AIDENHQ_MCP_B64", "AIDENHQ_TASK_WORKTREE", "HOME", "CODEX_HOME", "PATH",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_TERMINAL_PROMPT",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2",
];

/**
 * A job box's env file (docker exec --env-file), built here from the allowlist and never from the kernel's env: the job token
 * (model key, MCP key and the `aidenhq` commands' key), the agent's granted connections as Codex config, and the commit
 * identity. Commits stay unsigned; the clones' hooks are the read-only guard hooks.
 */
export function jobEnvFile({ token, mcp, gatewayUrl, identity = {} }) {
  const clean = (v) => String(v ?? "").replace(/[\r\n]/g, " ").trim();
  const env = {
    AIDENHQ_RUN_TOKEN: token,
    AIDENHQ_GATEWAY_URL: gatewayUrl, // a kernel job's `aidenhq` commands (images/engineer/bin/aidenhq)
    AIDENHQ_MCP_B64: Buffer.from(mcp ?? "").toString("base64"),
    HOME: JOB_HOME, AIDENHQ_TASK_WORKTREE: "/workspace", // the task folder, as on the host (its .aidenhq/out/ is attached)
    CODEX_HOME: "/codex-home",
    PATH: JOB_PATH,
    GIT_AUTHOR_NAME: clean(identity.name), GIT_AUTHOR_EMAIL: clean(identity.email),
    GIT_COMMITTER_NAME: clean(identity.name), GIT_COMMITTER_EMAIL: clean(identity.email),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: "/opt/aidenhq/hooks",
  };
  return JOB_ENV_NAMES.filter((k) => env[k]).map((k) => `${k}=${env[k]}`).join("\n") + "\n";
}

/** Lapsed jobs, their run tokens revoked and records dropped at once; the caller then removes the boxes. */
export function reapLapsed(jobs, tokens, now = Date.now()) {
  const names = jobs.lapsed(now);
  for (const n of names) { tokens.revoke(n); jobs.delete(n); }
  return names;
}

/** The job routes: only launcher_kernel_key (the kernel) opens them, and nothing else. */
export const JOB_ROUTES = ["/job", "/job/renew", "/job/release"];
/** The kernel's check boxes (kernel/src/checkbox.ts): only launcher_kernel_key opens it; /job/release ends one. */
export const CHECK_ROUTES = ["/check"];

/**
 * A check box's bind mounts: the check's snapshot at /workspace (read-only for the reviewer eval), its out folder, and the
 * product's own supply-chain checks read-only (the change under test can't edit the copy that judges it). Nothing else: no
 * engine, no Codex home, no hooks, no `aidenhq` commands.
 */
export function checkMounts({ resolvConf, workspace, out, readOnly, supplyChain }) {
  return [`${resolvConf}:/etc/resolv.conf:ro`, `${workspace}:/workspace${readOnly ? ":ro" : ""}`, `${out}:/aidenhq-out`, `${supplyChain}:/opt/aidenhq/supply-chain:ro`];
}

/**
 * Whether a control call's bearer opens its route: the kernel's key only the job and check routes, the board's
 * progress key only /progress, the plugin's key every other route. An empty secret is no key.
 */
export function controlAllowed(bearer, method, url, { plugin, kernel, progress }) {
  if (method !== "POST" || !bearer) return false;
  if ([...JOB_ROUTES, ...CHECK_ROUTES].includes(url)) return Boolean(kernel) && bearer === kernel;
  if (url === "/progress" && progress && bearer === progress) return true;
  return Boolean(plugin) && bearer === plugin;
}

/**
 * The run's own Paperclip credential, from an exec's env: the per-run bridge token and the box's bridge URL (127.0.0.1 inside the
 * box; the token only works there, and Paperclip forwards with the run's identity) and the run's task. Kept per box for /reply.
 */
export function runCredential(env) {
  const apiUrl = env?.PAPERCLIP_API_URL, apiKey = env?.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) return undefined;
  return { apiUrl: String(apiUrl), apiKey: String(apiKey), taskId: env.PAPERCLIP_TASK_ID ? String(env.PAPERCLIP_TASK_ID) : undefined };
}

/**
 * The per-box Paperclip credential /cp calls with: one live credential per container, set by the exec that carried it. Saved
 * like the run tokens, because an agent's whole turn is one detached exec: a launcher restarted mid-turn finds it when it
 * reloads the box, instead of answering 409 for the rest of the turn. Dropped with the box's token, so a reused name never
 * inherits one.
 */
export class Creds {
  #by = new Map(); // container → { apiUrl, apiKey, taskId? }
  set(container, cred) { this.#by.set(container, { apiUrl: cred.apiUrl, apiKey: cred.apiKey, ...(cred.taskId ? { taskId: cred.taskId } : {}) }); }
  get(container) { return this.#by.get(container); }
  delete(container) { return this.#by.delete(container); }
  dump() { return [...this.#by].map(([container, c]) => ({ container, ...c })); }
  load(rows) { for (const r of rows ?? []) if (r?.container && r.apiUrl && r.apiKey) this.set(r.container, { apiUrl: r.apiUrl, apiKey: r.apiKey, taskId: r.taskId }); }
}

/** Runs in the box (node): one control-plane call through the box's bridge. Everything, the key included, comes on stdin. */
export const CP_SCRIPT = `let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const r=JSON.parse(s);try{const res=await fetch(new URL(r.path,r.url),{method:r.method,headers:{authorization:"Bearer "+r.key,accept:"application/json",...(r.body?{"content-type":"application/json"}:{})},body:r.body?Buffer.from(r.body,"base64"):undefined,signal:AbortSignal.timeout(50000)});const b=Buffer.from(await res.arrayBuffer());console.log(JSON.stringify({status:res.status,type:res.headers.get("content-type")||"application/json",body:b.toString("base64")}))}catch(e){console.log(JSON.stringify({status:502,type:"text/plain",body:Buffer.from("the bridge failed: "+e.message).toString("base64")}))}});`;

/**
 * A long control call (the agent's whole turn is one /exec): headers go out at once and a space every interval, then the
 * JSON result (or `{error, status}`). Node's fetch abandons a request with no headers, or a body silent, for 5 minutes, so
 * an Agent Architect turn past 5 min used to fail with "fetch failed" and lose its computer (2026-11-11).
 */
export async function answerSlowly(res, work, intervalMs = 60_000) {
  res.writeHead(200, { "content-type": "application/json" });
  const ping = setInterval(() => res.write(" "), intervalMs);
  try {
    const out = await work;
    res.end(JSON.stringify(out));
  } catch (e) {
    res.end(JSON.stringify({ error: e.message, status: e.status ?? 500 }));
  } finally {
    clearInterval(ping);
  }
}

const refused = (status, msg) => Object.assign(new Error(msg), { status });

/**
 * A box's `repo-checkout` request (POST /repo on the gateway), checked: a repo in the agents org and a full commit SHA. The
 * snapshot comes from the runner's cache clone (<runner work_dir>/repos/<org>/<name>, kept fetched with the runner's GitHub
 * App token), so no token goes near the box; the launcher, never the caller, picks the folder in the box.
 * Returns { cache, sha?, dest }, or throws with a message for the agent.
 */
export function checkoutRequest(body, { agentsOrg, agentsOrgs, cacheRoot }) {
  const m = /^([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/.exec(String(body?.repo ?? "").trim());
  if (!m) throw refused(400, "give the repository as org/name");
  // One agents org per enabled code host (the GitHub agents org, and `local` with codehost-local): the runner's cache clone of
  // a repo is <cacheRoot>/<org>/<name> either way.
  const orgs = [agentsOrgs ?? agentsOrg].flat().filter(Boolean);
  const org = orgs.find((o) => m[1].toLowerCase() === String(o).toLowerCase());
  if (!org) throw refused(403, `only repositories in the agents org (${orgs.join(", ") || "none configured"})`);
  // No SHA: the default branch as the runner's copy last saw it (the launcher resolves it).
  const sha = String(body?.sha ?? "").trim().toLowerCase() || undefined;
  if (sha && !/^[0-9a-f]{40}$/.test(sha)) throw refused(400, "give the full 40-character commit SHA (e.g. the PR's head), or none for the default branch");
  const name = m[2].replace(/\.git$/, "");
  return { cache: `${cacheRoot}/${org}/${name}`, sha, dest: `/workspace/repos/${name}` };
}

/**
 * `git` arguments for the snapshot of `sha` in `cache`, as a tar on stdout. Every `.aidenhq/` folder is left out: that is
 * AidenHQ's scratch space (an agent's screenshots and reports), never the app, and one committed by an earlier change shows
 * that change, not this commit. A reviewer judges only what it captures itself.
 */
export const archiveArgs = (cache, sha) => ["-C", cache, "archive", "--format=tar", sha, "--", ".", ":(exclude,glob)**/.aidenhq/**"];

/** Runs in the box (sh -c, $1 = the folder): replaces the folder with the tar on stdin. */
export const UNTAR_SCRIPT = 'rm -rf "$1" && mkdir -p "$1" && tar -x --no-same-owner -C "$1"';

/**
 * A box's model call, passed on to the model gateway (services/gateway) with the run token as its credential: the gateway
 * names the run through /whoami, counts what OpenRouter billed and refuses past a spend cap. Its answer (a stream, or a 402
 * cap_reached) goes back to the box as it is. The OpenRouter key is never here.
 */
export function forwardModel(req, res, url, token) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const headers = { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${token}` };
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
      ur.on("end", resolve);
      ur.on("error", () => { res.destroy(); resolve(); });
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 502, type: "gateway_unreachable", message: `the model gateway is unreachable (${e.message})` } }));
      else res.destroy();
      resolve();
    });
    // The box hung up: drop our leg too (the gateway still reads OpenRouter's answer to the end and records it).
    res.on("close", () => { if (!res.writableFinished) up.destroy(); resolve(); });
    req.pipe(up);
  });
}

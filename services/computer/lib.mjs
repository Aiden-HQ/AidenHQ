// The computer launcher's logic, kept free of Docker so it can be tested: run tokens, the env an exec gets, the Codex
// config the box gets, the `docker run` line and the model call's hand-off to the gateway. launcher.mjs wires it up.
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const RUN_TOKEN_PREFIX = "ahqc_"; // services/shared/agent-auth.ts resolves these through /whoami
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
 * The agent's granted connections as Codex config, for the box only: HTTP ones through the gateway with the run token as
 * X-Agent-Key; stdio ones (the tasks bridge) as they are. Wrapped in markers so applying it twice replaces it.
 */
export function mcpBlock(tools, connections, gatewayUrl) {
  const lines = ["# >>> aidenhq-computer (written by the launcher)"];
  for (const [name, list] of Object.entries(tools ?? {})) {
    const c = connections[name];
    if (!c || !/^[a-z0-9_]+$/.test(name)) continue;
    lines.push(`[mcp_servers.${name}]`);
    if (c.url) lines.push(`url = ${toml(`${gatewayUrl}/c/${name}/mcp`)}`, `env_http_headers = { "X-Agent-Key" = ${toml(RUN_TOKEN_ENV)} }`);
    else lines.push(`command = ${toml(c.command)}`, `args = ${toml(c.args ?? [])}`, `env_vars = ${toml(c.env_vars ?? [])}`);
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
  '[ -n "$HOME" ] && mkdir -p "$HOME"', // a runner job's HOME (in its workspace) is made here, inside the box: the runner never writes there
  "if [ -f \"$f\" ]; then sed -e '/^# BEGIN PAPERCLIP MANAGED MCP/,/^# END PAPERCLIP MANAGED MCP/d' -e '/^# >>> aidenhq/,/^# <<< aidenhq/d' \"$f\" > \"$f.aidenhq\" && mv \"$f.aidenhq\" \"$f\" || exit 97; fi",
  `[ -n "$${MCP_BLOCK_ENV}" ] && printf '%s' "$${MCP_BLOCK_ENV}" | base64 -d >> "$f"`,
  `unset ${MCP_BLOCK_ENV}`,
  "if [ -f \"$f\" ] && grep -q 'eyJ' \"$f\"; then echo 'aidenhq: a token is still in the Codex config; refusing to start' >&2; exit 97; fi",
  'exec "$@"',
].join("\n");

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
 * A box `held(name)` (a runner job's live lease) is never idle: its `docker exec` comes from the runner, not through here.
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

/** Boxes idle longer than idleMs; a held one (a runner job's live lease) never is. */
export const stale = (boxes, idleMs, now = Date.now(), held = () => false) => [...boxes].filter(([n, b]) => !b.busy && !held(n) && now - b.lastUsed > idleMs).map(([n]) => n);

/** A runner job's lease: renewed by the runner while it follows the job. Lapsed (the runner gone this long), the box goes. */
export const LEASE_MS = 15 * 60_000;

/**
 * Runner jobs' boxes (POST /job): one record per box, saved like the run tokens so a launcher restart keeps the lease and the
 * helper binding. { container, agentId, issueId, identifier, workspace, codexHome, helperPort, helperToken, leaseUntil }.
 */
export class Jobs {
  #by = new Map();
  add(rec, now = Date.now()) {
    this.#by.set(rec.container, { ...rec, leaseUntil: now + LEASE_MS });
    return this.#by.get(rec.container);
  }
  get(container) { return this.#by.get(container); }
  has(container) { return this.#by.has(container); }
  delete(container) { return this.#by.delete(container); }
  byIssue(issueId) { return [...this.#by.values()].find((r) => r.issueId === issueId); }
  containers() { return [...this.#by.keys()]; }
  /** A live lease: admission and idle reaping leave the box alone. */
  leased(container, now = Date.now()) { return (this.#by.get(container)?.leaseUntil ?? 0) > now; }
  /** The runner still follows the job (after its own restart too): a new lease and the helper binding. Undefined: no such job. */
  renew(container, { issueId, helperPort, helperToken } = {}, now = Date.now()) {
    const r = this.#by.get(container);
    if (!r || r.issueId !== issueId || r.leaseUntil <= now) return undefined;
    if (helperPort && helperToken) Object.assign(r, { helperPort, helperToken });
    r.leaseUntil = now + LEASE_MS;
    return r;
  }
  /** Jobs whose lease ran out: the runner has been gone too long. */
  lapsed(now = Date.now()) { return [...this.#by.values()].filter((r) => r.leaseUntil <= now).map((r) => r.container); }
  dump() { return [...this.#by.values()]; }
  load(rows) { for (const r of rows ?? []) if (r?.container && r.issueId) this.#by.set(r.container, r); }
}

/**
 * A folder the runner asks to mount into a job's box, checked: exactly `<root>/<name>` as given (no `..`, no other path),
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

/** Where a job box's runner bits are: the guard hooks, the `aidenhq` commands, the HOME (outside every clone). */
export const JOB_HOME = "/workspace/.aidenhq/home";
const JOB_PATH = "/opt/aidenhq/bin:/opt/rust/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Every name a job box's env may hold: the run's revocable capabilities and plain settings. Nothing of the runner's own env. */
export const JOB_ENV_NAMES = [
  "AIDENHQ_RUN_TOKEN", "AIDENHQ_REPO_URL", "AIDENHQ_REPO_TOKEN", "AIDENHQ_MCP_B64", "HOME", "CODEX_HOME", "PATH",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_TERMINAL_PROMPT",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2",
];

/**
 * A job box's env file (docker exec --env-file), built here from the allowlist and never from the runner's env: the run token
 * (model key, MCP key and the `aidenhq` commands' key, through the gateway's helper route), the agent's granted connections as
 * Codex config, and the commit identity. Commits stay unsigned (the runner signs after the run); the clones' hooks are the
 * runner's read-only guard hooks.
 */
export function jobEnvFile({ token, mcp, gatewayUrl, identity = {} }) {
  const clean = (v) => String(v ?? "").replace(/[\r\n]/g, " ").trim();
  const env = {
    AIDENHQ_RUN_TOKEN: token,
    AIDENHQ_REPO_URL: `${gatewayUrl}/helper`,
    AIDENHQ_REPO_TOKEN: token,
    AIDENHQ_MCP_B64: Buffer.from(mcp ?? "").toString("base64"),
    HOME: JOB_HOME,
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

/**
 * POST /helper/<command> on the gateway: a job box's `aidenhq` command, passed to the runner's helper bound to that box's run
 * token (its job record's port and helper token). Only the bearer run token is read from the request; the box never names a
 * port, URL, identity or credential. The body goes on as it is (the runner checks it, and tiers every write). While the runner
 * restarts its port refuses connections: retried for two minutes, with the binding read again (adoption may move it).
 */
export async function serveHelper(req, res, { tokens, jobs, retryForMs = 120_000, retryEveryMs = 2000 }) {
  const reply = (status, text) => res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
  const m = /^\/helper\/([a-z]+)$/.exec(req.url ?? "");
  if (req.method !== "POST" || !m || !HELPER_COMMANDS.includes(m[1])) return reply(404, "not found");
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const binding = () => {
    const who = tokens.whoami(token);
    const r = who && jobs.get(who.container);
    return r && { port: r.helperPort, token: r.helperToken };
  };
  if (!binding()) return reply(401, "this task run is over");
  const chunks = [];
  let size = 0;
  for await (const c of req) if ((size += c.length) <= 65_536) chunks.push(c);
  const body = Buffer.concat(chunks);
  for (const end = Date.now() + retryForMs; ; ) {
    const to = binding();
    if (!to) return reply(401, "this task run is over");
    try {
      const out = await postLocal(to.port, `/${m[1]}`, to.token, body);
      return reply(out.status, out.text);
    } catch (e) {
      if (e.code !== "ECONNREFUSED" || Date.now() > end) return reply(502, `the runner didn't answer (${e.message})`);
      await new Promise((r) => setTimeout(r, retryEveryMs));
    }
  }
}

// The runner's helper commands (services/runner/src/repohelper.ts TOOLS; verify-security.sh checks that list).
import { TOOLS as HELPER_COMMANDS } from "../runner/src/repohelper.ts";

/** POST to host loopback (http.request: an `aidenhq pr` can take many minutes, past fetch's silent-request limit). */
function postLocal(port, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": body.length } }, (up) => {
      const parts = [];
      up.on("data", (d) => parts.push(d));
      up.on("end", () => resolve({ status: up.statusCode ?? 502, text: Buffer.concat(parts).toString("utf8") }));
      up.on("error", reject);
    });
    r.on("error", reject);
    r.end(body);
  });
}

/** Lapsed jobs, their run tokens revoked and records dropped at once; the caller then removes the boxes. */
export function reapLapsed(jobs, tokens, now = Date.now()) {
  const names = jobs.lapsed(now);
  for (const n of names) { tokens.revoke(n); jobs.delete(n); }
  return names;
}

/** The runner's control routes: only computers_runner_key opens them, and that key opens nothing else. */
export const JOB_ROUTES = ["/job", "/job/renew", "/job/release"];

/**
 * Whether a control call's bearer opens its route: the runner's key only the job routes, the board's progress key only
 * /progress, the plugin's key every other route. An empty secret is no key.
 */
export function controlAllowed(bearer, method, url, { plugin, runner, progress }) {
  if (method !== "POST" || !bearer) return false;
  if (JOB_ROUTES.includes(url)) return Boolean(runner) && bearer === runner;
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

/** Why a reply can't be posted for this run (null: it can). A run posts only on its own task; for a chat run that is the chat. */
export function replyRefusal(cred, issueId, body) {
  if (!cred) return "this run has no Paperclip credential (no exec from Paperclip yet, or the run ended)";
  if (typeof body !== "string" || !body.trim()) return "a reply needs a body";
  if (typeof issueId !== "string" || !cred.taskId || issueId !== cred.taskId) return "a run may reply only on its own task";
  return null;
}

/** Runs in the box (node): posts the comment through the box's bridge. Everything, the key included, comes on stdin. */
export const REPLY_SCRIPT = `let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const r=JSON.parse(s);try{const res=await fetch(new URL("/api/issues/"+encodeURIComponent(r.issueId)+"/comments",r.url),{method:"POST",headers:{authorization:"Bearer "+r.key,"content-type":"application/json"},body:JSON.stringify({body:r.body}),signal:AbortSignal.timeout(25000)});console.log(res.status);process.exit(res.ok?0:1)}catch(e){console.log("error "+e.message);process.exit(1)}});`;

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
export function checkoutRequest(body, { agentsOrg, cacheRoot }) {
  const m = /^([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/.exec(String(body?.repo ?? "").trim());
  if (!m) throw refused(400, "give the repository as org/name");
  if (!agentsOrg || m[1].toLowerCase() !== agentsOrg.toLowerCase()) throw refused(403, `only repositories in the agents org (${agentsOrg || "none configured"})`);
  // No SHA: the default branch as the runner's copy last saw it (the launcher resolves it).
  const sha = String(body?.sha ?? "").trim().toLowerCase() || undefined;
  if (sha && !/^[0-9a-f]{40}$/.test(sha)) throw refused(400, "give the full 40-character commit SHA (e.g. the PR's head), or none for the default branch");
  const name = m[2].replace(/\.git$/, "");
  return { cache: `${cacheRoot}/${agentsOrg}/${name}`, sha, dest: `/workspace/repos/${name}` };
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

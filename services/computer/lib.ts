// The computer launcher's logic, kept free of Docker so it can be tested: kernel jobs' boxes, the Codex config a box gets,
// the `docker run` line and the model call's hand-off to the gateway. launcher.ts wires it up.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { MODEL_BODY_MAX } from "../../kernel/src/gateway/token.ts";

export { MODEL_BODY_MAX };

/** The longest run a check may ask for (minutes): the launcher's /check limit and the module compiler's timeout_min ceiling. */
export const MAX_CHECK_MIN = 180;

/** A box the launcher holds: busy while a call runs in it, lastUsed for eviction. */
export interface Box { busy: number; lastUsed: number; agentId?: string }
/**
 * A job's box record (see Jobs). A kernel job's box is leased to one job at a time: `job` and `gen` (the lease generation,
 * bumped at every lease) bind it, so a late renew or release of an earlier job never touches its successor's lease. Between
 * its task's jobs the box is parked (`parked`: when): no job, no token, kept warm for the task's next job when that job's box
 * would be the same (`compat`, compatKey).
 */
export interface JobRec { container: string; agentId?: string; issueId?: string; identifier?: string; workspace?: string; codexHome?: string; kernel?: boolean; check?: string; tokenHash?: string; roles?: string[]; leaseUntil: number; job?: string; gen?: number; compat?: string; parked?: number; retired?: boolean; standing?: boolean; leases?: LeaseRec[] }
/**
 * One session's lease in the standing box (see Jobs): its job's token, its task's folders and the two ports and secrets its
 * opencode server and terminal listen on. `gen` is always 1: a lease id is never reused, so a late call of an earlier job names
 * another lease. A lease whose token is gone is being stopped (`revokeLease`).
 */
export interface LeaseRec { lease: string; agentId?: string; job?: string; issueId: string; identifier: string; workspace: string; tokenHash?: string; roles: string[]; ports: { serve: number; term: number }; secrets: { serve: string; term: string }; gen: number; leaseUntil: number }

const RUN_TOKEN_ENV = "AIDENHQ_RUN_TOKEN";
const MCP_BLOCK_ENV = "AIDENHQ_MCP_B64";
const toml = (v: unknown): string => (Array.isArray(v) ? `[${v.map(toml).join(", ")}]` : JSON.stringify(String(v)));

/**
 * Whether a declared MCP server reaches the box's Codex config: it has granted tools (a non-empty list), a connection entry,
 * and a name Codex accepts. `mcpBlock` and the kernel's launch check share this one rule, so a server is either emitted or
 * refused by name, never silently dropped.
 */
export function emitsServer(name: string, tools: Record<string, unknown> | undefined, connections: Record<string, unknown>) {
  // Own entries only: a declared name like `toString` must not read Object.prototype and pass as present. A connection entry
  // that is null/undefined is no entry, as `mcpBlock` treats it, so the check and the renderer agree on every server.
  if (!tools || !Object.hasOwn(tools, name) || !Object.hasOwn(connections, name) || !connections[name]) return false;
  const list = tools[name];
  const hasTools = Array.isArray(list) ? list.length > 0 : list !== undefined && list !== null;
  return hasTools && /^[a-z0-9_]+$/.test(name);
}

/** The declared servers this job's frozen tools and connections don't emit, in declaration order. */
export function unemittedServers(declared: string[], tools: Record<string, unknown> | undefined, connections: Record<string, unknown>): string[] {
  return declared.filter((name) => !emitsServer(name, tools, connections));
}

/**
 * The agent's granted connections as Codex config, for the box only: each through the launcher's gateway with the job token
 * as X-Agent-Key (the launcher passes it on to the kernel's proxy). Wrapped in markers so applying it twice replaces it.
 */
export function mcpBlock(tools: Record<string, unknown> | undefined, connections: Record<string, { tool_timeout_sec?: unknown }>, gatewayUrl: string) {
  const lines = ["# >>> aidenhq-computer (written by the launcher)"];
  for (const [name, list] of Object.entries(tools ?? {})) {
    const c = connections[name];
    if (!c || !emitsServer(name, tools, connections)) continue;
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`url = ${toml(`${gatewayUrl}/c/${name}/mcp`)}`, `env_http_headers = { "X-Agent-Key" = ${toml(RUN_TOKEN_ENV)} }`);
    lines.push(`enabled_tools = ${toml(list)}`, "startup_timeout_sec = 20", `tool_timeout_sec = ${Number(c.tool_timeout_sec) || 300}`, 'default_tools_approval_mode = "approve"', "");
  }
  lines.push("# <<< aidenhq-computer", "");
  return lines.join("\n");
}

// Before the engine runs: drop our block from the box's config.toml and append this job's granted servers.
export const CODEX_CONFIG_SCRUB = [
  'f="$CODEX_HOME/config.toml"',
  'mkdir -p "$CODEX_HOME"',
  '[ -n "$HOME" ] && mkdir -p "$HOME"', // a job's HOME (in its workspace) is made here, inside the box
  "if [ -f \"$f\" ]; then sed -e '/^# >>> aidenhq/,/^# <<< aidenhq/d' \"$f\" > \"$f.aidenhq\" && mv \"$f.aidenhq\" \"$f\" || exit 97; fi",
  `[ -n "$${MCP_BLOCK_ENV}" ] && printf '%s' "$${MCP_BLOCK_ENV}" | base64 -d >> "$f"`,
  `unset ${MCP_BLOCK_ENV}`,
  'exec "$@"',
].join("\n");

/** What a kernel job's engine runs under in its box (docker exec): the scrub above, then the engine. */
export const BOX_EXEC_WRAP = CODEX_CONFIG_SCRUB;

/**
 * The image a tag names now, by its ID: a box runs that exact image, so a tag rebuilt later is a different image (warm boxes
 * key on it). compile publishes a new image tag before ops/computer-images.sh has built it (the same apply builds it next).
 * Until it exists the launch is refused with a 503: the kernel retries it (an agent job on its next tick, a check every 30s up
 * to its busy wait).
 */
export async function builtImage(tag: string, docker: (args: string[]) => Promise<{ exitCode?: number | null; stdout: string }>, log: (...a: unknown[]) => void = () => {}) {
  const r = await docker(["image", "inspect", "-f", "{{.Id}}", tag]);
  if (r.exitCode === 0 && /^sha256:[0-9a-f]{64}$/.test(r.stdout.trim())) return r.stdout.trim();
  log("image", tag, "not built yet; launch deferred");
  throw Object.assign(new Error(`image ${tag} is not built yet (ops/computer-images.sh)`), { status: 503 });
}

/** `docker run` arguments: image, limits, network and mounts all come from the launcher's own config. */
export function dockerRunArgs({ name, image, agentId, network, limits, mounts, user, labels = [], home = "/root", workdir = "/workspace" }: {
  name: string;
  image: string;
  agentId: string;
  network: string;
  limits: { memory: string; cpus: number | string; shm: string; pids: number | string };
  mounts: string[];
  user?: string;
  labels?: string[];
  home?: string;
  workdir?: string;
}) {
  const args = ["run", "-d", "--name", name, "--runtime=runsc", "--network", network,
    "--memory", limits.memory, "--memory-swap", limits.memory, "--cpus", String(limits.cpus), "--shm-size", limits.shm, "--pids-limit", String(limits.pids),
    "--label", "aidenhq.computer=1", "--label", `aidenhq.agent=${agentId}`, ...labels.flatMap((l) => ["--label", l]),
    ...(user ? ["--user", user] : []), "-e", `HOME=${home}`, "-w", workdir];
  for (const m of mounts) args.push("-v", m);
  args.push(image, "sleep", "infinity");
  return args;
}

/**
 * Admission: with `max` boxes already up, the least recently used idle one is evicted; none idle → wait. A box `held(name)`
 * (a job's live lease) is never idle: its `docker exec` comes from the kernel, not through here.
 * Returns the container to evict, or null when there is room, or "wait".
 */
export function admit(boxes: Map<string, Box>, max: number, held: (name: string) => boolean = () => false) {
  if (boxes.size < max) return null;
  const idle = [...boxes].filter(([n, b]) => !b.busy && !held(n)).sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
  return idle.length ? idle[0]![0] : "wait";
}

/** The live box of this agent (the busy one, else the latest used), for reading its session log. */
export function boxOf(boxes: Map<string, Box>, agentId: string) {
  return [...boxes].filter(([, b]) => b.agentId === agentId).sort(([, a], [, b]) => (b.busy ? 1 : 0) - (a.busy ? 1 : 0) || b.lastUsed - a.lastUsed)[0]?.[0];
}

/** Last lines of the newest Codex session log in a job's box (its Codex home is /codex-home; sh -c). */
export const PROGRESS_SCRIPT = 'f=$(ls -t $(find /codex-home/sessions -name "rollout-*.jsonl" 2>/dev/null) 2>/dev/null | head -1); [ -n "$f" ] && tail -n 400 "$f"';

/** Boxes idle longer than idleMs (a parked box since it was parked); a held one (a job's live lease) never is. */
export const stale = (boxes: Map<string, Box>, idleMs: number, now = Date.now(), held: (name: string) => boolean = () => false) => [...boxes].filter(([n, b]) => !b.busy && !held(n) && now - b.lastUsed > idleMs).map(([n]) => n);

/** A job's lease: renewed by the kernel while it follows the job. Lapsed (the kernel gone this long), the box goes. */
export const LEASE_MS = 15 * 60_000;
/** How long a parked box waits for its task's next job before it goes (any idle box: the one idle-reaping limit). */
export const WARM_MS = 30 * 60_000;

/**
 * What makes a box fit a job: its exact `docker run` line (the image by ID, user, limits, network, labels, every mount) and
 * the identity (device, inode, birth) of every mount's source. Anything replaced since the box started (an image rebuilt
 * under its tag, the engine module or repo-checkout updated by an apply, a folder the disk sweep, `aidenhq cleanup` or a cache
 * reset made again) is a different key, so the box, which still holds the old one, no longer fits. A source that can't be
 * read throws: no fit.
 */
export function compatKey(runArgs: string[]) {
  const sources = runArgs.flatMap((a, i) => (runArgs[i - 1] === "-v" ? [a.slice(0, a.indexOf(":"))] : []));
  // The birth time too: ext4 hands a freed inode number straight to the next file made.
  const ids = sources.map((d) => { const st = statSync(d); return `${st.dev}:${st.ino}:${st.birthtimeMs}`; });
  return createHash("sha256").update(JSON.stringify([runArgs, ids])).digest("hex");
}

/** Whether a box may use repo-checkout: by the roles its job's admission froze (the launcher's job record). */
export const mayCheckout = (who?: { roles?: string[] }) => (who?.roles ?? []).includes("repo-checkout");

export const tokenHash = (token: unknown) => createHash("sha256").update(String(token)).digest("hex");

/**
 * Jobs' boxes (POST /job, /check): one record per box, saved so a launcher restart keeps the lease.
 * { container, agentId, issueId, identifier, workspace, codexHome, kernel, tokenHash, roles, leaseUntil }.
 */
export class Jobs {
  #by = new Map<string, JobRec>();
  add(rec: Omit<JobRec, "leaseUntil">, now = Date.now(), leaseMs = LEASE_MS) {
    this.#by.set(rec.container, { ...rec, leaseUntil: now + leaseMs });
    return this.#by.get(rec.container);
  }
  get(container: string) { return this.#by.get(container); }
  has(container: string) { return this.#by.has(container); }
  delete(container: string) { return this.#by.delete(container); }
  byIssue(issueId: string | undefined) { return [...this.#by.values()].find((r) => r.issueId === issueId); }
  /** Whether `gen` is the box's current lease (a record from before leases had generations is generation 0). */
  current(container: string, gen: unknown) { const r = this.#by.get(container); return Boolean(r) && (r!.gen ?? 0) === (gen ?? 0); }
  /** The job's lease ends and the box is parked: its token opens nothing from now on. */
  park(container: string, now = Date.now()) {
    const r = this.#by.get(container);
    if (!r || r.retired) return false;
    delete r.tokenHash; delete r.job;
    r.parked = now; r.leaseUntil = 0;
    return true;
  }
  /** Revokes the box's token now (its job is over), before the box is parked or goes. */
  revoke(container: string) {
    const r = this.#by.get(container);
    if (!r) return;
    delete r.tokenHash; delete r.job;
    for (const l of r.leases ?? []) delete l.tokenHash;
  }
  /**
   * The box is going: no token, no lease, never leased again. The record stays (holding the task) until Docker has removed the
   * box, so the task's next job waits for that rather than starting beside it.
   */
  retire(container: string) {
    const r = this.#by.get(container);
    if (!r) return false;
    this.revoke(container);
    delete r.parked;
    r.retired = true; r.leaseUntil = 0;
    return true;
  }
  /** A parked box leased to the task's next job: a new generation, the new job's token and roles. */
  lease(container: string, { job, tokenHash, roles }: { job?: string; tokenHash: string; roles: string[] }, now = Date.now()) {
    const r = this.#by.get(container)!;
    delete r.parked;
    Object.assign(r, { job, tokenHash, roles, gen: (r.gen ?? 0) + 1, leaseUntil: now + LEASE_MS });
    return r;
  }
  /** A kernel job's box by its job token (the kernel minted it; only its hash is kept): its container and agent, else undefined. A session's lease counts too. */
  byKernelToken(token: unknown) {
    if (typeof token !== "string" || !token.startsWith("ahqj_")) return undefined;
    const h = tokenHash(token);
    for (const r of this.#by.values()) {
      if (r.kernel && r.tokenHash === h) return { container: r.container, agentId: r.agentId, roles: [...(r.roles ?? [])] };
      const l = r.leases?.find((x) => x.tokenHash === h);
      if (r.kernel && l) return { container: r.container, agentId: l.agentId ?? r.agentId, roles: [...l.roles] };
    }
    return undefined;
  }
  containers() { return [...this.#by.keys()]; }
  /** A live lease: admission and idle reaping leave the box alone (a parked box has none). The standing box always holds one. */
  leased(container: string, now = Date.now()) { const r = this.#by.get(container); return Boolean(r && (r.standing ? !r.retired : !r.parked && r.leaseUntil > now)); }
  /**
   * The kernel still follows the job (after its own restart too): a new lease. Undefined: no such job, or not this lease.
   * In the standing box a job is its `lease`: that lease's own task and time.
   */
  renew(container: string, { issueId, gen, lease }: { issueId?: string; gen?: number; lease?: string } = {}, now = Date.now()) {
    const r = this.#by.get(container);
    if (r?.standing) {
      const l = r.leases?.find((x) => x.lease === lease);
      if (!l || r.retired || l.issueId !== issueId || l.leaseUntil <= now || l.gen !== (gen ?? 1)) return undefined;
      l.leaseUntil = now + LEASE_MS;
      return l;
    }
    if (!r || r.parked || r.issueId !== issueId || r.leaseUntil <= now || !this.current(container, gen)) return undefined;
    r.leaseUntil = now + LEASE_MS;
    return r;
  }
  /** Jobs whose lease ran out: the kernel has been gone too long. A session's is its own lease, never its box (the standing box is never reaped). */
  lapsed(now = Date.now()): { container: string; lease?: string }[] {
    return [...this.#by.values()].flatMap((r) => r.standing
      ? (r.leases ?? []).filter((l) => l.leaseUntil <= now).map((l) => ({ container: r.container, lease: l.lease }))
      : !r.parked && !r.retired && r.leaseUntil <= now ? [{ container: r.container }] : []);
  }
  /** The one standing box (sessions' computer), if any, retired or not. */
  standingBox() { return [...this.#by.values()].find((r) => r.standing); }
  addStanding(rec: { container: string; agentId?: string; compat?: string }) {
    const r: JobRec = { ...rec, kernel: true, standing: true, leases: [], leaseUntil: 0 };
    this.#by.set(rec.container, r);
    return r;
  }
  /** A session's lease in the standing box: its token opens its own tools, from `leaseMs` on a renew keeps it. */
  addLease(container: string, l: Omit<LeaseRec, "gen" | "leaseUntil">, now = Date.now(), leaseMs = LEASE_MS) {
    const r = this.#by.get(container);
    if (!r?.standing) throw new Error(`${container} is not the standing box`);
    const rec: LeaseRec = { ...l, gen: 1, leaseUntil: now + leaseMs };
    (r.leases ??= []).push(rec);
    return rec;
  }
  leases(container: string) { return [...(this.#by.get(container)?.leases ?? [])]; }
  /** The standing box and lease a task's session holds, if any. */
  leaseOf(issueId: string | undefined) {
    for (const r of this.#by.values()) { const l = r.leases?.find((x) => x.issueId === issueId); if (l) return { container: r.container, lease: l.lease }; }
    return undefined;
  }
  /** The session is being stopped: its token opens nothing, its lease stays (lapsed at once) until `releaseLease`, so a restart finishes the stop. */
  revokeLease(container: string, lease: string) {
    const l = this.#by.get(container)?.leases?.find((x) => x.lease === lease);
    if (!l) return false;
    delete l.tokenHash; l.leaseUntil = 0;
    return true;
  }
  releaseLease(container: string, lease: string) {
    const r = this.#by.get(container);
    const i = r?.leases?.findIndex((x) => x.lease === lease) ?? -1;
    return i < 0 ? undefined : r!.leases!.splice(i, 1)[0];
  }
  dump() { return [...this.#by.values()]; }
  load(rows: JobRec[] | undefined) { for (const r of rows ?? []) if (r?.container && (r.issueId || r.standing)) this.#by.set(r.container, r); }
}

/**
 * A folder the kernel asks to mount into a job's box, checked: exactly `<root>/<name>` as given (no `..`, no other path),
 * an existing directory, and no symlink anywhere below the root (its real path is the root's real path plus `name`).
 * `name` is the task's own (its identifier for the task folder, its id for the Codex home), never the caller's choice.
 */
export function jobFolder(given: unknown, root: string, name: string) {
  const fail: (msg: string) => never = (msg) => { throw Object.assign(new Error(msg), { status: 403 }); };
  if (typeof given !== "string" || !/^[\w.-]+$/.test(name) || name === "." || name === "..") fail("not a task folder");
  if (given !== path.join(root, name)) fail(`${given} isn't this task's folder (${path.join(root, name)})`);
  let real: string;
  try { real = realpathSync(given); } catch { fail(`${given} doesn't exist`); }
  if (real !== path.join(realpathSync(root), name)) fail(`${given} goes through a symlink`);
  if (!statSync(real).isDirectory()) fail(`${given} isn't a directory`);
  return real;
}

/** The commit-msg hook every box commit passes through: the AidenHQ trailer is on the message before any commit sha exists to bind. */
export const COMMIT_MSG_HOOK = '#!/bin/sh\nexec git interpret-trailers --in-place --if-exists addIfDifferent --trailer "Co-authored-by: AidenHQ ${AIDENHQ_AGENT_NAME} <noreply@aidenhq.ai>" "$1"\n';

/**
 * A job box's bind mounts. The guard hooks folder is made here, as the launcher's user: a missing bind source
 * is created by Docker as root, and a hook then can't be written into it (EACCES on every repo command).
 */
export function jobMounts({ resolvConf, workspace, outDir, codexHome, runnerWork, repo, engineDir, roles = [] }: { resolvConf: string; workspace: string; outDir: string; codexHome: string; runnerWork: string; repo: string; engineDir: string; roles?: string[] }) {
  const hooks = guardHooks(runnerWork);
  // `repo-checkout` is in the box only for a job frozen with its role: a command the box can't use is a dead end.
  const checkout = mayCheckout({ roles }) ? [`${path.join(repo, "services/computer/images/agent-base/repo-checkout")}:/usr/local/bin/repo-checkout:ro`] : [];
  return [...checkout, `${resolvConf}:/etc/resolv.conf:ro`, `${workspace}:/workspace`, `${outDir}:/aidenhq-out`, `${codexHome}:/codex-home`, `${hooks}:/opt/aidenhq/hooks:ro`, `${path.join(repo, engineDir)}:/opt/aidenhq/engine:ro`, `${npmCacheDir(runnerWork)}:${NPM_CACHE}`];
}

/**
 * The standing session box's bind mounts: every session's folder under /sessions (the kernel's session workspaces), the leases'
 * out folders under /aidenhq-out/<lease>, the engine's state folders under /engine-state, and the shared pieces of a job box.
 * Never another task's folder, the secrets dir, the data dir or the Docker socket. Made here as the launcher's user (Docker
 * would make a missing bind source as root).
 */
export function standingMounts({ resolvConf, sessionsDir, outDir, stateDir, runnerWork, repo, engineDir }: { resolvConf: string; sessionsDir: string; outDir: string; stateDir: string; runnerWork: string; repo: string; engineDir: string }) {
  for (const d of [sessionsDir, outDir, stateDir]) mkdirSync(d, { recursive: true });
  return [`${resolvConf}:/etc/resolv.conf:ro`, `${sessionsDir}:/sessions`, `${outDir}:/aidenhq-out`, `${stateDir}:/engine-state`, `${guardHooks(runnerWork)}:/opt/aidenhq/hooks:ro`, `${path.join(repo, engineDir)}:/opt/aidenhq/engine:ro`, `${npmCacheDir(runnerWork)}:${NPM_CACHE}`];
}

/** The guard hooks folder and the shared npm cache, made as the launcher's user. */
function guardHooks(runnerWork: string) {
  mkdirSync(npmCacheDir(runnerWork), { recursive: true });
  const hooks = path.join(runnerWork, ".guard-hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, "commit-msg"), COMMIT_MSG_HOOK, { mode: 0o755 });
  return hooks;
}

/**
 * Every job box's npm cache (npm_config_cache), shared by all tasks: npm's content-addressed store, where a package is filed
 * under its integrity hash and checked against it on every read, so a task's install takes what any task fetched before
 * instead of downloading it again, and the task folders stop carrying a copy each. `node_modules` and build output stay in the
 * task's own folder. The disk sweep (kernel/src/workspaces.ts) starts it afresh weekly, and at once under disk pressure.
 */
export const npmCacheDir = (runnerWork: string) => path.join(runnerWork, ".cache", "npm");
const NPM_CACHE = "/opt/aidenhq/npm-cache";

/** A job box's HOME (outside every clone); its wrappers (the image's /opt/aidenhq/bin) first on its PATH. */
export const JOB_HOME = "/workspace/.aidenhq/home";
const JOB_PATH = "/opt/aidenhq/bin:/opt/rust/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Every name a job box's env file may hold: the job's revocable token and plain settings. */
export const JOB_ENV_NAMES = [
  "AIDENHQ_RUN_TOKEN", "AIDENHQ_AGENT_NAME", "AIDENHQ_GATEWAY_URL", "AIDENHQ_MCP_B64", "AIDENHQ_TASK_WORKTREE", "HOME", "CODEX_HOME", "PATH", "npm_config_cache",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_TERMINAL_PROMPT",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2",
  "AIDENHQ_SESSION_PORT", "AIDENHQ_TERM_PORT", "OPENCODE_SERVER_PASSWORD", "AIDENHQ_TERM_CREDENTIAL",
];
/** What a session's lease adds to its env file: its folders in the standing box, and the ports and secrets of its server and terminal. */
export interface LeaseEnv { workdir: string; stateIn: string; ports: { serve: number; term: number }; secrets: { serve: string; term: string } }

/**
 * A job box's env file (docker exec --env-file), built here from the allowlist: the job token (model key, MCP key and the
 * `aidenhq` commands' key, through the gateway), the job's granted connections as Codex config, and the commit identity.
 * Commits stay unsigned; the clones' hooks are the read-only guard hooks.
 */
export function jobEnvFile({ token, mcp, gatewayUrl, identity = {}, lease }: { token: string; mcp?: string | null; gatewayUrl: string; identity?: { name?: unknown; email?: unknown; agent?: unknown }; lease?: LeaseEnv }) {
  const clean = (v: unknown) => String(v ?? "").replace(/[\r\n]/g, " ").trim();
  const env: Record<string, string> = {
    AIDENHQ_RUN_TOKEN: token,
    AIDENHQ_AGENT_NAME: clean(identity.agent), // the commit-msg hook's trailer names the agent
    AIDENHQ_GATEWAY_URL: gatewayUrl, // the `aidenhq` commands (images/engineer/bin/aidenhq) and repo-checkout
    AIDENHQ_MCP_B64: Buffer.from(mcp ?? "").toString("base64"),
    HOME: JOB_HOME, AIDENHQ_TASK_WORKTREE: "/workspace", // the task folder, as on the host (its .aidenhq/out/ is attached)
    CODEX_HOME: "/codex-home",
    PATH: JOB_PATH,
    npm_config_cache: NPM_CACHE,
    GIT_AUTHOR_NAME: clean(identity.name), GIT_AUTHOR_EMAIL: clean(identity.email),
    GIT_COMMITTER_NAME: clean(identity.name), GIT_COMMITTER_EMAIL: clean(identity.email),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: "/opt/aidenhq/hooks",
    // A session's own folders (its box is shared: no /workspace), and its server's and terminal's ports and passwords.
    ...(lease ? {
      HOME: `${lease.workdir}/.aidenhq/home`, AIDENHQ_TASK_WORKTREE: lease.workdir, CODEX_HOME: lease.stateIn,
      AIDENHQ_SESSION_PORT: String(lease.ports.serve), AIDENHQ_TERM_PORT: String(lease.ports.term),
      OPENCODE_SERVER_PASSWORD: lease.secrets.serve, AIDENHQ_TERM_CREDENTIAL: `aidenhq:${lease.secrets.term}`, // ttyd's --credential is user:password
    } : {}),
  };
  return JOB_ENV_NAMES.filter((k) => env[k]).map((k) => `${k}=${env[k]}`).join("\n") + "\n";
}

/** Lapsed jobs: a box's record is dropped at once and the caller then removes the box; a session's lease (`lease` set) stays for the caller to stop. */
export function reapLapsed(jobs: Jobs, now = Date.now()) {
  const lapsed = jobs.lapsed(now);
  for (const l of lapsed) if (!l.lease) jobs.delete(l.container);
  return lapsed;
}

/** The job routes: only launcher_kernel_key (the kernel) and computers_runner_key open them, and nothing else. */
export const JOB_ROUTES = ["/job", "/job/renew", "/job/release"];
/** The kernel's check boxes (kernel/src/checkbox.ts): only launcher_kernel_key opens it; /job/release ends one. */
export const CHECK_ROUTES = ["/check"];

/**
 * A check box's bind mounts: the check's snapshot at /workspace (read-only for the reviewer eval), its out folder, and the
 * product's own supply-chain checks read-only (the change under test can't edit the copy that judges it). Nothing else: no
 * engine, no Codex home, no hooks, no `aidenhq` commands.
 */
export function checkMounts({ resolvConf, workspace, out, readOnly, supplyChain }: { resolvConf: string; workspace: string; out: string; readOnly?: boolean; supplyChain: string }) {
  return [`${resolvConf}:/etc/resolv.conf:ro`, `${workspace}:/workspace${readOnly ? ":ro" : ""}`, `${out}:/aidenhq-out`, `${supplyChain}:/opt/aidenhq/supply-chain:ro`];
}

/**
 * Whether a control call's bearer opens its route: the kernel's key the job and check routes, the board's progress key only
 * /progress. Nothing else is a route. An empty secret is no key.
 */
export function controlAllowed(bearer: string | undefined, method: string | undefined, url: string | undefined, { kernel, progress }: { kernel?: string; progress?: string }) {
  if (method !== "POST" || !bearer) return false;
  if ([...JOB_ROUTES, ...CHECK_ROUTES].includes(url as string)) return Boolean(kernel) && bearer === kernel;
  return url === "/progress" && Boolean(progress) && bearer === progress;
}

const refused = (status: number, msg: string) => Object.assign(new Error(msg), { status });

/** Where a box's `repo-checkout org/name` lands: /workspace/repos/<name>, picked here, never by the caller. */
export function checkoutDest(repo: unknown) {
  const m = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/.exec(String(repo ?? "").trim());
  if (!m) throw refused(400, "give the repository as org/name");
  return `/workspace/repos/${m[1]!.replace(/\.git$/, "")}`;
}

/**
 * Runs in the box (sh -c, $1 = the folder): replaces the folder with the tar.gz on stdin. Every `.aidenhq/` folder is left
 * out: that is AidenHQ's scratch space (an agent's screenshots and reports), never the app, and one committed by an earlier
 * change shows that change, not this commit. A reviewer judges only what it captures itself.
 */
export const UNTAR_SCRIPT = 'rm -rf "$1" && mkdir -p "$1" && tar -xz --no-same-owner -C "$1" && find "$1" -name .aidenhq -type d -prune -exec rm -rf {} +';

/** How long a box's model call waits for a model gateway that isn't listening (a kernel restart: the old one has closed its
 * listener and the next one hasn't bound it yet, a minute or more under load). */
export const GATEWAY_WAIT_MS = 2 * 60_000;
/** The most model-request bytes the launcher holds at once across every box's calls (each is held until its answer starts, to
 * be sent again while the gateway restarts); a call past it is answered 503, which the engines retry. */
export const MODEL_HELD_MAX = 256 * 1024 * 1024;
let heldBytes = 0;

/**
 * A box's model call, passed on to the model gateway (kernel/src/gateway) with the job token as its credential: the gateway
 * names the job from it, counts what OpenRouter billed and refuses past a spend cap. Its answer (a stream, or a 402
 * cap_reached) goes back to the box as it is. The OpenRouter key is never here.
 * A refused connection is tried again every `retryMs` for up to `waitMs`: the request never reached the gateway, so nothing was
 * sent upstream or billed, and the box's call (a check's review, an agent's turn) survives a kernel restart instead of failing.
 * The request body is read whole first (at most MODEL_BODY_MAX: a larger one is refused 413), so it can be sent again.
 */
export function forwardModel(req: http.IncomingMessage, res: http.ServerResponse, url: string, token: string, { waitMs = GATEWAY_WAIT_MS, retryMs = 1000, heldMax = MODEL_HELD_MAX }: { waitMs?: number; retryMs?: number; heldMax?: number } = {}) {
  return new Promise<void>((resolve) => {
    const u = new URL(url);
    // anthropic-version and anthropic-beta go on for the Anthropic format (the gateway keeps only the betas it allows).
    const anthropic = Object.fromEntries((["anthropic-version", "anthropic-beta"] as const).filter((h) => typeof req.headers[h] === "string").map((h) => [h, req.headers[h] as string]));
    const chunks: Buffer[] = [];
    let size = 0, mine = 0, refused: 413 | 503 | undefined;
    let up: http.ClientRequest | undefined, hungUp = false, body: Buffer | undefined;
    // This call's share of the launcher-wide hold, given back once its body isn't needed (an answer came, or it ended).
    const release = () => { body = undefined; chunks.length = 0; heldBytes -= mine; mine = 0; };
    const done = () => { release(); resolve(); };
    const send = (until: number) => {
      if (hungUp || !body) return done();
      const headers = { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${token}`, "content-length": String(body.length), ...anthropic };
      up = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers }, (ur) => {
        release();
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
        ur.on("end", done);
        ur.on("error", () => { res.destroy(); done(); });
      });
      up.on("error", (e: NodeJS.ErrnoException) => {
        if (hungUp) return done();
        if (e.code === "ECONNREFUSED" && Date.now() < until) return void setTimeout(() => send(until), retryMs);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 502, type: "gateway_unreachable", message: `the model gateway is unreachable (${e.message})` } }));
        else res.destroy();
        done();
      });
      up.end(body);
    };
    // The box hung up: drop our leg too (the gateway still reads OpenRouter's answer to the end and records it), and stop waiting.
    res.on("close", () => { if (!res.writableFinished) { hungUp = true; up?.destroy(); } done(); });
    // Past this request's limit (413) or the launcher-wide hold (503) the rest is read and dropped, and the call is answered at
    // its end; nothing more is held.
    req.on("data", (c: Buffer) => {
      if (refused) return;
      size += c.length;
      refused = size > MODEL_BODY_MAX ? 413 : heldBytes + c.length > heldMax ? 503 : undefined;
      if (refused) return void release();
      heldBytes += c.length;
      mine += c.length;
      chunks.push(c);
    });
    req.on("error", () => { res.destroy(); done(); });
    req.on("end", () => {
      if (!refused) {
        body = Buffer.concat(chunks);
        chunks.length = 0;
        return send(Date.now() + waitMs);
      }
      const error = refused === 413
        ? { code: 413, type: "request_too_large", message: `a model request is at most ${MODEL_BODY_MAX} bytes` }
        : { code: 503, type: "launcher_busy", message: "the computer launcher holds as many model requests as it may while the model gateway restarts; try again shortly" };
      res.writeHead(refused, { "content-type": "application/json" }).end(JSON.stringify({ error }));
      done();
    });
  });
}

/**
 * A box's read of the model gateway's model list (GET /api/v1/models?ids=…: an engine sizes its context window from it), passed
 * on with the job token. An unreachable gateway is a 502 the engine fails on, loudly.
 */
export async function forwardModelList(res: http.ServerResponse, url: string, token: string) {
  try {
    const up = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const body = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }).end(body);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 502, type: "gateway_unreachable", message: `the model gateway is unreachable (${(e as Error).message})` } }));
  }
}

/** How long a draining launcher keeps serving the calls it holds (the kernel's DRAIN_MS). */
export const DRAIN_MS = 5 * 60_000;

/**
 * A restart's drain (SIGUSR2 from ops/run-draining.sh, as the kernel's): the servers stop listening at once, so the next
 * launcher binds their ports; idle keep-alive connections are closed every second, so callers reconnect to the next one;
 * the calls in flight (a model stream, a tool call, a checkout) finish here. Resolves once every server has closed, or at `maxMs`.
 */
export function drainServers(servers: http.Server[], maxMs = DRAIN_MS) {
  return new Promise<void>((done) => {
    let left = servers.length;
    const idle = setInterval(() => { for (const s of servers) s.closeIdleConnections(); }, 1000);
    const end = () => { clearInterval(idle); clearTimeout(cap); done(); };
    const cap = setTimeout(end, maxMs);
    for (const s of servers) s.close(() => { if (--left === 0) end(); });
  });
}

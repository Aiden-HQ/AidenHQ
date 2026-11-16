import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DEFAULT_IDENTITY, identityEnv } from "./github-app.ts";
import { appendFileSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { mintToken } from "../../../kernel/src/gateway/token.ts";
import { BOX_EXEC_WRAP } from "../../computer/lib.mjs";
import { appendLine, lines, readFrom } from "../../../kernel/sdk/src/engine-io.ts";
import { REPO_ROOT } from "./config.mjs";

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * Whether a job holds private data: its gcloud session, other tasks, and the private jobcaps (Grafana, Slack, Glean,
 * ClickHouse; compile gives those only to such an Engineer). Only an Engineer whose definition opts in (`private_reads: true`,
 * setup's metadata.privateReads; agents.mjs pickedEngine), on any engine. Such a job gets no web search, so private data
 * can't leave through search queries. Light Engineers (the Software and Platform Engineers) keep web search.
 */
export const observes = (engine) => engine?.reads === true;

/**
 * A job's MCP servers: its jobcaps (the agent's `jobcaps:`, compiled into config/jobcaps.json), each reached through the model
 * gateway's /c/<connection>/mcp with the job's own token (env AIDENHQ_JOB_TOKEN). The job holds no connection URL and no service
 * token; the gateway forwards with the read secret and only the jobcap's tools. Named by connection (the prompts say "the slack
 * MCP tools"); ids the file doesn't know are skipped.
 */
export function jobcapServers(cfg, ids = []) {
  const all = readJobcaps(cfg);
  const out = new Map();
  for (const id of ids) {
    const c = all[id];
    if (!c?.connection || out.has(c.connection)) continue;
    out.set(c.connection, { name: c.connection, url: `${gatewayUrl(cfg)}/c/${c.connection}/mcp`, ...(c.tool_timeout_s ? { toolTimeout: c.tool_timeout_s } : {}), ...(c.private ? { private: true } : {}) });
  }
  return [...out.values()];
}
const readJobcaps = (cfg) => { try { return JSON.parse(readFileSync(cfg.jobcapsFile, "utf8")); } catch { return {}; } };
/**
 * The jobcaps a job of this engine gets: the private ones (Slack, Glean, Grafana, ClickHouse) only when it observes (private_reads,
 * web search off), so private data and the live web never meet in one job. Sorted: the job token's claims are stable.
 */
export const jobcapsFor = (cfg, engine, ids = []) => {
  const all = readJobcaps(cfg);
  return [...new Set(ids)].filter((id) => all[id] && (!all[id].private || observes(engine))).sort();
};
export const JOB_TOKEN_ENV = "AIDENHQ_JOB_TOKEN";

// The host's toolchains, read-only in every job: the system (merged-/usr links are recreated as links) and /etc.
const SYSTEM_RO = ["/usr", "/etc", "/opt", "/snap"];
const SYSTEM_LINKS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
// Toolchains people install in their home: read-only when present (sandbox.read_only_roots adds more; an engine module its own, `ro`).
const HOME_RO = ["~/.local/bin", "~/.local/lib", "~/.cargo", "~/.rustup", "~/go/bin", "~/.nvm", "~/.bun", "~/.deno", "~/.pyenv"];
const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * What a job sees of the host's files (bwrap): an allowlist, not the whole host. Read-only: the toolchains (/usr and its
 * links, /etc, /opt, the home's toolchains, node's own prefix), the runner's wrappers (cfg.ghWrapperDir), the pinned
 * headless browser (cfg.browserDir, for bin/aidenhq-browse) and `ro`. Read-write: `rw` (the task folder, the engine's state dirs). Copy-on-write:
 * `cow` (the build caches, each over the task's own layer; read-write binds when cfg.noOverlay). A private /tmp and an empty home
 * under them; the host's /dev and /sys, a procfs of the job's own. Nothing else exists in the job: other tasks' folders, the product
 * checkout, the services' data, the secrets, the runner's state and logs, the sockets. What cfg.gcp.hidden names inside
 * an allowed path is still masked: a directory gets an empty tmpfs, a file or socket /dev/null.
 */
export function layout(cfg, { rw = [], ro = [], cow = [] } = {}) {
  const home = homedir();
  const node = dirname(dirname(process.execPath));
  const roPaths = [...SYSTEM_RO, ...HOME_RO.map(expand), ...(cfg.sandbox?.read_only_roots ?? []).map(expand), ...(node.startsWith(home + sep) ? [node] : []), cfg.ghWrapperDir, cfg.browserDir, ...ro];
  // The host's /dev (a fresh --dev breaks the network jail's route setup), /proc and /sys.
  // Its own PID and IPC namespaces with a fresh procfs: no other process (the runner's environ, /proc/1/root) is visible.
  const args = ["--unshare-pid", "--unshare-ipc", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--ro-bind", "/sys", "/sys", "--tmpfs", "/tmp", "--tmpfs", home];
  for (const l of SYSTEM_LINKS) {
    const st = lstatSync(l, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) args.push("--symlink", readlinkSync(l), l);
    else if (st) args.push("--ro-bind", l, l);
  }
  // /run: only the host's resolver (the jail replaces it with its own tmpfs; without the jail it links into /run/systemd/resolve).
  if (existsSync("/run/systemd/resolve")) args.push("--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve");
  // Shallower paths first, so a deeper bind lands on top of its parent's.
  // `cow`: [host dir, the task's own upper dir] pairs, copy-on-write (overlayfs): the job reads the host dir and writes go
  // to the task's upper dir, so one job can't change what another reads (shared build caches).
  const mounts = [...roPaths.filter(Boolean).map((p) => ["--ro-bind", resolve(p)]), ...rw.filter(Boolean).map((p) => ["--bind", resolve(p)]), ...cow.map(([p, up]) => (cfg.noOverlay ? ["--bind", resolve(p)] : ["--overlay", resolve(p), up]))]
    .filter(([, p]) => existsSync(p))
    .sort((a, b) => a[1].split(sep).length - b[1].split(sep).length);
  for (const [how, p, up] of mounts) {
    if (how !== "--overlay") args.push(how, p, p);
    else {
      mkdirSync(join(up, "upper"), { recursive: true });
      mkdirSync(join(up, "work"), { recursive: true });
      args.push("--overlay-src", p, "--overlay", join(up, "upper"), join(up, "work"), p);
    }
  }
  const allowed = mounts.map(([, p]) => p);
  for (const p of (cfg.gcp?.hidden ?? []).filter((d) => existsSync(d) && allowed.some((a) => inside(d, a)))) {
    args.push(...(statSync(p).isDirectory() ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p]));
  }
  return args;
}

/** The whole run under bwrap with only the allowed paths (layout), in its own network when pasta is installed. */
export function hiding(cfg, argv, loopback = [], paths = {}) {
  if (!cfg.gcp) return argv; // no host layout (loadConfig always sets one): a unit test's fake engine, unconfined
  const mounts = layout(cfg, paths);
  if (cfg.pasta) return jailed(cfg, mounts, loopback, argv);
  return [cfg.bwrap ?? "bwrap", ...mounts, "--die-with-parent", "--", ...argv];
}

/** Why jobs can't get their own network here (no pasta, or a trial job failed), or undefined when they can. */
export function jailProblem(cfg) {
  if (!cfg.pasta) return "pasta is not installed (sudo apt-get install -y passt)";
  const [cmd, ...args] = hiding(cfg, ["true"]);
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000 });
  return r.status === 0 ? undefined : `a trial job failed (exit ${r.status ?? r.signal}): ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`;
}

/** Why this bwrap can't mount the copy-on-write cache layers (--overlay needs bubblewrap 0.11+), or undefined when it can. */
export function overlayProblem(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "aidenhq-overlay-"));
  try {
    for (const d of ["lower", "upper", "work"]) mkdirSync(join(dir, d));
    const r = spawnSync(cfg.bwrap ?? "bwrap", ["--ro-bind", "/", "/", "--overlay-src", join(dir, "lower"), "--overlay", join(dir, "upper"), join(dir, "work"), join(dir, "lower"), "true"], { encoding: "utf8", timeout: 20000 });
    return r.status === 0 ? undefined : `${(r.stderr || r.error?.message || "").trim().slice(0, 200) || `exit ${r.status ?? r.signal}`}`;
  } finally {
    removeLayers(dir);
  }
}

/** Remove a copy-on-write layer folder: Go's module cache and overlayfs's work dir are read-only, so made writable first. */
export function removeLayers(dir) {
  spawnSync("chmod", ["-R", "u+rwx", dir]);
  rmSync(dir, { recursive: true, force: true });
}

/** Host loopback ports of the given URLs (127.0.0.1 / localhost only): what a jailed job may reach on the host. */
export const loopbackPorts = (urls) =>
  [...new Set(urls.filter(Boolean).map((u) => new URL(u)).filter((u) => ["127.0.0.1", "localhost"].includes(u.hostname)).map((u) => Number(u.port || (u.protocol === "https:" ? 443 : 80))))].sort((a, b) => a - b);

// Unreachable from a job: private, shared, link-local, benchmark, reserved and "this network" ranges (the LAN, Docker
// bridges, the tailnet, cloud metadata), and every address of the host itself (a public one too). 127.0.0.0/8 stays the
// jail's own loopback (the local table wins), where pasta serves the allowed ports. pasta reaches the rest of the
// Internet from the host's side.
const BLOCKED = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "240.0.0.0/4"];
// The link to pasta (a /24: the job is .15, pasta's gateway .2): the first that overlaps none of the host's networks,
// so no host address is ever "on link" in the jail.
const LINKS = ["10.0.2", "172.31.254", "192.168.254", "100.127.254"];
const ipNum = (ip) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const overlaps = (a, alen, b, blen) => Math.floor(ipNum(a) / 2 ** (32 - Math.min(alen, blen))) === Math.floor(ipNum(b) / 2 ** (32 - Math.min(alen, blen)));
// From `ip`, not os.networkInterfaces(): that leaves out interfaces without carrier (an idle Docker bridge), whose
// addresses are still the host's.
const hostIPv4 = () =>
  [...execFileSync("ip", ["-4", "-o", "addr", "show"], { encoding: "utf8" }).matchAll(/ inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/g)].map((m) => ({ address: m[1], prefix: Number(m[2]) }));
// Every network the host routes to (a VPN's subnet has no host address on it): the link must avoid these too, or a
// destination "on link" in the jail could be one the host would forward somewhere real.
const hostRoutes = () =>
  [...execFileSync("ip", ["-4", "route", "show", "table", "all"], { encoding: "utf8" }).matchAll(/^(?:(?:unicast|local|broadcast|anycast|multicast|unreachable|blackhole|prohibit|throw)\s+)?(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?\s/gm)].map((m) => ({ address: m[1], prefix: m[2] ? Number(m[2]) : 32 }));

/**
 * The job in its own network namespace (src/netjail.ts): Internet egress through pasta, and of the host's loopback
 * only the ports it was given (the run's helper, the read-only MCP endpoints it is wired to). Every other loopback
 * service (the board, Paperclip, apps trusting loopback callers), the host's other addresses and the LAN are out of
 * reach. The job's first step sets the unreachable routes, then drops the capabilities it used (bounding set too).
 */
function jailed({ pasta, bwrap = "bwrap" }, masks, loopback, argv) {
  const ports = loopbackPorts(loopback).join(",") || "none";
  const host = hostIPv4();
  const nets = [...host, ...hostRoutes()];
  const link = LINKS.find((l) => nets.every((a) => !overlaps(`${l}.0`, 24, a.address, a.prefix)));
  if (!link) throw new Error("no free subnet for the job's network link: every candidate overlaps a host network");
  const unreachable = [...BLOCKED, ...host.filter((a) => !a.address.startsWith("127.")).map((a) => `${a.address}/32`)];
  const inner = `for n in ${unreachable.join(" ")}; do PATH="/usr/sbin:/sbin:$PATH" ip route add unreachable "$n" || exit 1; done; exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- "$@"`;
  return [
    process.execPath, join(import.meta.dirname, "netjail.ts"), pasta, ports, link,
    // The public resolvers go where /etc/resolv.conf leads (systemd-resolved's stub-resolv.conf), on a private tmpfs:
    // bound onto the host's own file, the bind came off the first time resolved rewrote it (a rename over a mountpoint
    // detaches it in every namespace), and the job was left with 127.0.0.53, unreachable in its network.
    bwrap, ...masks, "--tmpfs", "/run/systemd/resolve", "--ro-bind-data", "5", "/etc/resolv.conf",
    "--unshare-net", "--cap-add", "CAP_NET_ADMIN", "--cap-add", "CAP_SETPCAP", "--info-fd", "3", "--block-fd", "4", "--die-with-parent",
    "--", "/bin/sh", "-c", inner, "aidenhq-jail", ...argv,
  ];
}

/**
 * The registry of engines (config/engines.json, compiled from the modules' providers.engine): kind → { module, dir, bin,
 * live_input, label, gateway, box, state, reset, seed, rw, secret_env, … }. The runner knows engines only through it.
 */
export const readEngines = (cfg) => { try { return JSON.parse(readFileSync(cfg.enginesFile, "utf8")); } catch { return {}; } };
export function engineEntry(cfg, kind) {
  const e = readEngines(cfg)[kind];
  if (!e) throw new Error(`no engine module provides "${kind}" (config/engines.json: enable its module and apply)`);
  return e;
}
/** Engines whose model calls go through the model gateway with the job's own token: billed and capped there. */
export const viaGateway = (cfg, kind) => readEngines(cfg)[kind]?.gateway === true;
const fromProduct = (p) => resolve(REPO_ROOT, p);
export const MODEL_TOKEN_ENV = "AIDENHQ_MODEL_TOKEN";

/**
 * The engine's state folder for this run (its sessions persist for a resume): under the runner's state dir, one per kind
 * (`state: shared`) or per kind and task (`state: task`, no task reads another's transcripts), made 0700. Its `reset` names
 * are removed and its `seed` copied in from the module (or the product) first, so no run leaves instructions, config, hooks
 * or skills for a later one. Undefined for an engine without one.
 */
export function engineState(cfg, kind, issueId) {
  const e = engineEntry(cfg, kind);
  if (!e.state) return undefined;
  const dir = join(cfg.stateDir, kind, ...(e.state === "task" ? [String(issueId ?? "none").replace(/[^\w.-]/g, "_")] : []));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of e.reset ?? []) rmSync(join(dir, f), { recursive: true, force: true });
  for (const { from, to } of e.seed ?? []) {
    const src = from.startsWith("/") ? fromProduct(from.slice(1)) : join(fromProduct(e.dir), from);
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    cpSync(src, join(dir, to), { recursive: true, filter: (p) => !/[\\/](node_modules|dist)$/.test(p) });
  }
  return dir;
}

// A session id an engine reported, before it goes on a command line.
const SESSION = /^[\w.:-]{1,200}$/;

/**
 * One run of an engine under engine@1: job.json in the job dir, then the module's bin with the job dir as its argument. bwrap
 * (hiding) is the write boundary; the engine sees its module folder read-only, and read-write the task folder, the job dir,
 * its state folder and home folders (rw), and the job's gcloud session. `gcp` is that session, for engines that observe.
 * `loopback`: further host URLs the job may reach (the run's helper), besides the model gateway (its model calls and its
 * jobcaps). A box job runs the same bin in its computer (services/computer), its job dir inside the launcher's out folder.
 */
export function buildJob({ cfg, engine, worktree, jobDir, sessionId, prompt = "", gcp, loopback = [], job = {}, box, gh = false }) {
  const entry = engineEntry(cfg, engine.kind);
  const caps = box ? [] : jobcapsFor(cfg, engine, job.jobcaps);
  job = { ...job, jobcaps: caps, observing: observes(engine) };
  const servers = jobcapServers(cfg, caps);
  let minted;
  const token = () => (minted ??= jobToken(cfg, job)); // one credential per job: its model calls and its reads
  const search = observes(engine) || servers.some((s) => s.private) ? "disabled" : "live"; // no web search for a job holding private data
  gcp = observes(engine) && !box ? gcp : undefined;
  const gcpRoots = gcp ? [gcp.root] : [];
  const state = box ? undefined : engineState(cfg, engine.kind, job.issueId);
  const secrets = Object.fromEntries(Object.entries(box ? {} : entry.secret_env ?? {}).map(([k, f]) => {
    const file = join(cfg.secretsDir, f);
    if (!existsSync(file)) throw new Error(`The ${entry.label ?? engine.kind} engine isn't set up for the runner: save its token to \`${file}\` (0600).`);
    return [k, readFileSync(file, "utf8").trim()];
  }));
  const env = { ...(servers.length ? { [JOB_TOKEN_ENV]: token() } : {}), ...(entry.gateway && !box ? { [MODEL_TOKEN_ENV]: token() } : {}), ...(gcp?.env ?? {}), ...secrets };
  const extra = (cfg.sandbox?.extra_writable_roots ?? []).map(expand);
  const spec = {
    contract: "engine@1", job: basename(jobDir), agent: job.agentId ?? "", task: job.issueId ?? "", prompt,
    ...(sessionId && SESSION.test(sessionId) ? { session: sessionId } : {}),
    model: { base_url: box ? `${cfg.boxGatewayUrl ?? "http://10.231.2.1:8200"}/api/v1` : entry.gateway ? gatewayApi(cfg) : "", token_env: box ? "AIDENHQ_RUN_TOKEN" : MODEL_TOKEN_ENV, id: engine.model ?? "", effort: engine.effort ?? "" },
    mcp: servers.map((s) => ({ name: s.name, url: s.url, token_env: JOB_TOKEN_ENV, ...(s.toolTimeout ? { tool_timeout_s: s.toolTimeout } : {}) })),
    env: Object.keys(env), limits: { timeout_s: (cfg.timeout_minutes ?? 60) * 60 }, web: search === "live",
    ...(state ? { state } : {}),
    sandbox: { kind: box ? "box" : "bwrap", writable: [worktree, ...gcpRoots, ...extra.filter((p) => existsSync(p))], network: cfg.sandbox?.network !== false },
  };
  const bin = relative(entry.dir, entry.bin);
  if (box) {
    // The box's own job dir (/aidenhq-out/job) and the engine module the launcher mounted read-only.
    writeFileSync(join(jobDir, "job.json"), JSON.stringify(spec), { mode: 0o600, flag: "wx" });
    // `gh`: the job's read-only gh token, passed by name from the docker client's env (never argv or the env file).
    const argv = ["docker", "exec", "--env-file", box.envFile, ...(gh ? ["-e", "GH_TOKEN", "-e", "AIDENHQ_GH_AUTH"] : []), "-w", "/workspace", box.container, "sh", "-c", BOX_EXEC_WRAP, "aidenhq-computer", join("/opt/aidenhq/engine", bin), "/aidenhq-out/job"];
    return { argv, env: {}, spec, entry };
  }
  writeFileSync(join(jobDir, "job.json"), JSON.stringify(spec), { mode: 0o600, flag: "wx" });
  // The model gateway (OpenRouter engines' model calls) and every job's jobcaps, on host loopback (forwarded into the jail).
  const mcp = entry.gateway || caps.length ? [gatewayUrl(cfg)] : [];
  const rw = [worktree, jobDir, ...(state ? [state] : []), ...(entry.rw ?? []).map(expand), ...(entry.gcloud === false ? [] : gcpRoots)];
  // The shared build caches (sandbox.extra_writable_roots: ~/.npm, ~/.cache): copy-on-write per task, never written back,
  // so no job can poison another's packages or build outputs. The task's writes stay in its own layer outside the jail.
  const cow = extra.map((p, i) => [p, join(cowRoot(cfg, worktree), `${i}-${basename(p)}`)]);
  // The clones' core.hooksPath (git.mjs ensureGuardHooks: a pre-push that refuses), read-only; the engine's module folder.
  const ro = [...(cfg.workDir ? [join(cfg.workDir, ".guard-hooks")] : []), fromProduct(entry.dir), ...(entry.ro ?? []).map(expand)];
  return { argv: hiding(cfg, [process.execPath, fromProduct(entry.bin), jobDir], [...mcp, ...loopback], { rw, ro, cow }), env, spec, entry };
}

export const gatewayUrl = (cfg) => cfg.gatewayUrl ?? "http://127.0.0.1:8201";
/** A task's copy-on-write cache layers: beside the task folders, never inside one (no job sees another's, or its own raw). */
export const cowRoot = (cfg, worktree) => join(cfg.workDir ?? dirname(dirname(worktree)), ".cache-layers", basename(worktree));

/** The runner's client for the launcher's job routes (bearer computers_runner_key). Rejects with `status` on an error answer. */
export function launcher(cfg) {
  return async (route, body) => {
    let key = "";
    try { key = readFileSync(cfg.computersRunnerKeyFile, "utf8").trim(); } catch {}
    const r = await fetch(`${cfg.launcherUrl}${route}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`launcher ${route}: ${out.error ?? r.status}`), { status: r.status });
    return out;
  };
}

/**
 * Destroy a job's box and wait until Docker says it is gone: killing the `docker exec` client stops nothing inside the box, so
 * nothing may inspect, sign or clean the workspace before this resolves. Retried (launcher down, Docker slow); throws if the box
 * can't be confirmed gone in time (the lease then reaps it within 15 minutes).
 */
export async function releaseBox(call, container, { everyMs = 2000, forMs = 20 * 60_000 } = {}) {
  let last = "";
  for (const end = Date.now() + forMs; ; ) {
    const r = await call("/job/release", { container }).catch((e) => ({ error: e.message }));
    if (r.state === "missing") return;
    last = r.error ?? `state ${r.state}`;
    if (Date.now() > end) throw new Error(`the job's box ${container} couldn't be confirmed gone (${last}); its workspace stays untouched until it is`);
    await new Promise((res) => setTimeout(res, everyMs));
  }
}

/**
 * A model credential for the gateway (kernel/src/gateway/token.ts), signed with gateway_job_secret: a job's (kind agent, capped,
 * billed to its Engineer and task) or the runner's own (reviewer, grader, intake). Never the OpenRouter key.
 */
export function modelToken(cfg, claims, now = Date.now()) {
  let secret = "";
  try { secret = readFileSync(cfg.gatewayJobSecretFile, "utf8").trim(); } catch {}
  return mintToken(secret, claims, now);
}
export const gatewayApi = (cfg) => `${gatewayUrl(cfg)}/api/v1`;

/**
 * The job's own credential to the model gateway, valid past its deadline (an adopted run keeps its env). Minted from the job's
 * agent, task, jobcaps and start time (`job.at`), so the same job always gets the same token: its `aidenhq advise` calls, also
 * from a runner that adopted it after a restart, share its run key (the same run cap and run page).
 */
export const jobToken = (cfg, job) => job.token ?? modelToken(cfg, { kind: "agent", agentId: job.agentId ?? null, issueId: job.issueId ?? null, jobcaps: [...(job.jobcaps ?? [])].sort(), observing: job.observing === true, ttlMs: ((cfg.timeout_minutes ?? 60) + 60) * 60_000 }, job.at);

/**
 * Each run's command under a small `sh` that records its exit status in `<log>.exit`, in a process
 * group of its own, writing straight to its log: nothing ties it to the runner, so a runner restart
 * (a deploy) leaves it running and the next runner adopts it (`adoptRun`). The shell stays the
 * engine's parent (bwrap's --die-with-parent) and outlives a stop's SIGTERM to record the status.
 */
// Builtins only: the job's PATH may not have the engine (exit 127), or anything else.
const WRAP = 'trap : TERM INT HUP; "$@"; echo "$?" > "$0"';
const exitStatus = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
const POLL_MS = 250;
/** A run's job dir: beside its log, never in the task folder (a box job's: in its launcher out folder). */
export const jobDirOf = (logPath, box) => (box ? join(box.outDir, "job") : `${logPath}.job`);

/**
 * Start the agent; returns the run for `watchAgent`. For an engine that takes comments while it works (`live_input`),
 * `channel.send(text)` appends one to the job's inbox.jsonl and returns false once the run is over
 * (docs/design/conversational-engineers.md, During a run). An adopted run has no input: its runner is gone.
 * The agent's environment: no SSH agent (fetch only via the runner), read-only gh first on PATH (reading with
 * `ghToken`, a read-only App token for the task's repos), and a git ssh wrapper that refuses pushes.
 */
export function startAgent({ cfg, engine, worktree, prompt, sessionId, logPath, env: jobEnv = {}, gcp, channel, identity = DEFAULT_IDENTITY, ghToken, job, box }) {
  const jobDir = jobDirOf(logPath, box);
  mkdirSync(jobDir, { mode: 0o700 }); // new for every run: nothing of the job's is in it yet
  const { argv, env, entry } = buildJob({ cfg, engine, worktree, jobDir, sessionId, prompt, gcp, loopback: [jobEnv.AIDENHQ_REPO_URL], job, box, gh: Boolean(ghToken) });
  // A box job's client gets only what Docker needs; the job gets the launcher's env file, plus its gh token (docker exec -e).
  const agentEnv = box
    ? { ...Object.fromEntries(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])), ...(ghToken ? { GH_TOKEN: ghToken, AIDENHQ_GH_AUTH: ghToken } : {}) }
    : {
        ...process.env,
        ...env,
        // The private bwrap's folder too, so an engine's own sandbox in the job uses it (it takes the first bwrap on PATH).
        PATH: [cfg.ghWrapperDir, ...(cfg.bwrap?.startsWith("/") ? [dirname(cfg.bwrap)] : []), process.env.PATH].join(":"),
        GIT_SSH_COMMAND: join(cfg.ghWrapperDir, "git-ssh-no-push"),
        GIT_TERMINAL_PROMPT: "0",
        // The agent's git sees the commits the runner will publish, not replacements (the runner's git ignores them too).
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_GRAFT_FILE: "/dev/null",
        AIDENHQ_TASK_WORKTREE: worktree,
        AIDENHQ_BROWSER_DIR: cfg.browserDir,
        // The agent's commits are the App's bot (or AidenHQ agent), never the owner's identity.
        ...identityEnv(identity),
        // The agent commits unsigned (it has no SSH agent to sign with); the runner signs its commits
        // after the run.
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "tag.gpgsign",
        GIT_CONFIG_VALUE_1: "false",
        ...jobEnv,
      };
  if (!box) {
    delete agentEnv.SSH_AUTH_SOCK;
    // A GitHub token in the runner's environment is never the agent's. Its gh reads with `ghToken` (a GitHub App token
    // narrowed to the task's repos, read-only) or nothing: the user's own gh sign-in is hidden from jobs (cfg.gcp.hidden).
    delete agentEnv.GH_TOKEN;
    delete agentEnv.GITHUB_TOKEN;
    // Twice: some engines drop *TOKEN* variables from their tool calls, so the gh wrapper also takes AIDENHQ_GH_AUTH.
    if (ghToken) Object.assign(agentEnv, { GH_TOKEN: ghToken, AIDENHQ_GH_AUTH: ghToken });
    // Never a prompt on the user's desktop: without credentials, git over https and ssh would fall back
    // to the session's askpass dialog (seahorse) and pop it up for every private Go module or repo.
    delete agentEnv.SSH_ASKPASS;
    agentEnv.SSH_ASKPASS_REQUIRE = "never";
    agentEnv.GIT_ASKPASS = "false";
  }

  appendFileSync(logPath, `# ${new Date().toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in ${box ? `box ${box.container} (${worktree})` : worktree}\n`);
  const out = openSync(logPath, "a");
  const child = spawn("/bin/sh", ["-c", WRAP, `${logPath}.exit`, ...argv], { cwd: box ? "/" : worktree, env: agentEnv, detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  const run = { pid: child.pid, logPath, jobDir, program: engine.kind, offset: 0 };
  // Only /bin/sh itself failing to start lands here; a missing engine is the shell's exit 127.
  child.on("error", (e) => (run.spawnError = `couldn't start /bin/sh: ${e.code ?? e.message}`));
  child.unref();
  if (channel && entry.live_input) channel.send = (text) => sendComment(run, text);
  return run;
}

/** A comment into a live run's inbox.jsonl: false once the run is over or has given its final answer. */
function sendComment(run, text) {
  run.refresh?.();
  if (run.over || run.final !== undefined || exitStatus(`${run.logPath}.exit`) || !alive(run.pid)) return false;
  try {
    appendLine(join(run.jobDir, "inbox.jsonl"), { t: "comment", from: "owner", text: String(text) });
    return true;
  } catch {
    return false; // the inbox isn't a regular file (the job's doing): the comment waits for the next turn
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** True while the run's shell (pid) is alive and is still that run (not a reused pid): for adopting it. */
export function runAlive(pid, logPath) {
  try {
    return alive(pid) && execFileSync("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).includes(`${logPath}.exit`);
  } catch {
    return false;
  }
}

/** A run another runner process started (a restart): followed from its files, with no input channel, from `offset`. */
export const adoptRun = ({ pid, logPath, jobDir, offset = 0 }) => ({ pid, logPath, jobDir, offset, adopted: true });

/**
 * New engine events from `offset` in a job's events.jsonl: never through a link, a regular file only, each line capped. The
 * content is the job's (untrusted): a malformed line or an unknown event is skipped. A truncated file starts over.
 */
export function readEvents(jobDir, offset = 0) {
  const file = join(jobDir, "events.jsonl");
  const size = (() => { try { return lstatSync(file).size; } catch { return 0; } })();
  if (size < offset) offset = 0;
  const buf = readFrom(file, offset, 4 << 20);
  const { values, used } = lines(buf);
  // A line longer than one read is skipped whole, not waited on forever.
  const next = offset + (used || (buf.length === 4 << 20 ? buf.length : 0));
  const events = values.filter((e) => e && typeof e === "object" && ["progress", "usage", "session", "final"].includes(e.t));
  return { events, offset: next, skipped: values.length - events.length };
}

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Steps show command lines on the board: blank the usual secret shapes first, whatever the engine sent.
const redact = (t) =>
  t
    .replace(/(Bearer|Basic|token)\s+[^\s'"]+/gi, "$1 …")
    .replace(/:\/\/[^/\s@]+@/g, "://…@")
    .replace(/([?&](?:token|key|secret|password|sig|access_token)=)[^&\s'"]+/gi, "$1…")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS)[A-Z0-9_]*)=[^\s'"]+/g, "$1=…")
    .replace(/\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|AKIA)[A-Za-z0-9_-]+/g, "$1…");
const PLAN = (p) => (Array.isArray(p) ? p.slice(0, 20).map((i) => ({ text: clip(i?.step, 200), state: i?.done ? "done" : i?.doing ? "doing" : "todo" })).filter((i) => i.text) : undefined);
const STEPS = (s) => (Array.isArray(s) ? s.slice(-30).map((x) => ({ at: typeof x?.at === "string" ? x.at.slice(0, 40) : new Date().toISOString(), kind: "tool", text: clip(redact(String(x?.text ?? "")), 200) })) : undefined);

/**
 * Follow a run to its end: its events (from the run's offset), its exit file, the deadline and a stop request. Resolves with
 * { code, sessionId, lastMessage, timedOut, stalled, stopped, cancelled, usage, offset }, or { detached: true, offset, sessionId }
 * once `detach` aborts (the runner is restarting and leaves the run to its successor, which goes on from that offset).
 * `progress` (progress.ts) stops a run that makes none (`stopped` says why) and moves the deadline out while it waits on CI.
 * `onProgress({ said, saidAt, plan, steps })` gets the agent's latest words, task list and tool calls as they change.
 */
export function watchAgent(run, { sessionId, deadline, stallMs = 15 * 60_000, signal, detach, channel, onProgress, progress }) {
  const { pid, logPath, jobDir } = run;
  const exitFile = `${logPath}.exit`;
  const lastMessageFile = `${logPath}.last.md`;
  return new Promise((resolve) => {
    let found = sessionId;
    let said;
    const usage = { input: 0, cached: 0, output: 0, seen: false };
    // When the log or the events last grew: a run silent for stallMs (a model call that never answers) is stopped as
    // stalled, so it doesn't hold its task, and the writes waiting on it, until the deadline.
    let grewAt = Date.now();
    let logSize = 0;
    const read = () => {
      try {
        const size = statSync(logPath).size;
        if (size > logSize) (logSize = size), (grewAt = Date.now());
      } catch {}
      let got;
      try {
        got = readEvents(jobDir, run.offset);
      } catch {
        return; // not a regular file: the job's own doing, nothing of it is read
      }
      if (got.offset !== run.offset) grewAt = Date.now();
      run.offset = got.offset;
      for (const e of got.events) {
        if (e.t === "session" && typeof e.id === "string" && SESSION.test(e.id)) found = e.id;
        if (e.t === "final" && typeof e.text === "string") run.final = e.text;
        if (e.t === "usage") {
          for (const k of ["input", "cached", "output"]) usage[k] += Number.isFinite(e[k]) && e[k] > 0 ? e[k] : 0;
          usage.seen = true;
        }
        if (e.t === "progress") {
          progress?.add(STEPS(e.steps));
          const text = clip(e.text, 600);
          if (text && text !== said) (said = text), (run.saidAt = new Date().toISOString());
          onProgress?.({ ...(said ? { said, saidAt: run.saidAt } : {}), ...(PLAN(e.plan)?.length ? { plan: PLAN(e.plan) } : {}), ...(STEPS(e.steps)?.length ? { steps: STEPS(e.steps) } : {}) });
        }
      }
    };
    run.refresh = read;

    let timedOut = false;
    let stalled = false;
    let stopped;
    let cancelled = false;
    let killed = false;
    const kill = () => {
      killed = true;
      try {
        process.kill(-pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }, 10_000).unref();
      } catch {}
    };
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    let timer;
    const end = (then) => {
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      detach?.removeEventListener("abort", onDetach);
      then();
    };
    const onDetach = () => end(() => resolve({ detached: true, offset: run.offset, sessionId: found }));
    const done = () =>
      end(() => {
        read();
        run.over = true;
        if (channel) channel.send = () => false;
        const status = exitStatus(exitFile);
        const code = status === "" ? null : Number(status);
        let lastMessage = String(run.final ?? "").trim();
        const startError = run.spawnError || (code === 127 && `couldn't start ${run.program ?? "the engine"}: ENOENT`);
        if (!lastMessage && startError) {
          appendFileSync(logPath, `# ${startError}\n`);
          lastMessage = `The job couldn't start: ${startError}.`;
        }
        if (lastMessage) writeFileSync(lastMessageFile, lastMessage);
        // No status: the run died without its shell, by its own stop or timeout (killed), else by hand (a failure).
        resolve({ code: code === null && !killed ? 1 : code, sessionId: found, lastMessage, timedOut, stalled, stopped, cancelled, offset: run.offset, ...(usage.seen ? { usage: { input: usage.input, cached: usage.cached, output: usage.output, costUsd: null } } : {}) });
      });
    const tick = () => {
      read();
      if (exitStatus(exitFile) || !pid || run.spawnError || !alive(pid)) return done();
      if (!timedOut && Date.now() > (progress?.deadline(deadline) ?? deadline)) {
        timedOut = true;
        kill();
      }
      if (!timedOut && (stopped = progress?.check())) {
        timedOut = true;
        kill();
      }
      if (!timedOut && !progress?.waiting && Date.now() - grewAt > stallMs) {
        timedOut = stalled = true;
        kill();
      }
    };
    if (detach?.aborted) return onDetach();
    signal?.addEventListener("abort", onAbort);
    detach?.addEventListener("abort", onDetach);
    timer = setInterval(tick, POLL_MS);
    tick();
  });
}

/** Start the agent and follow it to its end (startAgent + watchAgent). */
export function runAgent({ cfg, signal, detach, onProgress, channel, ...opts }) {
  const run = startAgent({ cfg, channel, ...opts });
  return watchAgent(run, { sessionId: opts.sessionId, deadline: Date.now() + (cfg.timeout_minutes ?? 60) * 60_000, stallMs: (cfg.stall_minutes ?? 15) * 60_000, signal, detach, channel, onProgress });
}

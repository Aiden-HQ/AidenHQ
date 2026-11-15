import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DEFAULT_IDENTITY, identityEnv } from "./github-app.ts";
import { appendFileSync, closeSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { progressTracker } from "./progress.ts";
import { mintToken } from "../../gateway/token.ts";
import { CODEX_CONFIG_SCRUB } from "../../computer/lib.mjs";
import { smallFile } from "./git.mjs";

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function sandboxConfig(cfg, worktree, stateRoots = []) {
  const roots = [worktree, ...stateRoots, ...(cfg.sandbox?.extra_writable_roots ?? []).map(expand)].filter((p) => existsSync(p) || p === worktree);
  return [
    "-c", 'sandbox_mode="workspace-write"',
    "-c", `sandbox_workspace_write.network_access=${cfg.sandbox?.network === false ? "false" : "true"}`,
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    "-c", 'approval_policy="never"',
  ];
}

/** `codex sandbox` around a whole process: writes only in the worktree, the given state dirs and the build caches. */
function codexSandbox(cfg, worktree, stateRoots, argv) {
  return [
    "codex", "sandbox",
    "-c", 'sandbox_mode="workspace-write"',
    "-c", "sandbox_workspace_write.network_access=true", // the engine itself talks to its model API
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([worktree, ...stateRoots, ...(cfg.sandbox?.extra_writable_roots ?? []).map(expand)])}`,
    "--", ...argv,
  ];
}

// Claude Code's built-in tools for coding jobs. Everything else (scheduling, remote triggers,
// notifications, messaging, workflows) is left out; MCP servers, plugins and claude.ai connectors
// are off entirely.
// TaskCreate/TaskUpdate/TaskList: the agent's own task list, which the board shows while it works.
const CLAUDE_TOOLS = "Bash,Read,Edit,Write,NotebookEdit,Task,TaskStop,TaskCreate,TaskUpdate,TaskList,WebFetch,WebSearch";

/**
 * Primer, read-only, for every engine: primer-mcp's /mcp/read on loopback. The bearer token
 * goes in through the environment (PRIMER_MCP_TOKEN), never on the command line. Skipped until
 * Primer is set up.
 */
function primer(cfg) {
  if (!cfg.primerMcpUrl || !cfg.primerTokenFile || !existsSync(cfg.primerTokenFile)) return undefined;
  return { url: cfg.primerMcpUrl, token: readFileSync(cfg.primerTokenFile, "utf8").trim() };
}

/**
 * Whether a job gets the private reads (Grafana, Slack, Glean, ClickHouse), its gcloud session and other tasks: only an
 * Engineer whose definition opts in (`private_reads: true`, setup's metadata.privateReads; commands.mjs pickedEngine), on
 * any engine. Such a job gets no web search, so private data can't leave through search queries. Light Engineers (the
 * Software and Platform Engineers) don't: they get Primer and web search.
 */
export const observes = (engine) => engine?.reads === true;

/** Engines whose model calls go through the model gateway with the job's own token: billed and capped there. */
export const viaGateway = (kind) => kind === "openrouter" || kind === "codex-openrouter";

/**
 * The private reads for the engines that observe: Grafana, Slack and Glean,
 * the user's own messages and the company's documents, and ClickHouse, production data. Each is an MCP server on loopback that serves
 * reads only, with a token the job gets through the environment, never on the command line. Skipped
 * until set up.
 */
const PRIVATE_READS = [
  { name: "grafana", url: "grafanaMcpUrl", tokenFile: "grafanaTokenFile", env: "GRAFANA_MCP_TOKEN" },
  { name: "slack", url: "slackMcpUrl", tokenFile: "slackTokenFile", env: "SLACK_MCP_TOKEN" },
  { name: "glean", url: "gleanMcpUrl", tokenFile: "gleanTokenFile", env: "GLEAN_MCP_TOKEN" },
  // Queries run up to two minutes (clickhouse-mcp caps them), past Codex's 60-second tool timeout.
  { name: "clickhouse", url: "clickhouseMcpUrl", tokenFile: "clickhouseTokenFile", env: "CLICKHOUSE_MCP_TOKEN", toolTimeout: 180 },
];
export function privateReads(cfg) {
  return PRIVATE_READS.filter((s) => cfg[s.url] && cfg[s.tokenFile] && existsSync(cfg[s.tokenFile])).map((s) => ({
    name: s.name,
    url: cfg[s.url],
    env: s.env,
    ...(s.toolTimeout ? { toolTimeout: s.toolTimeout } : {}),
    token: readFileSync(cfg[s.tokenFile], "utf8").trim(),
  }));
}

// The host's toolchains, read-only in every job: the system (merged-/usr links are recreated as links) and /etc.
const SYSTEM_RO = ["/usr", "/etc", "/opt", "/snap"];
const SYSTEM_LINKS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
// Toolchains people install in their home: read-only when present (sandbox.read_only_roots adds more).
const HOME_RO = ["~/.local/bin", "~/.local/lib", "~/.local/share/claude", "~/.cargo", "~/.rustup", "~/go/bin", "~/.nvm", "~/.bun", "~/.deno", "~/.pyenv"];
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
 * Command line for one engine run. Codex sandboxes its own tool calls; opencode and Claude Code run
 * inside `codex sandbox`. `gcp` is the job's gcloud session (src/gcp.mjs), for engines that observe.
 * `loopback`: further host URLs the job may reach (the run's helper), besides the MCP endpoints it is wired to.
 */
export function buildCommand({ cfg, engine, worktree, sessionId, lastMessageFile, gcp, loopback = [], job = {}, box }) {
  if (engine.box) return boxCommand({ cfg, engine, sessionId, job, box });
  const built = engineCommand({ cfg, engine, worktree, sessionId, lastMessageFile, gcp: observes(engine) ? gcp : undefined, job });
  // OpenRouter engines' model calls go to the model gateway on host loopback (forwarded into the job's network jail).
  const mcp = [primer(cfg)?.url, ...(observes(engine) ? privateReads(cfg).map((r) => r.url) : []), ...(viaGateway(engine.kind) ? [gatewayUrl(cfg)] : [])];
  // The engine writes its last message there (-o): the file alone is bound, made beforehand (bwrap binds what exists).
  if (lastMessageFile && !existsSync(lastMessageFile)) try { writeFileSync(lastMessageFile, ""); } catch {}
  const rw = [worktree, ...(built.rw ?? []), lastMessageFile];
  // The shared build caches (sandbox.extra_writable_roots: ~/.npm, ~/.cache): copy-on-write per task, never written back,
  // so no job can poison another's packages or build outputs. The task's writes stay in its own layer outside the jail.
  const cow = (cfg.sandbox?.extra_writable_roots ?? []).map(expand).map((p, i) => [p, join(cowRoot(cfg, worktree), `${i}-${basename(p)}`)]);
  // The clones' core.hooksPath (git.mjs ensureGuardHooks: a pre-push that refuses), read-only.
  const ro = cfg.workDir ? [join(cfg.workDir, ".guard-hooks")] : [];
  return { ...built, argv: hiding(cfg, built.argv, [...mcp, ...loopback], { rw, ro, cow }) };
}

export const gatewayUrl = (cfg) => cfg.gatewayUrl ?? "http://127.0.0.1:8201";
/** A task's copy-on-write cache layers: beside the task folders, never inside one (no job sees another's, or its own raw). */
export const cowRoot = (cfg, worktree) => join(cfg.workDir ?? dirname(dirname(worktree)), ".cache-layers", basename(worktree));

// ------------------------------------------------------------------ box jobs (the App Engineer)
/** A box job's last message: a folder of the launcher's mounted at /aidenhq-out (outDir on the host), never the workspace. */
export const boxLastFile = (box) => join(box.outDir, "last.txt");

/**
 * A box job's command: Codex in the job's gVisor box (services/computer, POST /job), through `docker exec` with the env file
 * the launcher wrote (run token, granted connections, identity; nothing of the runner's env). The box is the boundary, so
 * Codex's own sandbox is off (it broke Chrome in computers); the model goes through the launcher's gateway with the run token
 * as the key, and the launcher's scrub appends the agent's connections to the Codex home's config first. Web search is
 * on unless the Engineer has private reads (its granted connections, checked at compile). The runner's Codex home for the task (AGENTS.md and skills reset here) is /codex-home.
 */
function boxCommand({ cfg, engine, sessionId, job, box }) {
  if (!box?.container || !box.envFile) throw new Error("a box job needs its box (POST /job) before it starts");
  codexHome(cfg, job.issueId);
  const base = sessionId ? ["codex", "exec", "resume", sessionId] : ["codex", "exec"];
  const args = [
    ...base, "--json", "--skip-git-repo-check", "-o", "/aidenhq-out/last.txt",
    "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"',
    ...(engine.model ? ["-m", engine.model] : []),
    ...(engine.effort ? ["-c", `model_reasoning_effort="${engine.effort}"`] : []),
    // Private reads (granted connections that read private data; setup's privateReads): no web search, as for every Engineer.
    "-c", `web_search="${observes(engine) ? "disabled" : "live"}"`,
    "-c", 'model_provider="or"',
    "-c", 'model_providers.or.name="OpenRouter"',
    "-c", `model_providers.or.base_url=${JSON.stringify(`${cfg.boxGatewayUrl ?? "http://10.231.2.1:8200"}/api/v1`)}`,
    "-c", 'model_providers.or.env_key="AIDENHQ_RUN_TOKEN"',
    "-c", 'model_providers.or.wire_api="responses"',
    // The box's env holds only the run's own revocable token, which its shell tools need (aidenhq, MCP through the gateway).
    "-c", "shell_environment_policy.ignore_default_excludes=true",
    ...CODEX_OFF.flatMap((f) => ["-c", `features.${f}=false`]),
    "-",
  ];
  const argv = ["docker", "exec", "-i", "--env-file", box.envFile, "-w", "/workspace", box.container, "sh", "-c", CODEX_CONFIG_SCRUB, "aidenhq-computer", ...args];
  return { argv, env: {} };
}

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
 * A model credential for the gateway (services/gateway/token.ts), signed with gateway_job_secret: a job's (kind agent, capped,
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
 * agent, task and start time (`job.at`), so the same job always gets the same token: its `aidenhq advise` calls, also from a
 * runner that adopted it after a restart, share its run key (the same run cap and run page).
 */
export const jobToken = (cfg, job) => job.token ?? modelToken(cfg, { kind: "agent", agentId: job.agentId ?? null, issueId: job.issueId ?? null, ttlMs: ((cfg.timeout_minutes ?? 60) + 60) * 60_000 }, job.at);

const GATEWAY_KEY_ENV = "AIDENHQ_GATEWAY_KEY";
// Off for codex-openrouter, as for Paperclip's Codex agents: ChatGPT connectors, the desktop's browser and computer, OpenAI's
// image tool, memories across runs, hooks, and plugins fetched from marketplaces (unpinned code).
const CODEX_OFF = ["apps", "browser_use", "browser_use_external", "in_app_browser", "computer_use", "image_generation", "memories", "hooks", "plugins", "remote_plugin", "recommended_plugins", "plugin_discovery_prefetch", "tool_suggest"];
const PRODUCT_CODEX_HOME = join(import.meta.dirname, "..", "codex-home");
const PRODUCT_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * codex-openrouter's CODEX_HOME: one per task under the runner's state dir (its sessions persist for `exec resume`; no task
 * reads another's transcripts), outside the codex sandbox's writable roots. AGENTS.md and skills/ are copied from the
 * product at every start and anything else but the sessions and Codex's own state is removed, so no run leaves
 * instructions, config, hooks or skills for a later one. No config.toml or auth.json: everything is set on the command line.
 */
export function codexHome(cfg, issueId) {
  const home = join(cfg.codexOpenrouterHome, String(issueId ?? "none").replace(/[^\w.-]/g, "_"));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const f of ["AGENTS.md", "AGENTS.override.md", "skills", "config.toml", "auth.json", "hooks.json", "rules", "plugins", ".agents"]) rmSync(join(home, f), { recursive: true, force: true });
  cpSync(join(PRODUCT_CODEX_HOME, "AGENTS.md"), join(home, "AGENTS.md"));
  cpSync(join(PRODUCT_CODEX_HOME, "skills"), join(home, "skills"), { recursive: true });
  // The skills' resources, from the product (a job can't read the product checkout): the design system and the version picker.
  cpSync(join(PRODUCT_ROOT, "modules/core/design-system"), join(home, "skills/design-system/files"), { recursive: true });
  // The app starter new apps are copied from (a host checkout may hold its node_modules and dist: never copied).
  cpSync(join(PRODUCT_ROOT, "modules/core/templates/app"), join(home, "skills/design-system/starter"), { recursive: true, filter: (src) => !/[\\/](node_modules|dist)$/.test(src) });
  cpSync(join(PRODUCT_ROOT, "scripts/supply-chain/best-version.mjs"), join(home, "skills/supply-chain/best-version.mjs"));
  return home;
}

function engineCommand({ cfg, engine, worktree, sessionId, lastMessageFile, gcp, job = {} }) {
  const p = primer(cfg);
  const reads = observes(engine) ? privateReads(cfg) : [];
  const search = observes(engine) ? "disabled" : "live"; // no web search for a job holding private data
  const mcpEnv = { ...(p ? { PRIMER_MCP_TOKEN: p.token } : {}), ...Object.fromEntries(reads.map((r) => [r.env, r.token])), ...(gcp?.env ?? {}) };
  const gcpRoots = gcp ? [gcp.root] : [];
  if (engine.kind === "codex" || engine.kind === "codex-openrouter") {
    const base = sessionId ? ["codex", "exec", "resume", sessionId] : ["codex", "exec"];
    // The workspace holds several clones and isn't a git repository itself.
    const args = [...base, "--json", "--skip-git-repo-check", "-o", lastMessageFile, ...sandboxConfig(cfg, worktree, gcpRoots)];
    if (p) {
      args.push(
        "-c", `mcp_servers.primer.url=${JSON.stringify(p.url)}`,
        "-c", 'mcp_servers.primer.bearer_token_env_var="PRIMER_MCP_TOKEN"',
        "-c", 'mcp_servers.primer.default_tools_approval_mode="approve"',
      );
    }
    for (const r of reads) {
      args.push(
        "-c", `mcp_servers.${r.name}.url=${JSON.stringify(r.url)}`,
        "-c", `mcp_servers.${r.name}.bearer_token_env_var="${r.env}"`,
        "-c", `mcp_servers.${r.name}.default_tools_approval_mode="approve"`,
      );
      if (r.toolTimeout) args.push("-c", `mcp_servers.${r.name}.tool_timeout_sec=${r.toolTimeout}`);
    }
    if (engine.model) args.push("-m", engine.model);
    if (engine.effort) args.push("-c", `model_reasoning_effort="${engine.effort}"`);
    args.push("-c", `web_search="${search}"`);
    if (engine.kind === "codex") {
      args.push("-");
      return { argv: args, env: mcpEnv, rw: [...gcpRoots, join(homedir(), ".codex")] };
    }
    // codex-openrouter: OpenRouter through the model gateway with the job's own token (as for opencode), in a Codex home of
    // the runner's with the product's instructions and skills (docs/design/codex-openrouter-engine.md).
    const home = codexHome(cfg, job.issueId);
    args.push(
      "-c", 'model_provider="or"',
      "-c", 'model_providers.or.name="OpenRouter"',
      "-c", `model_providers.or.base_url=${JSON.stringify(gatewayApi(cfg))}`,
      "-c", `model_providers.or.env_key="${GATEWAY_KEY_ENV}"`,
      "-c", 'model_providers.or.wire_api="responses"',
      // The model key and the read tokens stay with Codex and its MCP clients, out of every command it runs.
      "-c", `shell_environment_policy.exclude=${JSON.stringify([GATEWAY_KEY_ENV, "*_MCP_TOKEN"])}`,
      ...CODEX_OFF.flatMap((f) => ["-c", `features.${f}=false`]),
      "-",
    );
    return { argv: args, env: { ...mcpEnv, [GATEWAY_KEY_ENV]: jobToken(cfg, job), CODEX_HOME: home }, rw: [...gcpRoots, home] };
  }
  if (engine.kind === "openrouter") {
    const key = jobToken(cfg, job);
    const opencode = ["opencode", "run", "--format", "json", "--model", `openrouter/${engine.model}`];
    // The reasoning effort (OpenRouter's reasoning.effort) as opencode's model variant.
    if (engine.effort) opencode.push("--variant", engine.effort);
    if (sessionId) opencode.push("--session", sessionId);
    // OS-level confinement for opencode's tools: Codex's sandbox around the whole process.
    const stateRoots = ["~/.local/share/opencode", "~/.local/state/opencode", "~/.cache/opencode", "~/.config/opencode"].map(expand);
    return {
      argv: codexSandbox(cfg, worktree, stateRoots, opencode),
      rw: stateRoots,
      env: {
        ...mcpEnv,
        OPENROUTER_API_KEY: key,
        // Non-interactive: opencode must not stop to ask for permission, because an unanswered prompt
        // is auto-rejected and ends the run. Reading outside the worktree (reference repos) is
        // fine: the codex sandbox around opencode still limits writes to the worktree. Its default asks
        // before reading `.env` files, which repositories track too (PEN-2421).
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { read: "allow", edit: "allow", bash: "allow", webfetch: observes(engine) ? "deny" : "allow", websearch: observes(engine) ? "deny" : "allow", external_directory: "allow", doom_loop: "allow" },
          autoupdate: false,
          share: "disabled",
          // Through the model gateway; its title calls use the job's model, not opencode's default small model.
          provider: { openrouter: { options: { baseURL: gatewayApi(cfg) } } },
          small_model: `openrouter/${engine.model}`,
          mcp: {
            ...(p ? { primer: { type: "remote", url: p.url, headers: { Authorization: "Bearer {env:PRIMER_MCP_TOKEN}" }, oauth: false, enabled: true } } : {}),
            ...Object.fromEntries(reads.map((r) => [r.name, { type: "remote", url: r.url, headers: { Authorization: `Bearer {env:${r.env}}` }, oauth: false, enabled: true }])),
          },
        }),
      },
      promptAsArg: true,
    };
  }
  if (engine.kind === "claude") {
    if (!existsSync(cfg.claudeTokenFile)) throw new Error(`Claude Code isn't set up for the runner: run \`claude setup-token\` and save the token to \`${cfg.claudeTokenFile}\` (0600).`);
    const token = readFileSync(cfg.claudeTokenFile, "utf8").trim();
    mkdirSync(cfg.claudeConfigDir, { recursive: true, mode: 0o700 });
    // Headless, no prompts (the codex sandbox is the write boundary), and nothing from your own
    // Claude setup: a runner-owned config dir, no settings files (yours or the repo's: no hooks),
    // no MCP servers but the read-only endpoints (Primer; Grafana, Slack, Glean, ClickHouse), and no claude.ai connectors.
    const mcpServers = {
      ...(p ? { primer: { type: "http", url: p.url, headers: { Authorization: "Bearer ${PRIMER_MCP_TOKEN}" } } } : {}),
      ...Object.fromEntries(reads.map((r) => [r.name, { type: "http", url: r.url, headers: { Authorization: `Bearer \${${r.env}}` } }])),
    };
    const claude = [
      // Streamed input, so the user's comments can reach a run in progress; each one is echoed back
      // once taken in (--replay-user-messages), which tells runAgent when the conversation is done.
      "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "",
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers }),
      "--tools", observes(engine) ? CLAUDE_TOOLS.replace(",WebFetch,WebSearch", "") : CLAUDE_TOOLS,
    ];
    if (engine.model) claude.push("--model", engine.model);
    if (engine.effort) claude.push("--effort", engine.effort === "minimal" ? "low" : engine.effort);
    if (sessionId) claude.push("--resume", sessionId);
    return {
      argv: codexSandbox(cfg, worktree, [cfg.claudeConfigDir, ...gcpRoots], claude),
      rw: [cfg.claudeConfigDir, ...gcpRoots],
      env: {
        ...mcpEnv,
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_CONFIG_DIR: cfg.claudeConfigDir,
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        DISABLE_AUTOUPDATER: "1",
      },
      streamInput: true,
    };
  }
  throw new Error(`unsupported engine ${engine.kind}`);
}

/** One message for Claude Code's streamed input. */
const userMessage = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;


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

/**
 * Start the agent; returns the run for `watchAgent`. For an engine with streamed input (Claude Code),
 * `channel.send(text)` gives the running session another message from the user (docs/design/conversational-engineers.md,
 * During a run) and returns false once the run is over. An adopted run has no input: its runner is gone.
 * The agent's environment: no SSH agent (fetch only via the runner), read-only gh first on PATH (reading with
 * `ghToken`, a read-only App token for the task's repos), and a git ssh wrapper that refuses pushes.
 */
export function startAgent({ cfg, engine, worktree, prompt, sessionId, logPath, env: jobEnv = {}, gcp, channel, identity = DEFAULT_IDENTITY, ghToken, job, box }) {
  const lastMessageFile = `${logPath}.last.md`;
  if (engine.box) return startBoxAgent({ cfg, engine, worktree, prompt, sessionId, logPath, job, box });
  const { argv, env, promptAsArg, streamInput } = buildCommand({ cfg, engine, worktree, sessionId, lastMessageFile, gcp, loopback: [jobEnv.AIDENHQ_REPO_URL], job });
  const full = promptAsArg ? [...argv, prompt] : argv;
  const agentEnv = {
    ...process.env,
    ...env,
    // The private bwrap's folder too, so Codex's own sandbox in the job uses it (Codex takes the first bwrap on PATH).
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
  delete agentEnv.SSH_AUTH_SOCK;
  // A GitHub token in the runner's environment is never the agent's. Its gh reads with `ghToken` (a GitHub App token
  // narrowed to the task's repos, read-only) or nothing: the user's own gh sign-in is hidden from jobs (cfg.gcp.hidden).
  delete agentEnv.GH_TOKEN;
  delete agentEnv.GITHUB_TOKEN;
  // Twice: Codex drops *TOKEN* variables from its tool calls, so the gh wrapper also takes AIDENHQ_GH_AUTH.
  if (ghToken) Object.assign(agentEnv, { GH_TOKEN: ghToken, AIDENHQ_GH_AUTH: ghToken });
  // Never a prompt on the user's desktop: without credentials, git over https and ssh would fall back
  // to the session's askpass dialog (seahorse) and pop it up for every private Go module or repo.
  delete agentEnv.SSH_ASKPASS;
  agentEnv.SSH_ASKPASS_REQUIRE = "never";
  agentEnv.GIT_ASKPASS = "false";
  if (engine.kind === "claude") delete agentEnv.ANTHROPIC_API_KEY; // the subscription token, never an API key

  appendFileSync(logPath, `# ${new Date().toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in ${worktree}\n`);
  const out = openSync(logPath, "a");
  const withStdin = streamInput || !promptAsArg;
  const child = spawn("/bin/sh", ["-c", WRAP, `${logPath}.exit`, ...full], { cwd: worktree, env: agentEnv, detached: true, stdio: [withStdin ? "pipe" : "ignore", out, out] });
  closeSync(out);
  const run = { pid: child.pid, logPath, program: full[0], streamInput, stdin: child.stdin, sent: 0 };
  // Only /bin/sh itself failing to start lands here; a missing engine is the shell's exit 127.
  child.on("error", (e) => (run.spawnError = `couldn't start /bin/sh: ${e.code ?? e.message}`));
  child.unref();
  if (child.stdin) {
    child.stdin.on("error", () => {}); // a message sent as the process exits
    if (streamInput) {
      child.stdin.write(userMessage(prompt));
      run.sent = 1;
      if (channel) {
        channel.send = (text) => {
          if (child.stdin.writableEnded || child.exitCode !== null || child.signalCode !== null) return false;
          child.stdin.write(userMessage(text));
          run.sent++;
          return true;
        };
      }
    } else child.stdin.end(prompt);
  }
  return run;
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

/** A run another runner process started (a restart): followed from its files, with no input channel. */
export const adoptRun = ({ pid, logPath, boxLast }) => ({ pid, logPath, boxLast, adopted: true });

/**
 * A box job's run: the same detached wrapper (log, exit file, adoption by pid), around a `docker exec` client whose own env is
 * only what Docker needs; the prompt goes in on stdin. Everything the job gets is in the launcher's env file.
 */
function startBoxAgent({ cfg, engine, worktree, prompt, sessionId, logPath, job, box }) {
  const { argv } = buildCommand({ cfg, engine, worktree, sessionId, job, box });
  // Nothing is written in the workspace here (the box's to write); its HOME is made inside the box.
  const boxLast = boxLastFile(box);
  const env = Object.fromEntries(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  appendFileSync(logPath, `# ${new Date().toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in box ${box.container} (${worktree})\n`);
  const out = openSync(logPath, "a");
  const child = spawn("/bin/sh", ["-c", WRAP, `${logPath}.exit`, ...argv], { cwd: "/", env, detached: true, stdio: ["pipe", out, out] });
  closeSync(out);
  const run = { pid: child.pid, logPath, program: argv[0], stdin: child.stdin, sent: 0, boxLast };
  child.on("error", (e) => (run.spawnError = `couldn't start /bin/sh: ${e.code ?? e.message}`));
  child.unref();
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  return run;
}

/**
 * Follow a run to its end: its log (the engine's event stream, read from the start, so an adopted run
 * rebuilds the same state), its exit file, the deadline and a stop request. Resolves with
 * { code, sessionId, lastMessage, timedOut, cancelled }, or { detached: true } once `detach` aborts
 * (the runner is restarting and leaves the run to its successor).
 * `onProgress({ said, saidAt, plan })` gets the agent's latest words and task list as they change.
 */
export function watchAgent(run, { engine, sessionId, deadline, stallMs = 15 * 60_000, signal, detach, channel, onProgress }) {
  const { pid, logPath, stdin, streamInput } = run;
  const exitFile = `${logPath}.exit`;
  const lastMessageFile = `${logPath}.last.md`;
  return new Promise((resolve) => {
    let found = sessionId;
    let finalText = "";
    // Streamed input: the session ends once every message sent has been taken in and answered. A
    // message that arrives as a turn ends gets a turn of its own; its answer joins the reply.
    let taken = 0;
    const answers = [];
    let lingering;
    const finish = () => {
      clearTimeout(lingering);
      if (stdin && !stdin.writableEnded) stdin.end();
    };
    const progress = progressTracker();
    const onLine = (line) => {
      try {
        const e = JSON.parse(line);
        if (progress.take(e)) onProgress?.(progress.current());
        if (e.type === "thread.started" && e.thread_id) found = e.thread_id; // codex
        if (e.sessionID && !found) found = e.sessionID; // opencode
        if (e.type === "text" && e.part?.text) finalText = e.part.text; // opencode: keep last text part
        if (e.type === "system" && e.subtype === "init" && e.session_id && !found) found = e.session_id; // claude
        if (streamInput && e.type === "user" && e.isReplay) taken++;
        if (e.type === "result" && typeof e.result === "string") {
          // claude: the answer of a turn
          answers.push(e.result);
          finalText = answers.filter((a) => a.trim() && a.trim() !== "NO_REPLY").join("\n\n") || e.result;
          if (streamInput && stdin) {
            clearTimeout(lingering);
            if (taken >= run.sent) finish();
            else lingering = setTimeout(finish, 120_000); // a message it never took in: don't wait forever
          }
        }
      } catch {
        /* non-JSON output */
      }
    };
    let offset = 0;
    // When the log last grew: a run silent for stallMs (a model call that never answers) is stopped as stalled, so
    // it doesn't hold its task, and the writes waiting on it, until the deadline.
    let grewAt = Date.now();
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const read = () => {
      let fd;
      try {
        fd = openSync(logPath, "r");
        const size = fstatSync(fd).size;
        if (size <= offset) return;
        grewAt = Date.now();
        const chunk = Buffer.alloc(size - offset);
        readSync(fd, chunk, 0, chunk.length, offset);
        offset = size;
        buffer += decoder.write(chunk);
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
        }
      } catch {
        /* no log yet */
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    };

    let timedOut = false;
    let stalled = false;
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
      clearTimeout(lingering);
      signal?.removeEventListener("abort", onAbort);
      detach?.removeEventListener("abort", onDetach);
      then();
    };
    const onDetach = () => end(() => resolve({ detached: true }));
    const done = () =>
      end(() => {
        read();
        if (channel) channel.send = () => false;
        finish();
        const status = exitStatus(exitFile);
        const code = status === "" ? null : Number(status);
        // A box job's last message is in its workspace (the box's to write): copied out as a small regular file, never a link.
        if (run.boxLast) {
          const text = smallFile(run.boxLast, 256 * 1024);
          if (text !== undefined) writeFileSync(lastMessageFile, text);
          rmSync(run.boxLast, { force: true });
        }
        let lastMessage = existsSync(lastMessageFile) ? readFileSync(lastMessageFile, "utf8").trim() : finalText.trim();
        if (!lastMessage) lastMessage = finalText.trim();
        const startError = run.spawnError || (code === 127 && `couldn't start ${run.program ?? "the engine"}: ENOENT`);
        if (!lastMessage && startError) {
          appendFileSync(logPath, `# ${startError}\n`);
          lastMessage = `The job couldn't start: ${startError}.`;
        }
        if (lastMessage) writeFileSync(lastMessageFile, lastMessage);
        // No status: the run died without its shell, by its own stop or timeout (killed), else by hand (a failure).
        resolve({ code: code === null && !killed ? 1 : code, sessionId: found, lastMessage, timedOut, stalled, cancelled });
      });
    const tick = () => {
      read();
      if (exitStatus(exitFile) || !pid|| run.spawnError || !alive(pid)) return done();
      if (!timedOut && Date.now() > deadline) {
        timedOut = true;
        kill();
      }
      if (!timedOut && Date.now() - grewAt > stallMs) {
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
  return watchAgent(run, { engine: opts.engine, sessionId: opts.sessionId, deadline: Date.now() + (cfg.timeout_minutes ?? 60) * 60_000, stallMs: (cfg.stall_minutes ?? 15) * 60_000, signal, detach, channel, onProgress });
}

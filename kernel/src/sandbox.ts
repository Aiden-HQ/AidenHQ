// Jobs and the host sandbox (K7, spec §3.3.1, §5.11). Every Engineer job runs in its agent computer (a box: buildJob writes its
// job.json and the `docker exec` line; jobs.ts runs it). The host sandbox (bwrap with its own network, netjail.ts and pasta) is
// for what runs repo code on the host itself: the repos' fast checks (fastcheck.ts), the reviewer eval and local CI checks
// (the runner). The engine registry (config/engines.json), an engine's state folder and the job credentials are here too;
// scripts/verify-security.sh probes the sandbox's layout and jail live.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { mintToken } from "./gateway/token.ts";

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const repoRoot = resolve(import.meta.dirname, "../..");

/** Engine registry entry (compile: modules' providers.engine). */
export interface EngineEntry {
  module: string; dir: string; bin: string; kind: string; label?: string; live_input?: boolean; gateway?: boolean; box?: boolean;
  state?: "shared" | "task"; reset?: string[]; seed?: { from: string; to: string }[];
}
/** An engine choice: its kind, model and effort, and whether the job holds private reads (no web search then). */
export interface Engine { kind: string; model?: string; effort?: string; reads?: boolean }
export interface SandboxConfig {
  bwrap: string; pasta?: string;
  hidden: string[]; sandbox?: { read_only_roots?: string[] };
  binDir: string; browserDir: string; workDir: string; stateDir: string; logsDir: string; secretsDir: string;
  enginesFile: string; gatewayUrl: string; boxGatewayUrl: string; boxDir: string;
  timeout_minutes: number; stall_minutes: number; progress_minutes: number;
  /** Unit tests: no host layout, unconfined. */
  unconfined?: boolean;
}

/** Whether a job holds private data (an Engineer with `private_reads`): no web search then. */
export const observes = (engine?: Engine) => engine?.reads === true;

// The host's toolchains, read-only in the sandbox: the system (merged-/usr links are recreated as links) and /etc.
const SYSTEM_RO = ["/usr", "/etc", "/opt", "/snap"];
const SYSTEM_LINKS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
// Toolchains people install in their home: read-only when present (sandbox.read_only_roots adds more; an engine module its own, `ro`).
const HOME_RO = ["~/.local/bin", "~/.local/lib", "~/.cargo", "~/.rustup", "~/go/bin", "~/.nvm", "~/.bun", "~/.deno", "~/.pyenv"];
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * What the sandbox sees of the host's files (bwrap): an allowlist, not the whole host. Read-only: the toolchains (/usr and its
 * links, /etc, /opt, the home's toolchains, node's own prefix), the wrappers (cfg.binDir), the pinned headless browser and `ro`.
 * Read-write: `rw` (the clone being checked). A private /tmp and an empty home under them; the host's /dev and /sys, a procfs
 * of its own. Nothing else exists there. What cfg.hidden names inside an allowed path is still masked: a directory gets an
 * empty tmpfs, a file or socket /dev/null.
 */
export function layout(cfg: SandboxConfig, { rw = [], ro = [] }: { rw?: string[]; ro?: string[] } = {}) {
  const home = homedir();
  const node = dirname(dirname(process.execPath));
  const roPaths = [...SYSTEM_RO, ...HOME_RO.map(expand), ...(cfg.sandbox?.read_only_roots ?? []).map(expand), ...(node.startsWith(home + sep) ? [node] : []), cfg.binDir, cfg.browserDir, ...ro];
  // The host's /dev (a fresh --dev breaks the network jail's route setup), /proc and /sys.
  // Its own PID and IPC namespaces with a fresh procfs: no other process (the kernel's environ, /proc/1/root) is visible.
  const args = ["--unshare-pid", "--unshare-ipc", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--ro-bind", "/sys", "/sys", "--tmpfs", "/tmp", "--tmpfs", home];
  for (const l of SYSTEM_LINKS) {
    const st = lstatSync(l, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) args.push("--symlink", readlinkSync(l), l);
    else if (st) args.push("--ro-bind", l, l);
  }
  // /run: only the host's resolver (the jail replaces it with its own tmpfs; without the jail it links into /run/systemd/resolve).
  if (existsSync("/run/systemd/resolve")) args.push("--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve");
  // Shallower paths first, so a deeper bind lands on top of its parent's.
  const mounts = [...roPaths.filter(Boolean).map((p) => ["--ro-bind", resolve(p)]), ...rw.filter(Boolean).map((p) => ["--bind", resolve(p)])]
    .filter(([, p]) => existsSync(p!))
    .sort((a, b) => a[1]!.split(sep).length - b[1]!.split(sep).length) as [string, string][];
  for (const [how, p] of mounts) args.push(how, p, p);
  const allowed = mounts.map(([, p]) => p);
  for (const p of cfg.hidden.filter((d) => existsSync(d) && allowed.some((a) => inside(d, a)))) {
    args.push(...(statSync(p).isDirectory() ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p]));
  }
  return args;
}

/** The whole run under bwrap with only the allowed paths (layout), in its own network when pasta is installed. */
export function hiding(cfg: SandboxConfig, argv: string[], loopback: string[] = [], paths: Parameters<typeof layout>[1] = {}) {
  if (cfg.unconfined) return argv;
  const mounts = layout(cfg, paths);
  if (cfg.pasta) return jailed(cfg, mounts, loopback, argv);
  return [cfg.bwrap, ...mounts, "--die-with-parent", "--", ...argv];
}

/** A known no-jail condition: every link candidate overlaps a host network, so a job can't get its own network. */
class NoFreeLink extends Error {}

/** Why jobs can't get their own network here (no pasta, no free link, or a trial job failed), or undefined when they can. */
export function jailProblem(cfg: SandboxConfig) {
  if (!cfg.pasta) return "pasta is not installed (sudo apt-get install -y passt)";
  let argv: string[];
  try {
    argv = hiding(cfg, ["true"]);
  } catch (e) {
    if (e instanceof NoFreeLink) return e.message;
    throw e;
  }
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd!, args, { encoding: "utf8", timeout: 20000 });
  return r.status === 0 ? undefined : `a trial job failed (exit ${r.status ?? r.signal}): ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`;
}

/** Remove a folder a job wrote: Go's module cache is read-only, so made writable first. */
export function removeLayers(dir: string) {
  spawnSync("chmod", ["-R", "u+rwx", dir]);
  rmSync(dir, { recursive: true, force: true });
}

/** Host loopback ports of the given URLs (127.0.0.1 / localhost only): what a jailed job may reach on the host. */
export const loopbackPorts = (urls: (string | undefined)[]) =>
  [...new Set(urls.filter((u): u is string => Boolean(u)).map((u) => new URL(u)).filter((u) => ["127.0.0.1", "localhost"].includes(u.hostname)).map((u) => Number(u.port || (u.protocol === "https:" ? 443 : 80))))].sort((a, b) => a - b);

// Unreachable from a job: private, shared, link-local, benchmark, reserved and "this network" ranges (the LAN, Docker
// bridges, the tailnet, cloud metadata), and every address of the host itself (a public one too). 127.0.0.0/8 stays the
// jail's own loopback (the local table wins), where pasta serves the allowed ports. pasta reaches the rest of the
// Internet from the host's side.
const BLOCKED = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "240.0.0.0/4"];
// The link to pasta (a /24: the job is .15, pasta's gateway .2): the first that overlaps none of the host's networks,
// so no host address is ever "on link" in the jail.
const LINKS = ["10.0.2", "172.31.254", "192.168.254", "100.127.254"];
const ipNum = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const overlaps = (a: string, alen: number, b: string, blen: number) => Math.floor(ipNum(a) / 2 ** (32 - Math.min(alen, blen))) === Math.floor(ipNum(b) / 2 ** (32 - Math.min(alen, blen)));
// From `ip`, not os.networkInterfaces(): that leaves out interfaces without carrier (an idle Docker bridge), whose
// addresses are still the host's.
const hostIPv4 = () =>
  [...execFileSync("ip", ["-4", "-o", "addr", "show"], { encoding: "utf8" }).matchAll(/ inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/g)].map((m) => ({ address: m[1]!, prefix: Number(m[2]) }));
// Every network the host routes to (a VPN's subnet has no host address on it): the link must avoid these too, or a
// destination "on link" in the jail could be one the host would forward somewhere real.
const hostRoutes = () =>
  [...execFileSync("ip", ["-4", "route", "show", "table", "all"], { encoding: "utf8" }).matchAll(/^(?:(?:unicast|local|broadcast|anycast|multicast|unreachable|blackhole|prohibit|throw)\s+)?(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?\s/gm)].map((m) => ({ address: m[1]!, prefix: m[2] ? Number(m[2]) : 32 }));

/**
 * The job in its own network namespace (netjail.ts): Internet egress through pasta, and of the host's loopback only the ports
 * it was given (the model and tool proxy on 8201, the job's helper). Every other loopback service, the host's other addresses
 * and the LAN are out of reach. The job's first step sets the unreachable routes, then drops the capabilities it used.
 */
function jailed({ pasta, bwrap }: SandboxConfig, masks: string[], loopback: string[], argv: string[]) {
  const ports = loopbackPorts(loopback).join(",") || "none";
  const host = hostIPv4();
  const nets = [...host, ...hostRoutes()];
  const link = LINKS.find((l) => nets.every((a) => !overlaps(`${l}.0`, 24, a.address, a.prefix)));
  if (!link) throw new NoFreeLink("no free subnet for the job's network link: every candidate overlaps a host network");
  const unreachable = [...BLOCKED, ...host.filter((a) => !a.address.startsWith("127.")).map((a) => `${a.address}/32`)];
  const inner = `for n in ${unreachable.join(" ")}; do PATH="/usr/sbin:/sbin:$PATH" ip route add unreachable "$n" || exit 1; done; exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- "$@"`;
  return [
    process.execPath, join(import.meta.dirname, "netjail.ts"), pasta!, ports, link,
    // The public resolvers go where /etc/resolv.conf leads (systemd-resolved's stub-resolv.conf), on a private tmpfs:
    // bound onto the host's own file, the bind came off the first time resolved rewrote it (a rename over a mountpoint
    // detaches it in every namespace), and the job was left with 127.0.0.53, unreachable in its network.
    bwrap, ...masks, "--tmpfs", "/run/systemd/resolve", "--ro-bind-data", "5", "/etc/resolv.conf",
    "--unshare-net", "--cap-add", "CAP_NET_ADMIN", "--cap-add", "CAP_SETPCAP", "--info-fd", "3", "--block-fd", "4", "--die-with-parent",
    "--", "/bin/sh", "-c", inner, "aidenhq-jail", ...argv,
  ];
}

/** The engine registry (config/engines.json, compiled from the modules' providers.engine): kind → entry. */
export const readEngines = (cfg: Pick<SandboxConfig, "enginesFile">): Record<string, EngineEntry> => { try { return JSON.parse(readFileSync(cfg.enginesFile, "utf8")); } catch { return {}; } };
export function engineEntry(cfg: Pick<SandboxConfig, "enginesFile">, kind: string) {
  const e = readEngines(cfg)[kind];
  if (!e) throw new Error(`no engine module provides "${kind}" (config/engines.json: enable its module and apply)`);
  return e;
}
const fromProduct = (p: string) => resolve(repoRoot, p);

/** A skill compile resolved for the job's agent (the grants table's `skills`): `<module>.<name>` and its module folder. */
export interface Skill { id: string; dir: string }

/**
 * The engine's state folder for this run (its sessions persist for a resume): one per kind (`state: shared`) or per kind and task
 * (`state: task`, no task reads another's transcripts), made 0700. Its `reset` names are removed first, so no run leaves
 * instructions, config, hooks or skills for a later one. Then skills/ is replaced, whatever the list: the agent's `skills` are
 * built into skills/<name> in a fresh folder outside the job's reach (regular files only, read-only, links never followed, with
 * skills/.hash over the copy) and renamed into place; the job's own skills/ (a link it planted too) is removed, never followed.
 * No skills: no skills/ of ours. The module's `seed` is copied in last. Skills need a per-task folder (`state: task`): a shared
 * one would hand one agent's skills to another. Undefined for an engine without a state folder.
 */
export function engineState(cfg: Pick<SandboxConfig, "enginesFile" | "stateDir">, kind: string, task?: string, skills: Skill[] = []) {
  const e = engineEntry(cfg, kind);
  if (!e.state) return undefined;
  if (skills.length && e.state !== "task") throw new Error(`engine ${kind}: skills need a per-task state folder (state: task)`);
  const dir = join(cfg.stateDir, kind, ...(e.state === "task" ? [String(task ?? "none").replace(/[^\w.-]/g, "_")] : []));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of e.reset ?? []) rmSync(join(dir, f), { recursive: true, force: true });
  const built = skills.length ? buildSkills(cfg.stateDir, skills) : undefined;
  rmSync(join(dir, "skills"), { recursive: true, force: true });
  if (built) renameSync(built, join(dir, "skills"));
  for (const { from, to } of e.seed ?? []) {
    const src = from.startsWith("/") ? fromProduct(from.slice(1)) : join(fromProduct(e.dir), from);
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    cpSync(src, join(dir, to), { recursive: true, filter: (p) => !/[\\/](node_modules|dist)$/.test(p) });
  }
  return dir;
}

/** The skills tree, built in a new folder under the kernel's state root (no job reaches it; same filesystem for the rename). */
function buildSkills(root: string, skills: Skill[]) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const to = mkdtempSync(join(root, ".skills-"));
  const hash = createHash("sha256");
  try {
    for (const s of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
      const name = /^[a-z0-9][a-z0-9-]*\.([a-z0-9][a-z0-9-]*)$/.exec(s.id)?.[1];
      if (!name) throw new Error(`skill ${s.id}: not a skill id (<module>.<name>)`);
      cpSync(s.dir, join(to, name), { recursive: true, errorOnExist: true, filter: (p) => { const st = lstatSync(p); return st.isFile() || st.isDirectory(); } });
      for (const f of (readdirSync(join(to, name), { recursive: true }) as string[]).sort()) {
        const file = join(to, name, f);
        if (!lstatSync(file).isFile()) continue;
        chmodSync(file, 0o444);
        hash.update(`${name}/${f}\0`).update(readFileSync(file)).update("\0");
      }
    }
    writeFileSync(join(to, ".hash"), `${hash.digest("hex")}\n`);
    return to;
  } catch (err) {
    rmSync(to, { recursive: true, force: true });
    throw err;
  }
}

// A session id an engine reported, before it goes on a command line.
export const SESSION = /^[\w.:-]{1,200}$/;

/** A model credential for the gateway, signed with gateway_job_secret. Never the model key. */
export function modelToken(cfg: Pick<SandboxConfig, "secretsDir">, claims: Record<string, unknown>, now = Date.now()) {
  let secret = "";
  try { secret = readFileSync(join(cfg.secretsDir, "gateway_job_secret"), "utf8").trim(); } catch {}
  return mintToken(secret, claims as never, now);
}

/** A job: who and what it is for, its jobcaps and start time (`at`): the same job always gets the same token. */
export interface JobClaims { agentId?: string | null; issueId?: string | null; at?: number; jobcaps?: string[]; observing?: boolean; token?: string }
/** The job's own credential to the gateway and the tool proxy, valid past its deadline (an adopted run keeps its env). */
export const jobToken = (cfg: Pick<SandboxConfig, "secretsDir" | "timeout_minutes">, job: JobClaims) => job.token ?? modelToken(cfg, { kind: "agent", agentId: job.agentId ?? null, issueId: job.issueId ?? null, jobcaps: [...(job.jobcaps ?? [])].sort(), observing: job.observing === true, ttlMs: ((cfg.timeout_minutes ?? 60) + 60) * 60_000 }, job.at);

/** A box job's box (the computer launcher made it): its container, the env file of its credentials and its out folder. */
export interface Box { container: string; envFile: string; outDir: string }

/**
 * One run of an engine under engine@1, in the job's agent computer: job.json in its out folder (the box's /aidenhq-out/job),
 * then `docker exec` of the module's bin there, under `boxWrap` (the launcher's scrub), with the module the launcher mounted
 * read-only at /opt/aidenhq/engine. The model comes through the box gateway with the box's run token; its connections are in
 * its Codex home already (the launcher's). `gh`: the job's read-only gh token, passed by name from the docker client's env
 * (never argv or the env file). Only an engine that runs in a box (`box: true`) runs at all.
 */
export function buildJob({ cfg, engine, worktree, jobDir, sessionId, prompt = "", job = {}, box, gh = false, boxWrap }: {
  cfg: SandboxConfig; engine: Engine; worktree: string; jobDir: string; sessionId?: string; prompt?: string; job?: JobClaims; box: Box; gh?: boolean; boxWrap: string;
}) {
  const entry = engineEntry(cfg, engine.kind);
  if (entry.box !== true) throw new Error(`The ${entry.label ?? engine.kind} engine doesn't run in an agent computer, and every job does.`);
  const spec = {
    contract: "engine@1", job: basename(jobDir), agent: job.agentId ?? "", task: job.issueId ?? "", prompt,
    ...(sessionId && SESSION.test(sessionId) ? { session: sessionId } : {}),
    model: { base_url: `${cfg.boxGatewayUrl}/api/v1`, token_env: "AIDENHQ_RUN_TOKEN", id: engine.model ?? "", effort: engine.effort ?? "" },
    mcp: [], env: [], limits: { timeout_s: (cfg.timeout_minutes ?? 60) * 60 }, web: !observes(engine), // no web search for a job holding private data
    sandbox: { kind: "box", writable: [worktree], network: true },
  };
  writeFileSync(join(jobDir, "job.json"), JSON.stringify(spec), { mode: 0o600, flag: "wx" });
  const argv = ["docker", "exec", "--env-file", box.envFile, ...(gh ? ["-e", "GH_TOKEN", "-e", "AIDENHQ_GH_AUTH"] : []), "-w", "/workspace", box.container, "sh", "-c", boxWrap, "aidenhq-computer", join("/opt/aidenhq/engine", relative(entry.dir, entry.bin)), "/aidenhq-out/job"];
  return { argv, spec, entry };
}

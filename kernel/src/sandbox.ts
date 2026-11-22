// Jobs (K7, spec §3.3.1, §5.11). Every Engineer job runs in its agent computer (a box: buildJob writes its job.json and the
// `docker exec` line; jobs.ts runs it). No repo code runs on the host: a repo's checks are check jobs (checkjobs.ts). The engine
// registry (config/engines.json), an engine's state folder and the job credentials are here too.
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

/** Engine registry entry (compile: modules' providers.engine). */
export interface EngineEntry {
  module: string; dir: string; bin: string; kind: string; label?: string; live_input?: boolean; gateway?: boolean; box?: boolean;
  state?: "shared" | "task"; reset?: string[]; seed?: { from: string; to: string }[];
}
/** An engine choice: its kind, model and effort, and whether the job holds private reads (no web search then). */
export interface Engine { kind: string; model?: string; effort?: string; reads?: boolean }
export interface SandboxConfig {
  workDir: string; stateDir: string; logsDir: string; secretsDir: string;
  enginesFile: string; gatewayUrl: string; boxGatewayUrl: string; boxDir: string;
  timeout_minutes: number;
}

/** Whether a job holds private data (an Engineer with `private_reads`): no web search then. */
export const observes = (engine?: Engine) => engine?.reads === true;

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

/** A mode as octal with its leading 0 (0700). */
const mode = (m: number) => `0${(m & 0o777).toString(8).padStart(3, "0")}`;
/** The nearest existing path at or above `p`: a missing folder is explained by its parent's mode and owner. */
function existing(p: string) {
  for (let at = p, n = 0; n < 40; n++) {
    try {
      const st = lstatSync(at, { throwIfNoEntry: false });
      if (st) return { at, st };
    } catch { /* a parent we can't stat explains nothing: keep walking up */ }
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return undefined;
}
/** What stopped the state root, in one line the owner can act on: the absolute path, the owner and mode found, the uid we run as. */
function stateRootFailure(p: string, why: string, cause: unknown) {
  const f = existing(p), who = typeof process.getuid === "function" ? `uid=${process.getuid()} gid=${process.getgid?.()}` : "an unknown uid";
  const found = f ? `${f.at === p ? "found" : `nearest existing ${f.at} is`} mode ${mode(f.st.mode)}, owner uid=${f.st.uid} gid=${f.st.gid}${f.st.isSymbolicLink() ? ", a symlink" : ""}` : "nothing exists above it";
  return new Error(`runner state directory ${p} can't be used: ${why} (${found}; the kernel runs as ${who})`, { cause });
}
/** Removes `p` as itself: a symlink is unlinked, never followed (a recursive rm on one would empty its target). */
function removeEntry(p: string) {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() || (st && !st.isDirectory())) unlinkSync(p);
  else if (st) rmSync(p, { recursive: true, force: true });
}

/** What stopped it: the fs call's code and its own words, never a bare stack. */
const because = (e: unknown) => { const err = e as NodeJS.ErrnoException; return [err?.code, err?.message].filter(Boolean).join(": ") || String(e); };

/**
 * One unusable state root is one episode: the owner hears the first job's failure, not each job's while it stays broken. A
 * successful creation clears it, so a later break is a new need. Keyed by path: another root is its own need.
 */
const stateNeeds = new Map<string, string>();
function reportNeed(p: string, err: Error, report?: (e: Error) => void) {
  if (!report || stateNeeds.get(p) === err.message) return;
  stateNeeds.set(p, err.message);
  try { report(err); } catch { /* the launch's own error is the one that ends the job */ }
}

/**
 * `<p>` made 0700 (or confirmed usable), never through a symlink. A symlink, a non-directory, another user's directory or one
 * without owner write+execute is refused with the path, owner and mode found: `recursive: true` would otherwise fail deep
 * inside the per-engine folder, on every job, with a bare EACCES.
 */
function ensureStateDir(p: string) {
  try {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw new Error("it is a symlink, which is never followed");
    if (st && !st.isDirectory()) throw new Error("it is not a directory");
    if (st) {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid !== undefined && st.uid !== uid) throw new Error("it is owned by another user");
      if ((st.mode & 0o300) !== 0o300) throw new Error("it is not owner-writable and owner-searchable (mode has no 0300)");
      accessSync(p, constants.W_OK | constants.X_OK);
    } else mkdirSync(p, { recursive: true, mode: 0o700 });
    // The process umask can only narrow the create mode: set it after, so the state root and logs are always 0700.
    chmodSync(p, 0o700);
  } catch (e) {
    throw stateRootFailure(p, because(e), e);
  }
}

/**
 * The engine state root and its logs dir, healed 0700 before any job folder. A disk reclaim that removed them (or a root
 * another user made) must not turn every launch into the same EACCES: a missing root is recreated, and one still unusable is
 * reported as one owner need (`report`) before it throws.
 */
export function ensureStateDirs(stateDir: string, report?: (e: Error) => void) {
  const root = resolve(stateDir), logs = join(root, "logs");
  try {
    ensureStateDir(root);
    ensureStateDir(logs);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    reportNeed(root, err, report);
    throw err;
  }
  stateNeeds.delete(root);
  return { root, logs };
}

/**
 * The engine's state folder for this run (its sessions persist for a resume): one per kind (`state: shared`) or per kind and task
 * (`state: task`, no task reads another's transcripts), made 0700. Its `reset` names are removed first, so no run leaves
 * instructions, config, hooks or skills for a later one. Then skills/ is replaced, whatever the list: the agent's `skills` are
 * built into skills/<name> in a fresh folder outside the job's reach (regular files only, read-only, links never followed, with
 * skills/.hash over the copy) and renamed into place; the job's own skills/ (a link it planted too) is removed, never followed.
 * No skills: no skills/ of ours. The module's `seed` is copied in last. Skills need a per-task folder (`state: task`): a shared
 * one would hand one agent's skills to another. Undefined for an engine without a state folder.
 *
 * The state root and its logs are healed (0700) before the job's own folder, never following a symlink, so a removed root is
 * recreated on the next launch; a root that still can't be used throws naming its path, owner and mode, and `report` hears it
 * once per episode rather than on each job.
 */
export function engineState(cfg: Pick<SandboxConfig, "enginesFile" | "stateDir">, kind: string, task?: string, skills: Skill[] = [], report?: (e: Error) => void) {
  const e = engineEntry(cfg, kind);
  if (!e.state) return undefined;
  if (skills.length && e.state !== "task") throw new Error(`engine ${kind}: skills need a per-task state folder (state: task)`);
  const { root } = ensureStateDirs(cfg.stateDir, report);
  const dir = join(root, kind, ...(e.state === "task" ? [String(task ?? "none").replace(/[^\w.-]/g, "_").replace(/^\.*$/, "_")] : []));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of e.reset ?? []) removeEntry(join(dir, f));
  const built = skills.length ? buildSkills(root, skills) : undefined;
  removeEntry(join(dir, "skills"));
  if (built) renameSync(built, join(dir, "skills"));
  for (const { from, to } of e.seed ?? []) {
    const src = from.startsWith("/") ? fromProduct(from.slice(1)) : join(fromProduct(e.dir), from);
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    cpSync(src, join(dir, to), { recursive: true, filter: (p) => !/[\\/](node_modules|dist)$/.test(p) });
  }
  return dir;
}

/** An apply moves the product's modules/ tree under a running kernel (a checkout, or a rollback's fetch that renames it away
 * and back), so a skills build that lands in the gap is retried for about two seconds, reading the skill folders fresh on each
 * attempt. */
const SKILL_BUILD_ATTEMPTS = 10;
const SKILL_BUILD_RETRY_MS = 200;
const swappedAway = (err: unknown) => { const code = (err as NodeJS.ErrnoException)?.code; return code === "ENOENT" || code === "ESTALE"; };
const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * The skills tree, built in a new folder under the kernel's state root (no job reaches it; same filesystem for the rename).
 * A failed build leaves nothing behind; a copy error names the skill and the folder it came from, so a real missing or
 * mis-pinned skill is not read as a swap.
 */
function buildSkills(root: string, skills: Skill[]) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let attempt = 1; ; attempt++) {
    try {
      return copySkills(root, skills);
    } catch (err) {
      if (!swappedAway(err) || attempt >= SKILL_BUILD_ATTEMPTS) throw err;
      pause(SKILL_BUILD_RETRY_MS);
    }
  }
}

function copySkills(root: string, skills: Skill[]) {
  const to = mkdtempSync(join(root, ".skills-"));
  const hash = createHash("sha256");
  try {
    for (const s of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
      const name = /^[a-z0-9][a-z0-9-]*\.([a-z0-9][a-z0-9-]*)$/.exec(s.id)?.[1];
      if (!name) throw new Error(`skill ${s.id}: not a skill id (<module>.<name>)`);
      try {
        cpSync(s.dir, join(to, name), { recursive: true, errorOnExist: true, filter: (p) => { const st = lstatSync(p); return st.isFile() || st.isDirectory(); } });
        for (const f of (readdirSync(join(to, name), { recursive: true }) as string[]).sort()) {
          const file = join(to, name, f);
          if (!lstatSync(file).isFile()) continue;
          chmodSync(file, 0o444);
          hash.update(`${name}/${f}\0`).update(readFileSync(file)).update("\0");
        }
      } catch (err) {
        throw skillCopyFailure(s, err);
      }
    }
    writeFileSync(join(to, ".hash"), `${hash.digest("hex")}\n`);
    return to;
  } catch (err) {
    rmSync(to, { recursive: true, force: true });
    throw err;
  }
}

function skillCopyFailure(s: Skill, err: unknown) {
  const failure = new Error(`skill ${s.id}: cannot copy ${s.dir}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code) (failure as NodeJS.ErrnoException).code = code;
  return failure;
}

// A session id an engine reported, before it goes on a command line.
export const SESSION = /^[\w.:-]{1,200}$/;

/** A job: who and what it is for, and its start time (`at`). */
export interface JobClaims { agentId?: string | null; issueId?: string | null; at?: number }

/** A box job's box (the computer launcher made it): its container, the env file of its credentials and its out folder. */
export interface Box { container: string; envFile: string; outDir: string }

/**
 * One run of an engine under engine@1, in the job's agent computer: job.json in its out folder (the box's /aidenhq-out/job),
 * then `docker exec` of the module's bin there, under `boxWrap` (the launcher's scrub), with the module the launcher mounted
 * read-only at /opt/aidenhq/engine. The model comes through the box gateway with the box's run token; its connections are in
 * its Codex home already (the launcher's). Only an engine that runs in a box (`box: true`) runs at all.
 */
export function buildJob({ cfg, engine, worktree, jobDir, sessionId, prompt = "", job = {}, box, boxWrap }: {
  cfg: SandboxConfig; engine: Engine; worktree: string; jobDir: string; sessionId?: string; prompt?: string; job?: JobClaims; box: Box; boxWrap: string;
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
  // The box path of this run's folder (a job that runs a turn again after a stale session gets its own).
  const argv = ["docker", "exec", "--env-file", box.envFile, "-w", "/workspace", box.container, "sh", "-c", boxWrap, "aidenhq-computer", join("/opt/aidenhq/engine", relative(entry.dir, entry.bin)), join("/aidenhq-out", basename(jobDir))];
  return { argv, spec, entry };
}

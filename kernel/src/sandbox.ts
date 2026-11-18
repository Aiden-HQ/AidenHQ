// Jobs (K7, spec §3.3.1, §5.11). Every Engineer job runs in its agent computer (a box: buildJob writes its job.json and the
// `docker exec` line; jobs.ts runs it). No repo code runs on the host: a repo's checks are check jobs (checkjobs.ts). The engine
// registry (config/engines.json), an engine's state folder and the job credentials are here too.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { mintToken } from "./gateway/token.ts";

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
  timeout_minutes: number; stall_minutes: number; progress_minutes: number;
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

/** A job: who and what it is for, its jobcaps and start time (`at`). */
export interface JobClaims { agentId?: string | null; issueId?: string | null; at?: number; jobcaps?: string[]; observing?: boolean; token?: string }

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

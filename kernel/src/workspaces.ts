// The host's disk stays bounded (docs/operations.md "Disk"): what the kernel's jobs and checks leave on disk goes once it is
// no longer used, so `/` never grows without bound. One pass, every 15 minutes and soon after start, walks what is ON DISK:
//   <workDir>/tasks/<identifier>         a task's workspace (boxes.ts), kept between its jobs;
//   <workDir>/.cache-layers/<identifier> its jobs' copy-on-write build-cache overlays;
//   <stateDir>/<engine>/<agent>_<task>   a job's engine home (sandbox.ts engineState: the Codex home, its sessions), for
//                                        engines with per-task state. The stateDir itself (default ~/.local/state/aidenhq-runner,
//                                        despite the name the kernel's own) is never removed: only these per-task homes;
//   <workDir>/checks/<attempt>           a check attempt's folder (checkjobs.ts), left behind by a kernel that died mid-check.
// A folder goes when nothing live uses it (no admitted or running job on its task; no running check of that attempt) and
// either its task has been done or cancelled for CLOSED_DAYS, or it has been idle (its last job's end, or the folder's own
// mtime when no job names it) for IDLE_DAYS, whatever the task's state: an idle task that resumes clones again, and its next
// job starts a fresh session. Over PRESSURE of a disk used, both limits drop (a day idle, closed at all). What was published
// is in its repository already; what wasn't goes with the folder. Docker's growth is prune-docker.timer's (ops/units).
//
// Each folder is checked and renamed into its root's .trash in one synchronous step (no admission can slip in between),
// and the trash is then removed off the event loop, so a 100 GB first pass never stalls the gateway.
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { checkAttempt } from "./checkjobs.ts";

export const IDLE_DAYS = 3, CLOSED_DAYS = 1, PRESSURE = 0.8;
const DAY = 86_400_000;
const CLOSED = new Set(["done", "cancelled"]);
/** engineState's folder name for an agent's task (sandbox.ts). */
const homeName = (agent: string, task: string) => `${agent}/${task}`.replace(/[^\w.-]/g, "_").replace(/^\.*$/, "_");
const execFileP = promisify(execFile);

/** The fraction of each filesystem used (as `df` and the DiskSpaceLow rule count it), the fullest one. */
export const diskUsed = (paths: string[]) => Math.max(...paths.map((p) => { try { const s = statfsSync(p); return 1 - s.bavail / s.blocks; } catch { return 0; } }));

export function createDiskSweep({ db, workDir, stateDir, engines, log = () => {}, now = Date.now, used = () => diskUsed([workDir, "/"]) }: {
  db: DatabaseSync; workDir: string; stateDir: string;
  /** The engine kinds that keep a home per task (config/engines.json `state: task`). */
  engines: () => string[];
  log?: (msg: string, f?: Record<string, unknown>) => void; now?: () => number; used?: () => number;
}) {
  /** Who used a folder: the (agent, task) pairs of its jobs, and when the last one ended. */
  type Use = { pairs: { agent: string; task: string }[]; last: number };
  const add = (m: Map<string, Use>, key: string | null, agent: string, task: string, last: number) => {
    if (!key) return;
    const u = m.get(key) ?? { pairs: [], last: 0 };
    u.pairs.push({ agent, task }); u.last = Math.max(u.last, last);
    m.set(key, u);
  };
  const LIVE = "state IN ('admitted', 'running')";
  const liveIdent = (identifier: string) => Boolean(db.prepare(`SELECT 1 FROM jobs WHERE identifier = ? AND ${LIVE} LIMIT 1`).get(identifier));
  const livePair = (u?: Use) => Boolean(u?.pairs.some(({ agent, task }) => db.prepare(`SELECT 1 FROM jobs WHERE task = ? AND agent = ? AND ${LIVE} LIMIT 1`).get(task, agent)));
  const closedAt = (task: string) => {
    const r = db.prepare("SELECT json_extract(data, '$.to') AS st, at FROM facts WHERE subject = ? AND type = 'task.status_changed' ORDER BY at DESC, seq DESC LIMIT 1").get(`task:${task}`) as { st?: string; at: string } | undefined;
    return r && CLOSED.has(String(r.st)) ? Date.parse(r.at) : undefined;
  };

  /** One pass, at most `budgetMs` long. */
  return async function sweep(budgetMs = 10 * 60_000) {
    const until = now() + budgetMs;
    const pressure = used() >= PRESSURE;
    const idleMs = (pressure ? 1 : IDLE_DAYS) * DAY, closedMs = pressure ? 0 : CLOSED_DAYS * DAY;
    const byIdent = new Map<string, Use>(), byHome = new Map<string, Use>();
    for (const r of db.prepare("SELECT agent, task, identifier, MAX(COALESCE(ended, at)) AS last FROM jobs GROUP BY agent, task, identifier").all() as { agent: string; task: string; identifier: string | null; last: number }[]) {
      add(byIdent, r.identifier, r.agent, r.task, r.last);
      add(byHome, homeName(r.agent, r.task), r.agent, r.task, r.last);
    }
    const running = () => { try { return new Set((db.prepare("SELECT id, at FROM checks WHERE state = 'running'").all() as { id: string; at: number }[]).map((r) => checkAttempt(r.id, r.at))); } catch { return new Set<string>(); } };
    const roots: { root: string; use: (name: string) => Use | undefined; busy: (name: string, u?: Use) => boolean; gone?: (u: Use) => void }[] = [
      { root: join(workDir, "tasks"), use: (n) => byIdent.get(n), busy: liveIdent },
      { root: join(workDir, ".cache-layers"), use: (n) => byIdent.get(n), busy: liveIdent },
      { root: join(workDir, "checks"), use: () => undefined, busy: (n) => running().has(n) },
      ...engines().map((kind) => ({
        root: join(stateDir, kind), use: (n: string) => byHome.get(n), busy: (_: string, u?: Use) => livePair(u),
        // Its session went with it: the next job starts fresh instead of resuming one that is gone (boxes.ts lastSession).
        gone: (u: Use) => { for (const { agent, task } of u.pairs) db.prepare(`UPDATE jobs SET session = NULL WHERE agent = ? AND task = ? AND engine = ? AND NOT ${LIVE}`).run(agent, task, kind); },
      })),
    ];
    let removed = 0;
    for (const { root, use, busy, gone } of roots) {
      const trash = join(root, ".trash");
      let names: string[];
      try { names = readdirSync(root); } catch { continue; }
      for (const name of names) {
        if (now() > until) break;
        if (name.startsWith(".")) continue;
        const dir = join(root, name);
        // Synchronous from the check to the rename: no job is admitted in between.
        let st;
        try { st = lstatSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;
        const u = use(name);
        if (busy(name, u)) continue;
        const last = Math.max(u?.last ?? 0, st.mtimeMs);
        const closed = (u?.pairs ?? []).map(({ task }) => closedAt(task));
        const why = now() - last > idleMs ? "idle" : closed.length && closed.every((c) => c !== undefined && now() - c >= closedMs) ? "closed" : undefined;
        if (!why) continue;
        mkdirSync(trash, { recursive: true });
        renameSync(dir, join(trash, `${name}-${now()}`));
        if (u && gone) gone(u);
        removed++;
        log("unused folder removed", { dir, why, ...(pressure ? { pressure: true } : {}) });
        await new Promise((ok) => setImmediate(ok));
      }
      // Off the event loop: chmod first (read-only Go module caches, an overlay's mode-000 work dir), then remove.
      try { statSync(trash); } catch { continue; }
      await execFileP("chmod", ["-R", "u+rwx", trash]).catch(() => {});
      await rm(trash, { recursive: true, force: true, maxRetries: 2 }).catch((e: Error) => log("trash not removed", { trash, err: e.message }));
    }
    return { removed, pressure };
  };
}

export const RUNTIME_DAYS = 7;

/**
 * Paperclip makes a codex home per agent and skill set (`<company>/codex-home/skill-runtimes/<agent>/<hash>`: sessions and
 * state databases, 17 GB on the EX44). A changed skill set gets a new hash and the old one is never used again, so one
 * untouched for RUNTIME_DAYS goes (a runtime in use has its files written; the next run of the skill set makes it again).
 */
export function pruneSkillRuntimes({ companiesDir, log = () => {}, now = Date.now }: { companiesDir: string; log?: (msg: string, f?: Record<string, unknown>) => void; now?: () => number }) {
  const ls = (d: string) => { try { return readdirSync(d); } catch { return []; } };
  const newest = (d: string): number => Math.max(statSync(d).mtimeMs, ...ls(d).map((n) => statSync(join(d, n)).mtimeMs));
  for (const company of ls(companiesDir)) {
    const root = join(companiesDir, company, "codex-home", "skill-runtimes");
    for (const agent of ls(root)) for (const hash of ls(join(root, agent))) {
      const dir = join(root, agent, hash);
      if (!statSync(dir).isDirectory() || newest(dir) > now() - RUNTIME_DAYS * 86_400_000) continue;
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      log("unused skill runtime removed", { dir });
    }
  }
}

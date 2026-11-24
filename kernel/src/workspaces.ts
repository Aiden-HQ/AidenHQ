// The host's disk stays bounded (docs/operations.md "Task workspaces and disk"): what jobs and checks leave on disk goes
// once nothing uses it. One pass, every 15 minutes and soon after start, walks what is ON DISK:
//   <workDir>/tasks/<identifier>         a task's workspace (boxes.ts), kept between its jobs;
//   <workDir>/.cache-layers/<identifier> legacy copy-on-write build-cache overlays;
//   <stateDir>/<engine>/<agent>_<task>   a job's engine home (sandbox.ts engineState: the Codex home and its sessions), for
//                                        engines with per-task state. stateDir (default ~/.local/state/aidenhq-runner) is the
//                                        kernel's LIVE job state despite its name: it and each engine folder in it are never
//                                        removed, only these per-task homes, which the next job's engineState makes again;
//   <workDir>/checks/<attempt>           a check attempt's folder (checkjobs.ts), left by a kernel that died mid-check;
//   <workDir>/.cache/npm                 every job box's shared npm cache (services/computer/lib.ts npmCacheDir): started
//                                        afresh once it is CACHE_DAYS old, or under pressure, while no job is live (a parked
//                                        box still mounting the old one never fits a job again: its folder is gone).
// A folder goes when nothing live uses it (no admitted or running job, no box released less than a day ago; no running check
// of that attempt) and either its task has been done or cancelled for CLOSED_DAYS with no job started since (and the control plane confirms it), or it has been
// idle (its last job's end, or the folder's mtime when no job names it) for IDLE_DAYS whatever the task's state: an idle task
// that resumes clones again, and its next job starts a fresh session. When a disk is over PRESSURE used, the limits drop (a
// day idle, closed at all). What was published is in its repository; what wasn't goes with the folder. Docker's growth is
// prune-docker.timer's (ops/units).
//
// Each folder is checked and renamed into its root's .trash in one synchronous step (no admission can slip in between),
// and the trash is then removed off the event loop, so a 100 GB first pass never stalls the gateway.
import { lstatSync, mkdirSync, readdirSync, renameSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { npmCacheDir } from "../../services/computer/lib.ts";
import { checkAttempt } from "./checkjobs.ts";
import { removeTree, trashAway } from "./trash.ts";

export const IDLE_DAYS = 3, CLOSED_DAYS = 1, PRESSURE = 0.8, CACHE_DAYS = 7;
/** How long the closed rule waits on the control plane's answer before it counts as none. */
export const LOOKUP_MS = 10_000;
const DAY = 86_400_000;
const CLOSED = new Set(["done", "cancelled"]);
/** engineState's folder name for an agent's task (sandbox.ts; the launcher checks the same). */
const homeName = (agent: string, task: string) => `${agent}/${task}`.replace(/[^\w.-]/g, "_").replace(/^\.*$/, "_");

/** The fraction of each filesystem used (as `df` and the DiskSpaceLow rule count it), the fullest one. */
export const diskUsed = (paths: string[]) => Math.max(...paths.map((p) => { try { const s = statfsSync(p); return 1 - s.bavail / s.blocks; } catch { return 0; } }));

export function createDiskSweep({ db, workDir, stateDir, engines, stillClosed, log = () => {}, now = Date.now, used = () => diskUsed([workDir, stateDir, "/"]), stopping = () => false }: {
  db: DatabaseSync; workDir: string; stateDir: string;
  /** The control plane's word that a task is done or cancelled now (the closed rule's last check): undefined when it gave none. */
  stillClosed: (task: string) => Promise<boolean | undefined>;
  /** The kernel is draining (main.ts): its pass stops, so only the next kernel's sweep runs beside its admissions. */
  stopping?: () => boolean;
  /** The engine kinds that keep a home per task (config/engines.json `state: task`). */
  engines: () => string[];
  log?: (msg: string, f?: Record<string, unknown>) => void; now?: () => number; used?: () => number;
}) {
  /** Who used a folder: the (agent, task) pairs of its jobs, when the last one ended and when the last one started. */
  type Use = { pairs: { agent: string; task: string }[]; last: number; started: number };
  type Row = { agent: string; task: string; last: number; started: number };
  const use = (rows: Row[]): Use | undefined => rows.length ? { pairs: rows.map(({ agent, task }) => ({ agent, task })), last: Math.max(...rows.map((r) => r.last)), started: Math.max(...rows.map((r) => r.started)) } : undefined;
  // Read in the folder's own synchronous step, so a job that ended while the pass yielded counts.
  const useIdent = (identifier: string) => use(db.prepare("SELECT agent, task, MAX(COALESCE(ended, at)) AS last, MAX(at) AS started FROM jobs WHERE identifier = ? GROUP BY agent, task").all(identifier) as Row[]);
  // An engine home's name is engineState's normalization of its (agent, task): its pairs are that engine's jobs whose pair
  // normalizes to the name, all read in the folder's own step (each engine has its own state folder).
  type Pair = { agent: string; task: string };
  const pairsOf = (kind: string, name: string, live = "1") => (db.prepare(`SELECT DISTINCT agent, task FROM jobs WHERE engine = ? AND ${live}`).all(kind) as Pair[]).filter((r) => homeName(r.agent, r.task) === name);
  const useHome = (kind: string) => (name: string) =>
    use(pairsOf(kind, name).flatMap(({ agent, task }) => db.prepare("SELECT agent, task, MAX(COALESCE(ended, at)) AS last, MAX(at) AS started FROM jobs WHERE agent = ? AND task = ? AND engine = ? GROUP BY agent, task").all(agent, task, kind) as Row[]));
  // In use: a job admitted or running, or one that ended within a day whose box is not released yet (release still reads the
  // workspace and the box keeps its mounts until then, boxes.ts tend; a release stuck for longer pins nothing).
  const LIVE = () => `(state IN ('admitted', 'running') OR (box IS NOT NULL AND (released IS NULL OR released < 0) AND COALESCE(ended, at) > ${Math.floor(now() - DAY)}))`;
  const liveIdent = (identifier: string) => Boolean(db.prepare(`SELECT 1 FROM jobs WHERE identifier = ? AND ${LIVE()} LIMIT 1`).get(identifier));
  const closedAt = (task: string) => {
    const r = db.prepare("SELECT json_extract(data, '$.to') AS st, at FROM facts WHERE subject = ? AND type = 'task.status_changed' ORDER BY at DESC, seq DESC LIMIT 1").get(`task:${task}`) as { st?: string; at: string } | undefined;
    return r && CLOSED.has(String(r.st)) ? Date.parse(r.at) : undefined;
  };

  /** One pass, at most `budgetMs` long. */
  return async function sweep(budgetMs = 10 * 60_000) {
    const until = now() + budgetMs;
    const pressure = used() >= PRESSURE;
    const idleMs = (pressure ? 1 : IDLE_DAYS) * DAY, closedMs = pressure ? 0 : CLOSED_DAYS * DAY;
    const running = () => { try { return new Set((db.prepare("SELECT id, at FROM checks WHERE state = 'running'").all() as { id: string; at: number }[]).map((r) => checkAttempt(r.id, r.at))); } catch { return new Set<string>(); } };
    // Its sessions went with it: the next job starts fresh instead of resuming one whose files are gone (boxes.ts lastSession).
    const fresh = (u: Use, engine?: string) => { for (const { agent, task } of u.pairs) db.prepare(`UPDATE jobs SET session = NULL WHERE agent = ? AND task = ? AND engine = COALESCE(?, engine) AND NOT ${LIVE()}`).run(agent, task, engine ?? null); };
    const roots: { root: string; use: (name: string) => Use | undefined; busy: (name: string, u?: Use) => boolean; gone?: (u: Use) => void }[] = [
      { root: join(workDir, "tasks"), use: useIdent, busy: liveIdent, gone: (u) => fresh(u) },
      { root: join(workDir, ".cache-layers"), use: useIdent, busy: liveIdent },
      { root: join(workDir, "checks"), use: () => undefined, busy: (n) => running().has(n) },
      ...engines().map((kind) => ({
        root: join(stateDir, kind), use: useHome(kind), busy: (n: string) => pairsOf(kind, n, LIVE()).length > 0,
        gone: (u: Use) => fresh(u, kind),
      })),
    ];
    let removed = 0, unreachable = false;
    for (const { root, use, busy, gone } of roots) {
      const trash = join(root, ".trash");
      let names: string[];
      try { names = readdirSync(root); } catch { continue; }
      for (const name of names) {
        await new Promise((ok) => setImmediate(ok)); // each folder's step is short; the gateway runs between them
        if (now() > until || stopping()) break;
        if (name.startsWith(".")) continue;
        const dir = join(root, name);
        // Synchronous from the check to the rename: no job is admitted in between.
        const decide = () => {
          let st;
          try { st = lstatSync(dir); } catch { return undefined; }
          if (!st.isDirectory()) return undefined;
          const u = use(name);
          if (busy(name, u)) return undefined;
          const last = Math.max(u?.last ?? 0, st.mtimeMs);
          const closed = (u?.pairs ?? []).map(({ task }) => closedAt(task));
          // Closed: every task of it closed for the grace, and no job started since (the job that closed it may end after the
          // close; work after a reopen is only ever the idle rule's).
          const why = now() - last > idleMs ? "idle" : u && closed.length && closed.every((c) => c !== undefined && now() - c >= closedMs && c >= u.started) ? "closed" : undefined;
          return why && { why, u };
        };
        let d = decide();
        if (d?.why === "closed") {
          // The facts log can lag a reopen: the control plane confirms every task is still closed, then the step runs again.
          // One failed lookup ends the closed rule for this pass, so an unreachable control plane never spends the pass's
          // budget: idle folders and the later roots are still swept.
          if (unreachable) continue;
          const tasks = [...new Set(d.u!.pairs.map((p) => p.task))];
          // Unknown is a thrown error, a lookup over LOOKUP_MS, or an answer that isn't one (undefined: a 5xx, a 404).
          const ask = (t: string) => {
            let timer: number | NodeJS.Timeout | undefined;
            return Promise.race([stillClosed(t), new Promise<undefined>((ok) => { timer = setTimeout(ok, LOOKUP_MS); })]).catch(() => undefined).finally(() => clearTimeout(timer));
          };
          const answers = await Promise.all(tasks.map(ask));
          if (answers.some((a) => a === undefined)) unreachable = true;
          if (!answers.every((a) => a === true)) continue;
          if (stopping()) break; // drained while it waited: the next kernel's sweep decides
          d = decide();
        }
        if (!d) continue;
        const { why, u } = d;
        // One folder that can't be moved (its parent's mode, a race) is logged and skipped; the rest of the pass goes on.
        try {
          mkdirSync(trash, { recursive: true });
          renameSync(dir, join(trash, `${name}-${now()}`));
          if (u && gone) gone(u);
        } catch (e) {
          log("unused folder not removed", { dir, err: (e as Error).message });
          continue;
        }
        removed++;
        log("unused folder removed", { dir, why, ...(pressure ? { pressure: true } : {}) });
      }
      // Off the event loop: chmod first (read-only Go module caches, an overlay's mode-000 work dir), then remove.
      try { statSync(trash); } catch { continue; }
      await removeTree(trash).catch((e: Error) => log("trash not removed", { trash, err: e.message }));
    }
    // The shared npm cache, started afresh (the next job's box makes it again).
    const cache = npmCacheDir(workDir), born = (() => { try { return statSync(cache).birthtimeMs; } catch { return undefined; } })();
    if (born !== undefined && (pressure || now() - born > CACHE_DAYS * DAY) && !stopping() && !db.prepare("SELECT 1 FROM jobs WHERE state IN ('admitted', 'running') LIMIT 1").get()) {
      try { trashAway(cache, join(workDir, ".cache", ".trash"), log); log("shared npm cache started afresh", { cache, ...(pressure ? { pressure: true } : {}) }); } catch (e) { log("shared npm cache not removed", { cache, err: (e as Error).message }); }
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
      trashAway(dir, join(companiesDir, company, "codex-home", ".trash"), log);
      log("unused skill runtime removed", { dir });
    }
  }
}

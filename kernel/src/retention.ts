// Retention (owner, 2026-11-24): the big text of a FINISHED kernel row is cleared 14 days after its terminal transition, and
// Paperclip's run history and activity log are pruned (Paperclip prunes neither). One daily timer; small batches, each its own
// transaction on the kernel's one connection, so the event loop is never held for long.
//   records  finished (not review, owner, approved, claimed), by updated_at (each move sets it, so it is the terminal move):
//            card.details -> an explicit note (card.expired; an apply's stays: it is the grader's evidence), context -> NULL, args -> its small keys. The veto key (connection,
//            tool), the PRs a write names (prs, only, repo, head...) are small and stay; `paths` is filled from the diff first
//            (work.ts reads it), the summary lines of the card, the outcome and the reviewer's note stay.
//   jobs     finished (not admitted, running), by ended: full_prompt -> NULL (only a running job resumes from it: jobs.ts
//            adoptRestart), progress -> the last words and the step count (work.ts shows it).
//   checks   finished (not running), by ended: spec -> '{}' (a re-ask writes it again: checkjobs.ts start), result -> the
//            expired marker (a re-ask of a result recipe runs it again). The receipt, verdict, hash and cost stay.
// `expired` (ms) marks a cleared row and leaves a partial index, so each day's scan reads only what is newly due.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { inTx } from "./factlog.ts";

export const KERNEL_DAYS = 14, PAPERCLIP_RUN_DAYS = 7, PAPERCLIP_ACTIVITY_DAYS = 30;
const DAY = 864e5, BATCH = 100, PAUSE_MS = 25, ARG_MAX = 1000, SAID_MAX = 500;
export const EXPIRED_NOTE = `(expired: the detail of a finished write is kept ${KERNEL_DAYS} days)`;
/** What a cleared check result is: views read it as "expired" (checkjobs.ts), never as a result. */
export const EXPIRED_RESULT = '{"expired":true}';

const REC_LIVE = "('review','owner','approved','claimed')", JOB_LIVE = "('admitted','running')";
const REC_DUE = `expired IS NULL AND state NOT IN ${REC_LIVE}`, JOB_DUE = `expired IS NULL AND state NOT IN ${JOB_LIVE}`, CHECK_DUE = "expired IS NULL AND state != 'running'";

const has = (db: DatabaseSync, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
/** The partial index of each table's due rows (the `expired` column is each table's own: records.ts, jobs.ts, checkjobs.ts). */
function ensure(db: DatabaseSync) {
  for (const [table, due, at] of [["records", REC_DUE, "updated_at"], ["jobs", JOB_DUE, "COALESCE(ended, at)"], ["checks", CHECK_DUE, "COALESCE(ended, at)"]] as const) {
    if (!has(db, table)) continue;
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_expiry ON ${table} (${at}) WHERE ${due}`);
  }
}

const json = (s: unknown): any => { try { return JSON.parse(String(s)); } catch { return undefined; } };

/** The args keys readers bind to later whatever their size: a veto's connection and tool, a write's PRs (flow, quality and the kernel loop read `prs` and `only`; a 30-PR batch is several KB). */
const ARG_KEYS = new Set(["connection", "tool", "prs", "only"]);
/** A record's args as they stay: those keys, and every other top-level key whose value is small (a PR's repo and head, a path); the body of a post is not. */
export function keptArgs(args: string): string {
  const a = json(args);
  if (a && typeof a === "object" && !Array.isArray(a)) return JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k, v]) => ARG_KEYS.has(k) || JSON.stringify(v ?? null).length <= ARG_MAX)));
  return args.length <= ARG_MAX ? args : "null";
}
/** A card with its details replaced by the note, and the files its diff names (the paths work.ts reads for a record that has none). */
export function keptCard(card: string): { card: string; paths: string[] } {
  const c = json(card);
  if (!c || typeof c !== "object" || typeof c.details !== "string") return { card, paths: [] };
  const paths = [...new Set([...c.details.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1] as string))];
  return { card: JSON.stringify({ ...c, details: EXPIRED_NOTE, expired: true }), paths };
}
/** A job's progress as it stays: the last words, how many steps there were, and the mark. */
export function keptProgress(progress: string) {
  const p = json(progress) ?? {};
  return JSON.stringify({ ...(typeof p.said === "string" ? { said: p.said.slice(0, SAID_MAX) } : {}), ...(p.saidAt ? { saidAt: p.saidAt } : {}), stepCount: Array.isArray(p.steps) ? p.steps.length : (p.stepCount ?? 0), expired: true });
}

export type Cleared = { records: number; jobs: number; checks: number; bytes: number };
const size = (...v: unknown[]) => v.reduce<number>((n, x) => n + (typeof x === "string" ? x.length : 0), 0);

/** One pass over everything due at `now` . Batches of BATCH rows, each in one transaction. */
export async function clearFinished(db: DatabaseSync, { now = Date.now(), stopping = (): boolean => false, pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {}): Promise<Cleared> {
  ensure(db);
  const cutoff = now - KERNEL_DAYS * DAY, iso = new Date(cutoff).toISOString(), out: Cleared = { records: 0, jobs: 0, checks: 0, bytes: 0 };
  // Prepared per table when it exists (a statement on a missing table fails to prepare).
  const sel = {
    records: () => db.prepare(`SELECT id, kind, card, args, context, paths FROM records WHERE ${REC_DUE} AND updated_at < ? ORDER BY updated_at LIMIT ?`),
    jobs: () => db.prepare(`SELECT id, full_prompt, progress FROM jobs WHERE ${JOB_DUE} AND COALESCE(ended, at) < ? ORDER BY COALESCE(ended, at) LIMIT ?`),
    checks: () => db.prepare(`SELECT id, spec, result FROM checks WHERE ${CHECK_DUE} AND COALESCE(ended, at) < ? ORDER BY COALESCE(ended, at) LIMIT ?`),
  };
  const upd = {
    records: () => db.prepare(`UPDATE records SET card = ?, args = ?, context = NULL, paths = COALESCE(paths, ?), expired = ? WHERE id = ? AND ${REC_DUE}`),
    jobs: () => db.prepare(`UPDATE jobs SET full_prompt = NULL, progress = ?, expired = ? WHERE id = ? AND ${JOB_DUE}`),
    checks: () => db.prepare(`UPDATE checks SET spec = '{}', result = CASE WHEN result IS NULL THEN NULL ELSE '${EXPIRED_RESULT}' END, expired = ? WHERE id = ? AND ${CHECK_DUE}`),
  };
  for (const table of ["records", "jobs", "checks"] as const) {
    if (!has(db, table)) continue;
    const select = sel[table](), update = upd[table]();
    for (;;) {
      if (stopping()) return out;
      const rows = select.all(table === "records" ? iso : cutoff, BATCH) as Record<string, any>[];
      if (!rows.length) break;
      const work = () => {
        for (const r of rows) {
          if (table === "records") {
            // An apply's diff is the grader's evidence (work.ts, modules/grading) whenever the task is graded: its card stays (about 1 MB in all).
            const card = r.kind === "kernel.apply" ? { card: r.card, paths: [] } : keptCard(r.card), args = keptArgs(r.args);
            out.bytes += size(r.card, r.args, r.context) - size(card.card, args);
            update.run(card.card, args, card.paths.length && !r.paths ? JSON.stringify(card.paths) : null, now, r.id);
          } else if (table === "jobs") {
            const progress = keptProgress(r.progress);
            out.bytes += size(r.full_prompt, r.progress) - size(progress);
            update.run(progress, now, r.id);
          } else {
            out.bytes += size(r.spec, r.result) - (r.result ? EXPIRED_RESULT.length : 0) - 2;
            update.run(now, r.id);
          }
          out[table]++;
        }
      };
      inTx(db, "retention_clear", work);
      if (rows.length < BATCH) break;
      await pause(PAUSE_MS);
    }
  }
  return out;
}

/** Paperclip's run history and activity log, pruned inside its container (paperclip-prune.mjs): the container has the only client that reaches its embedded Postgres. */
export function pruneIn(container: string, { stopping = (): boolean => false, run = spawn }: { stopping?: () => boolean; run?: typeof spawn } = {}): Promise<string> {
  const script = readFileSync(new URL("./paperclip-prune.mjs", import.meta.url));
  return new Promise((ok, no) => {
    const stop = `/tmp/aidenhq-prune-${randomBytes(6).toString("hex")}.stop`;
    const child = run("docker", ["exec", "-i", "-e", `STOP_FILE=${stop}`, "-e", `RUN_DAYS=${PAPERCLIP_RUN_DAYS}`, "-e", `ACTIVITY_DAYS=${PAPERCLIP_ACTIVITY_DAYS}`, "-e", "DEADLINE_MIN=45", container, "node", "--input-type=module", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    // The worker bounds itself (DEADLINE_MIN) and holds an advisory lock against a second pass; this only ends a hung docker client.
    const t = setTimeout(() => child.kill("SIGTERM"), 70 * 60_000);
    // A drain: this pass's own stop file ends its worker at the next batch (killing the docker client would not). Polled twice a
    // second, and touched on exit too, since a drained kernel can exit before a poll.
    const touch = () => spawnSync("docker", ["exec", container, "touch", stop], { stdio: "ignore", timeout: 10_000 });
    const drain = setInterval(() => { if (stopping()) (clearInterval(drain), touch()); }, 500).unref();
    process.once("exit", touch);
    child.stdin!.on("error", () => {}); // the docker client exited before reading the script: its exit code says so
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    child.on("error", (e) => (clearTimeout(t), clearInterval(drain), process.off("exit", touch), no(e)));
    child.on("close", (code) => (clearTimeout(t), clearInterval(drain), process.off("exit", touch), code === 0 ? ok(out.trim().split("\n").pop() ?? "") : no(new Error(`exit ${code}: ${(err || out).trim().slice(0, 500)}`))));
    child.stdin!.end(script);
  });
}

/** The daily pass: `run()` clears the kernel's finished rows, then prunes Paperclip; each logs its result or its failure, and one failing never stops the other. */
export function createRetention({ db, log, container = process.env.AIDENHQ_PAPERCLIP_CONTAINER || "aidenhq-paperclip-1", stopping = (): boolean => false }: { db: DatabaseSync; log: (msg: string, fields?: Record<string, unknown>) => void; container?: string; stopping?: () => boolean }) {
  let busy = false;
  return {
    async run() {
      if (busy) return;
      busy = true;
      try {
        const t = Date.now();
        await clearFinished(db, { stopping }).then((c) => log("retention: kernel rows cleared", { ...c, ms: Date.now() - t }), (e: Error) => log("WARNING: retention failed on the kernel's rows", { err: String(e.message).slice(0, 300) }));
        if (!stopping()) await pruneIn(container, { stopping }).then((s) => log("retention: paperclip pruned", { result: s }), (e: Error) => log("WARNING: retention couldn't prune paperclip", { err: String(e.message).slice(0, 300) }));
      } finally { busy = false; }
    },
  };
}

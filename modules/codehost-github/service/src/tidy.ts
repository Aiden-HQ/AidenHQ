// The code host's tidying (W11, the codehost half; the runner's pruneReviewedRefs, moved): a job's head the service kept in its cache
// clone (refs/ws/<task>/<branch>, which outlives the task's workspace; fromWorkspace notes each in an index with the date) is dropped
// after REVIEWED_RETENTION_DAYS, and so is a note whose ref is already gone. Nothing else deletes them; a merged PR's branch stays
// GitHub's to delete.
//
// Started by main.ts.
// Not ported: closeReviewedTasks. It closes the owner's own review-request tasks, which the kernel's POST /v1/tasks/:task/close
// refuses a module (it closes only tasks that module filed); it waits on a kernel route for owner tasks (see the PR).
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
// service.ts imports noteKept from here and this imports SAFE_GIT_ARGS from there: each is used only inside functions, after both load.
import { SAFE_GIT_ARGS } from "./service.ts";

const run = promisify(execFile);
/** A kept head's retention: a task that comes back to it later, or the owner's second look, has this long. */
export const REVIEWED_RETENTION_DAYS = 30;

/** What the service kept of the jobs' heads (refs/ws/…) and when, one JSON line each, beside the cache clones. */
export const reviewedIndex = (cacheDir: string) => join(cacheDir, ".reviewed-refs.jsonl");
/** A head kept at `ref` in `repo`'s ws cache clone, now (appended: two jobs at once each keep theirs; a ref kept again takes the newer date). */
export const noteKept = (cacheDir: string, { repo, ref, now = new Date() }: { repo: string; ref: string; now?: Date }) => appendFileSync(reviewedIndex(cacheDir), `${JSON.stringify({ repo, ref, at: now.toISOString() })}\n`);

/** git in one of the service's bare ws cache clones (<cache>/ws/<org>/<name>.git, lowercase): no global or system config. */
async function git(cacheDir: string, repo: string, args: string[]): Promise<string> {
  const [org, name] = repo.toLowerCase().split("/") as [string, string];
  const dir = join(cacheDir, "ws", org, `${name}.git`);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cacheDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  return (await run("git", [...SAFE_GIT_ARGS, "--git-dir", dir, ...args], { env })).stdout.trim();
}

type Note = { repo: string; ref: string; at: string };
const readNotes = (cacheDir: string): Note[] =>
  (existsSync(reviewedIndex(cacheDir)) ? readFileSync(reviewedIndex(cacheDir), "utf8") : "").split("\n").filter(Boolean).flatMap((l): Note[] => {
    try {
      const e = JSON.parse(l);
      return typeof e?.repo === "string" && typeof e?.ref === "string" && e.ref.startsWith("refs/ws/") ? [e] : [];
    } catch { return []; }
  });

/** Drop kept heads past `days` and any whose ref is already gone; the refs removed (a ref kept again takes the newer date). */
export async function pruneReviewedRefs(cacheDir: string, { days = REVIEWED_RETENTION_DAYS, now = Date.now() } = {}): Promise<string[]> {
  const cut = now - days * 86_400_000;
  const latest = new Map<string, Note>();
  for (const e of readNotes(cacheDir)) {
    const key = `${e.repo.toLowerCase()} ${e.ref}`;
    const prev = latest.get(key);
    if (!prev || Date.parse(e.at) > Date.parse(prev.at)) latest.set(key, e);
  }
  const kept: Note[] = [];
  const removed: string[] = [];
  for (const e of latest.values()) {
    const tip = await git(cacheDir, e.repo, ["rev-parse", "--verify", "--quiet", `${e.ref}^{commit}`]).catch(() => "");
    if (tip && Date.parse(e.at) >= cut) kept.push(e);
    else {
      if (tip) await git(cacheDir, e.repo, ["update-ref", "-d", e.ref]).catch(() => {});
      removed.push(e.ref);
    }
  }
  if (latest.size) writeFileSync(reviewedIndex(cacheDir), kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return removed;
}

/** The tidying: kept heads pruned now and once a day (the runner's cadence); returns its stop function. */
export function startTidy({ cacheDir, log = () => {} }: { cacheDir: string; log?: (msg: string, f?: Record<string, unknown>) => void }): () => void {
  const sweep = () => void pruneReviewedRefs(cacheDir).catch((err) => log("reviewed refs not pruned", { err: String(err.message ?? err).slice(0, 200) }));
  sweep();
  const timer = setInterval(sweep, 24 * 60 * 60_000);
  return () => clearInterval(timer);
}

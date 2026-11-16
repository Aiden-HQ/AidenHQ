// A job that stops making progress is stopped, one that waits on CI is not. Read from the engine's progress events
// (their `steps`: every tool call, the engine's own words for it), so every engine is judged alike: no edit, commit or
// test run for WINDOW, or one file read READS times with no edit between, stops the job; time spent sleeping or watching
// CI doesn't count toward the window and extends the deadline (hard maximum HARD_MAX times the base) once something is
// committed to wait on.
import { git as taskGit } from "./git.mjs";

export const WINDOW_MS = 35 * 60_000;
const READS = 20;
const HARD_MAX = 1.5;

const COMMAND = /^(?:Running|Bash|bash|shell)\b/;
const EDIT = /^(?:Editing|Edit|Write|MultiEdit|NotebookEdit|edit|write|multiedit|patch|apply_patch)\b|\bapply_patch\b|\bsed\s+-i|\bgit\s+apply\b|\bperl\s+-pi|\btee\b|<<-?\s*['"]?\w+|(?<![\d&<>=-])>{1,2}\s*(?!&|\/dev\/null)[\w./~-]+/;
const COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push)\b/;
const TEST = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|typecheck|lint)\b|\btsc\b|\bvitest\b|\bjest\b|\bnode\s+(?:--\S+\s+)*--test\b|\bpytest\b|\bgo\s+(?:test|build|vet)\b|\bcargo\s+(?:test|build|check)\b|\bmake\s+(?:test|build|check)\b/;
const WAIT = /\bsleep\s+\d|--watch\b|\baidenhq[- ]wait\b/;
const FILE = /[\w@./-]+\.(?:tsx?|mjs|cjs|jsx?|json|md|ya?ml|py|go|rs|sh|css|html)\b/g;

export interface Step { at: string; text: string }

export function progressTracker({ start = Date.now(), since = start, windowMs = WINDOW_MS }: { start?: number; since?: number; windowMs?: number } = {}) {
  let last = since; // the last edit, commit or test run
  let waited = 0; // waiting since then
  let waitFrom: number | undefined; // a wait the job is in
  let credit = 0; // waiting after a first commit: time the deadline gives back
  let commitAt = 0;
  let activity = "";
  let seenAt = 0;
  const seenSame = new Set<string>();
  const reads = new Map<string, number>();

  const endWait = (t: number) => {
    if (waitFrom === undefined) return;
    waited += t - waitFrom;
    if (commitAt) credit += t - waitFrom;
    waitFrom = undefined;
  };

  return {
    /** Feed the steps of a progress event (the whole recent list each time: the ones already seen are skipped). */
    add(steps: Step[] = []) {
      for (const { at, text } of steps) {
        const t = Date.parse(at) || Date.now();
        if (t < seenAt || (t === seenAt && seenSame.has(text))) continue;
        if (t > seenAt) seenSame.clear();
        seenAt = t;
        seenSame.add(text);
        endWait(t);
        activity = text;
        const cmd = COMMAND.test(text);
        if (cmd && WAIT.test(text)) {
          waitFrom = t;
          continue;
        }
        const edit = EDIT.test(cmd ? text : text.split(/[:\s]/)[0] ?? "");
        const commit = cmd && COMMIT.test(text);
        if (edit || commit || (cmd && TEST.test(text))) {
          last = t;
          waited = 0;
        }
        if (commit) commitAt = t;
        if (edit) reads.clear();
        else for (const f of new Set(text.match(FILE) ?? [])) reads.set(f, (reads.get(f) ?? 0) + 1);
      }
    },
    /** Why the job should stop, or undefined. */
    check(now = Date.now()): string | undefined {
      const idle = now - last - waited - (waitFrom === undefined ? 0 : now - waitFrom);
      const lastly = `last activity: ${activity || "none"}`;
      if (idle > windowMs) return `no progress for ${Math.round(windowMs / 60_000)} min; ${lastly}`;
      for (const [file, n] of reads) if (n >= READS) return `${file} read ${n} times with no edit; ${lastly}`;
    },
    /** True while the job sleeps or watches CI (silence is then expected). */
    get waiting() {
      return waitFrom !== undefined;
    },
    /** The deadline: the base one, moved out by waiting (after a commit) and by new commits, up to the hard maximum. */
    deadline(base: number, now = Date.now()): number {
      const open = waitFrom !== undefined && commitAt ? now - waitFrom : 0;
      return Math.min(start + (base - start) * HARD_MAX, Math.max(base + credit + open, commitAt + windowMs));
    },
  };
}

/** The commits and branches a brief names: `abc1234` after "commit"/"sha", or `branch` after "on/from/onto branch". */
export function namedRefs(text: string): { shas: string[]; branches: string[] } {
  const shas = [...text.matchAll(/\b(?:commit|sha|revision|rev)s?\s*[:=]?\s*`?([0-9a-f]{7,40})\b/gi)].map((m) => String(m[1]).toLowerCase());
  const branches = [...text.matchAll(/\b(?:on|from|onto|off|of)\s+(?:the\s+)?branch\s+`([^`\s]+)`/gi)].map((m) => String(m[1]));
  return { shas: [...new Set(shas)], branches: [...new Set(branches)] };
}

// The repositories are an agent's clones and the refs come from a brief: every call goes through git.mjs's hardened git
// (no hooks or clone config, ceiling dirs), after refs are checked to be plain names, and operands follow `--`.
const git = (cwd: string, ...args: string[]) => taskGit(cwd, ...args).then(() => true, () => false);

/** The first commit or branch the brief names that none of these repositories (paths) has (or that isn't a plain name), as one line; "" when all exist. */
export async function staleRef(text: string, paths: string[]): Promise<string> {
  const { shas, branches } = namedRefs(text);
  const where = paths.length > 1 ? "any of the task's repositories" : "the repository";
  const anywhere = async (ok: (p: string) => Promise<boolean>) => {
    for (const p of paths) if (await ok(p)) return true;
    return false;
  };
  for (const sha of shas) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return `the brief names \`${sha}\`, which isn't a commit id`;
    if (!(await anywhere((p) => git(p, "cat-file", "-e", `${sha}^{commit}`).then((ok) => ok || git(p, "fetch", "-q", "origin", "--", sha))))) return `the brief names commit \`${sha}\`, which isn't in ${where}`;
  }
  for (const b of branches) {
    if (b.startsWith("-") || !paths[0] || !(await git(paths[0], "check-ref-format", "--branch", b))) return `the brief names \`${b}\`, which isn't a branch name`;
    const has = (p: string) => git(p, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`).then((ok) => ok || git(p, "ls-remote", "--exit-code", "--heads", "origin", "--", b));
    if (!(await anywhere(has))) return `the brief names branch \`${b}\`, which doesn't exist in ${where}`;
  }
  return "";
}

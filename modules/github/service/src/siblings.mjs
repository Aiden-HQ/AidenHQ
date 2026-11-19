// The task's other PRs already merged into a change's base, for the AI reviewer (reviewer@1 `siblings`, rendered by the kernel's
// siblings.ts): the old runner's cardSiblingRows, read from what this module knows. Candidates are the PRs this code host opened
// for the same task (pr-tasks.json, keyed by the task's identifier), less the change's own. A sibling counts only as GitHub's own
// merge (`merged`, a merge commit) into exactly this base, with that commit on the base in the cache clone; its files and what the
// base changed again since are read there by git. Anything unread stays undefined, so it renders "not read", never "unchanged".
// It never fails the plan: a read that fails or runs past the deadline leaves that sibling (or the rest) out.

/** The most candidates read for one change, and how long all the reads may take. */
export const MAX_CANDIDATES = 10;
export const DEADLINE_MS = 10_000;

/** The PRs pr-tasks.json names for task `identifier`, as {repo, number}, less the change's own (`own`: `repo#n` and `repo@branch`, repo in lower case). */
export function candidatesOf(prTasks, identifier, own = new Set()) {
  if (!identifier) return [];
  const out = [];
  for (const [url, v] of Object.entries(prTasks ?? {})) {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/i.exec(url);
    const repo = m?.[1].toLowerCase();
    if (!m || v?.task !== identifier || own.has(`${repo}#${m[2]}`) || own.has(`${repo}@${v.branch}`)) continue;
    out.push({ repo, number: Number(m[2]) });
  }
  return out.slice(-MAX_CANDIDATES);
}

/**
 * The siblings merged into each base: `bases` [{repo, base, dir, tip}] (a cache clone holding the base at `tip`), `pr(repo, n)`
 * GitHub's REST read of a PR, `git(dir, args)`. Rows: {repo, number, base, mergeCommit, files?, changed?}.
 */
export async function readSiblings({ candidates, bases, pr, git, deadline = Date.now() + DEADLINE_MS }) {
  const out = [];
  for (const c of candidates) {
    if (Date.now() > deadline) break;
    const b = bases.find((x) => x.base && x.tip && x.repo.toLowerCase() === c.repo);
    if (!b) continue;
    const p = await pr(c.repo, c.number).catch(() => undefined);
    const sha = typeof p?.merge_commit_sha === "string" ? p.merge_commit_sha : "";
    if (p?.merged !== true || !/^[0-9a-f]{40}$/.test(sha) || p.base?.ref !== b.base) continue;
    // On this base: GitHub's merge commit is an ancestor of the base the change targets.
    if (!(await git(b.dir, ["merge-base", "--is-ancestor", sha, b.tip]).then(() => true, () => false))) continue;
    const names = (from, to) => git(b.dir, ["diff", "--no-renames", "--name-only", from, to]).then((t) => t.split("\n").filter(Boolean), () => undefined);
    const files = await names(`${sha}^1`, sha);
    const since = await names(sha, b.tip);
    out.push({ repo: c.repo, number: c.number, base: b.base, mergeCommit: sha, ...(files ? { files } : {}), ...(files && since ? { changed: files.filter((f) => since.includes(f)) } : {}) });
  }
  return out;
}

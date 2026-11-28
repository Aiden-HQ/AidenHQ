// Code churn (docs/design/flow.md): how much of each merged PR's code is rewritten soon after it landed. A pure function over
// PRs' unified diffs in merge order: every line is tracked by identity (the PR that added it, and when) through later hunks and
// renames, so a line counts once: as added by its PR, and, when a later PR removes it inside the window, as rewritten. A hunk
// a PR removes in one place and adds in another unchanged is a move: the lines keep their owner and count as neither.
// Copied into the code host's service (scripts/sync-shared.ts); codehost-local calls it from the kernel.

/** The paths churn ignores. */
export const DEFAULT_CHURN_EXCLUDE = ["**/package-lock.json", "**/bun.lock", "**/dist/**", "**/vendor/**", "**/*.min.*"];
export type ChurnPr = { pr: string; mergedAt: string; diff: string };
export type Rewrite = { pr: string; by_pr: string; lines: number; days: number };

type Owner = { pr: string; at: number } | null;
type Cell = { text: string; owner: Owner };
const DAY = 86_400_000;
/** Shortest trimmed line a move may match on: `}` and `return;` appear everywhere and prove nothing. */
const MIN_MOVE = 8;

const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*")}$`);

type FileDiff = { from: string | null; to: string | null; hunks: { start: number; count: number; lines: { op: string; text: string }[] }[] };
/** A unified diff (git's, with renames) as per-file hunks; binary files and mode-only changes have none. */
function parse(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  const lines = diff.split("\n");
  let f: FileDiff | undefined;
  const strip = (p: string) => (p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, ""));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      out.push(f = { from: m?.[1] ?? null, to: m?.[2] ?? null, hunks: [] });
    } else if (f && l.startsWith("rename from ")) f.from = l.slice(12);
    else if (f && l.startsWith("rename to ")) f.to = l.slice(10);
    else if (f && l.startsWith("new file mode ")) f.from = null;
    else if (f && l.startsWith("deleted file mode ")) f.to = null;
    else if (f && l.startsWith("--- ") && !f.hunks.length) { if (l.slice(4) === "/dev/null") f.from = null; else f.from = strip(l.slice(4)); }
    else if (f && l.startsWith("+++ ") && !f.hunks.length) { if (l.slice(4) === "/dev/null") f.to = null; else f.to = strip(l.slice(4)); }
    else if (f && l.startsWith("@@ ")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
      if (!m) continue;
      let old = m[2] === undefined ? 1 : Number(m[2]), neu = m[3] === undefined ? 1 : Number(m[3]);
      const h = { start: Number(m[1]), count: old, lines: [] as { op: string; text: string }[] };
      // The counts say where the hunk ends, so a removed line that starts with `--` isn't a header.
      while ((old > 0 || neu > 0) && i + 1 < lines.length) {
        const t = lines[++i]!;
        const op = t[0] ?? " ";
        if (op === "\\") continue;
        if (op === "-") old--; else if (op === "+") neu--; else { old--; neu--; }
        h.lines.push({ op: op === "-" || op === "+" ? op : " ", text: t.slice(1) });
      }
      f.hunks.push(h);
    }
  }
  return out;
}

/**
 * Per-PR survival from `prs` in merge order. `opts.windowDays`: a removed line counts as rewritten when it was added at most
 * that many days earlier. `opts.exclude`: globs of paths ignored. `added[pr]`: lines the PR added that were not moves.
 * `rewritten`: per (pr, by_pr) the lines of `pr` that `by_pr` removed, and their mean age in whole days.
 */
export function churn(prs: ChurnPr[], opts: { windowDays: number; exclude: string[] }): { added: Record<string, number>; rewritten: Rewrite[] } {
  const skip = opts.exclude.map(globRe);
  const excluded = (p: string) => skip.some((r) => r.test(p));
  const files = new Map<string, Cell[]>();
  const added: Record<string, number> = {};
  const rewritten = new Map<string, Rewrite & { sum: number }>();
  for (const p of prs) {
    const at = Date.parse(p.mergedAt);
    const removed: Cell[] = [], fresh: Cell[] = [];
    for (const d of parse(p.diff)) {
      const path = d.to ?? d.from;
      if (!path) continue;
      if (excluded(path) || (d.from && excluded(d.from))) { if (d.from) files.delete(d.from); continue; }
      let cells = (d.from ? files.get(d.from) : undefined) ?? [];
      if (d.from) files.delete(d.from);
      let shift = 0;
      for (const h of d.hunks) {
        let i = (h.count === 0 ? h.start : h.start - 1) + shift;
        for (const l of h.lines) {
          if (l.op === " ") i++;
          else if (l.op === "-") {
            while (cells.length <= i) cells.push({ text: "", owner: null });
            removed.push(...cells.splice(i, 1));
            removed[removed.length - 1]!.text = l.text;
            shift--;
          } else {
            const c: Cell = { text: l.text, owner: { pr: p.pr, at } };
            cells.splice(Math.min(i, cells.length), 0, c);
            fresh.push(c);
            i++; shift++;
          }
        }
      }
      if (d.to) files.set(d.to, cells);
    }
    // Moves: an identical line removed and added by this one PR stays its first owner's.
    const gone = new Map<string, Cell[]>();
    for (const r of removed) { const k = r.text.trim(); if (k.length >= MIN_MOVE) (gone.get(k) ?? gone.set(k, []).get(k)!).push(r); }
    const moved = new Set<Cell>();
    for (const c of fresh) {
      const r = gone.get(c.text.trim())?.pop();
      if (!r) continue;
      c.owner = r.owner;
      moved.add(r); moved.add(c);
    }
    added[p.pr] = (added[p.pr] ?? 0) + fresh.filter((c) => !moved.has(c)).length;
    for (const r of removed) {
      if (moved.has(r) || !r.owner || r.owner.pr === p.pr) continue;
      const age = (at - r.owner.at) / DAY;
      if (age > opts.windowDays) continue;
      const k = `${r.owner.pr}|${p.pr}`;
      const e = rewritten.get(k) ?? rewritten.set(k, { pr: r.owner.pr, by_pr: p.pr, lines: 0, days: 0, sum: 0 }).get(k)!;
      e.lines++; e.sum += age;
    }
  }
  return { added, rewritten: [...rewritten.values()].map(({ sum, ...e }) => ({ ...e, days: Math.round(sum / e.lines) })) };
}

/**
 * Churn over a repo's first-parent history through `git` (args → stdout, run in the repo): each commit whose subject
 * names a PR (`prOf`) is one PR. With a `cursor` only the window before it is read again, so lines added just before it keep
 * their owner; `fresh` says which of the results are new since it. `last`: the newest commit's time, the next cursor.
 * `first`: without a cursor, only the newest that many commits (a first pass on the caller's own thread).
 */
export async function churnFromGit(git: (args: string[]) => Promise<string>, o: { rev: string; cursor?: string; first?: number; windowDays: number; exclude: string[]; prOf: (subject: string) => string | undefined; onError?: (commit: string, e: unknown) => void }) {
  const since = o.cursor ? [`--since=${new Date(Date.parse(o.cursor) - o.windowDays * DAY).toISOString()}`] : o.first ? [`--max-count=${o.first}`] : [];
  const log = await git(["log", "--first-parent", "--reverse", "--format=%H%x09%cI%x09%s", ...since, o.rev]);
  const prs: (ChurnPr & { commit: string })[] = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [commit, mergedAt, ...rest] = line.split("\t");
    const pr = o.prOf(rest.join("\t"));
    if (!pr) continue;
    const args = ["diff", "-M", "-U0", "--no-ext-diff", "--no-textconv"];
    const diff = await git([...args, `${commit}^1`, commit!]).catch(() => git([...args, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", commit!])).catch((e) => { o.onError?.(commit!, e); return ""; });
    prs.push({ pr, mergedAt: mergedAt!, diff, commit: commit! });
  }
  const out = churn(prs, { windowDays: o.windowDays, exclude: o.exclude });
  const fresh = (iso: string) => !o.cursor || Date.parse(iso) > Date.parse(o.cursor);
  return { ...out, mergedAt: new Map(prs.map((p) => [p.pr, p.mergedAt] as const)), fresh, last: prs.at(-1)?.mergedAt };
}

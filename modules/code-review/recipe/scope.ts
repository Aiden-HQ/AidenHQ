// Which files a review covers: the changed files of a change and the scope's decision on each. One definition for the PR check
// (review.ts) and an Engineer's own review before it publishes (self-review.ts), so both cover the same files.
import { posix } from "node:path";
import type { Excluded } from "./brief.ts";
import { globRe } from "./review-checklist.ts";

type Git = (args: string[]) => string;
export interface Changed { path: string; added: number; removed: number; binary: boolean }

// Excluded unless the reviewer's own globs say otherwise: lockfiles, generated code, build output, minified bundles (made, not
// written). Vendored code is reviewed: a repo that vendors third-party code ignores it with its own globs (owner-tier).
// Lockfiles: no findings asked for, never a coverage gap (they carry no code). Generated and bundled code: a gap when
// the change adds it (a place to hide code).
const LOCKS = ["**/package-lock.json", "**/npm-shrinkwrap.json", "**/*.lock", "**/*-lock.json", "**/*-lock.yaml", "**/go.sum", "**/bun.lockb"];
const GENERATED = ["**/generated/**", "**/__generated__/**", "**/node_modules/**", "**/dist/**", "**/*.min.js", "**/*.min.css", "**/*.map", "**/*.snap"];

/** The changed files from `from` to the head with their line counts: [{ path, added, removed, binary }]. */
export function changed(git: Git, from: string): Changed[] {
  const out = git(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", from, "HEAD"]);
  return out.split("\0").filter(Boolean).map((l) => {
    const [a, r, ...p] = l.split("\t");
    return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r), binary: a === "-" };
  });
}

/**
 * Which files a review reports on and which it leaves out, with why. Left out means "no findings there", never unread: the tools
 * still read and search them. `gap`: a left-out file the change could hide code in (a new file under a generated
 * path), so the review is incomplete and never reads as a clean pass. Size never leaves a file out. The repo's own ignore globs
 * (its config) and binary files are no gap. `added`: the paths this change adds.
 */
export function scope(files: Changed[], ignore: unknown[] = [], prChanged = new Set<string>()) {
  const mine = [...ignore].map(String).map(globRe), gen = GENERATED.map(globRe), locks = LOCKS.map(globRe);
  const reviewed: string[] = [], excluded: Excluded[] = [];
  for (const f of files) {
    // A change to how git reads files is always reviewed, whatever the globs say.
    const attrs = posix.basename(f.path) === ".gitattributes";
    const why = attrs ? undefined : f.binary ? "binary" : mine.some((re) => re.test(f.path)) ? "ignored" : locks.some((re) => re.test(f.path)) ? "lockfile" : gen.some((re) => re.test(f.path)) ? (prChanged.has(f.path) ? "generated, changed by this PR" : "generated") : undefined;
    ((why ? excluded : reviewed) as (Excluded | string)[]).push(why ? { path: f.path, why, gap: why === "generated, changed by this PR" } : f.path);
  }
  return { reviewed, excluded };
}


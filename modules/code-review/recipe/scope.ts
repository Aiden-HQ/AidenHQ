// Which files a review covers: the changed files of a change and the scope's decision on each. One definition for the PR check
// (review.ts) and an Engineer's own review before it publishes (self-review.ts), so both cover the same files.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type { Cleaned, Excluded, Placed } from "./brief.ts";
import { plain, readSmall } from "./proc.ts";
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


const GUIDES = ["REVIEW.md", "AGENTS.md", "CLAUDE.md"];
/** The guidance files that apply to `paths`: REVIEW.md, AGENTS.md and CLAUDE.md at the root and in every folder above one of them. */
export function guidePaths(paths: string[]) {
  const dirs = new Set(["."]);
  for (const p of paths) for (let d = posix.dirname(p); d !== "." && d !== "/"; d = posix.dirname(d)) dirs.add(d);
  return [...new Set([...dirs].sort().flatMap((d) => GUIDES.map((g) => (d === "." ? g : `${d}/${g}`))))];
}

/** The head file's lines for a tracked regular file the review read (never a link out of the tree), else undefined. */
function linesOf(root: string, path: string, reviewed: Set<string>) {
  if (!reviewed.has(path) && !existsSync(join(root, path))) return undefined;
  if (path.split("/").includes(".git") || !plain(root, path)) return undefined;
  const t = readSmall(join(root, path), 8 << 20);
  return t === undefined ? undefined : t.split("\n");
}


/**
 * Every finding at a real place (an existing file, a line in range) with its stable id: hash(path, title, the anchor line's
 * text). Any line of a file the pull request changes counts, old code as much as new; a finding in a file it doesn't change
 * (`own`: the PR's files the scope keeps) is a nit: GitHub gives it no thread to fix or answer on; one in a file the scope leaves
 * out (`left`) is dropped.
 */
export function place(findings: Cleaned[], root: string, reviewed: Set<string>, own: Set<string> = reviewed, left = new Set<string>()) {
  const out: Placed[] = [];
  for (const f of findings) {
    if (left.has(f.path)) continue; // a file the scope leaves out (ignored, generated, a lockfile): no findings asked for
    const lines = linesOf(root, f.path, reviewed);
    if (!lines || f.line > lines.length) continue;
    const severity = f.severity === "important" && !own.has(f.path) ? "nit" : f.severity;
    const anchor = lines[f.line - 1]!.trim();
    const id = createHash("sha256").update(`${f.path}\n${f.title.toLowerCase().replace(/\W+/g, " ").trim()}\n${anchor}`).digest("hex").slice(0, 16);
    out.push({ id, ...f, severity, ...(f.end_line && f.end_line > lines.length ? { end_line: lines.length } : {}) });
  }
  return out;
}


// Which files a review covers: the changed files of a change and the scope's decision on each. One definition for the PR check
// (review.ts) and an Engineer's own review before it publishes (self-review.ts), so both cover the same files.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type { Cleaned, Excluded, Placed } from "./brief.ts";
import { plain, readSmall } from "./proc.ts";
import { globRe } from "./review-checklist.ts";
import { GENERATED, LOCKS } from "./tiers.ts";

type Git = (args: string[]) => string;
export interface Changed { path: string; added: number; removed: number; binary: boolean }

// Excluded unless the reviewer's own globs say otherwise: lockfiles, generated code, build output, minified bundles (made, not
// written). Vendored code is reviewed: a repo that vendors third-party code ignores it with its own globs (owner-tier).
// Lockfiles: no findings asked for, never a coverage gap (they carry no code). Generated and bundled code: a gap when
// the change adds it (a place to hide code). Both lists are the risk tiers' (tiers.ts), their one definition.

/** The changed files from `from` to `to` (the head) with their line counts: [{ path, added, removed, binary }]. */
export function changed(git: Git, from: string, to = "HEAD"): Changed[] {
  const out = git(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--numstat", "-z", from, to]);
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
/** The tree entry of `path` at commit `at` (ls-tree's line), "" when there is none. */
function entryAt(root: string, at: string, path: string) {
  try { return execFileSync("git", ["ls-tree", "-z", at, "--", `:(literal)${path}`], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8"); } catch { return ""; }
}
/** A regular file's lines as commit `at` has it (never the work tree), else undefined. */
function linesAt(root: string, at: string, path: string) {
  try {
    if (!/^100(644|755) /.test(entryAt(root, at, path))) return undefined;
    return execFileSync("git", ["show", `${at}:${path}`], { cwd: root, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").split("\n");
  } catch { return undefined; }
}
function linesOf(root: string, path: string, reviewed: Set<string>, head?: string) {
  if (head) return linesAt(root, head, path); // the reviewed commit's file (the work tree may have moved on)
  if (!reviewed.has(path) && !existsSync(join(root, path))) return undefined;
  if (path.split("/").includes(".git") || !plain(root, path)) return undefined;
  const t = readSmall(join(root, path), 8 << 20);
  return t === undefined ? undefined : t.split("\n");
}


/**
 * Every finding at a real place (an existing file, a line in range) with its stable id: hash(path, title, the anchor line's
 * text). Any line of a file the pull request changes counts, old code as much as new; a finding in a file it doesn't change
 * (`own`: the PR's files the scope keeps) is a nit: GitHub gives it no thread to fix or answer on; one in a file the scope leaves
 * out (`left`) is dropped. `head`: read the files from that commit, not the work tree.
 */
export function place(findings: Cleaned[], root: string, reviewed: Set<string>, own: Set<string> = reviewed, left = new Set<string>(), head?: string) {
  const out: Placed[] = [];
  for (const f of findings) {
    if (left.has(f.path)) continue; // a file the scope leaves out (ignored, generated, a lockfile): no findings asked for
    const lines = linesOf(root, f.path, reviewed, head);
    // (A regular file at the commit that merely couldn't be read, too large say, is neither deleted nor a link: it is dropped below.)
    if (!lines && reviewed.has(f.path) && !(head && /^100(644|755) /.test(entryAt(root, head, f.path)))) {
      // A file in the change with nothing to read at the head (the change deletes it, or it is a link: never read through one): a
      // file-level finding, anchored at line 1 (the post needs a line) and labelled. A path outside the change stays dropped.
      const severity = f.severity === "important" && !own.has(f.path) ? "nit" : f.severity;
      const id = createHash("sha256").update(`${f.path}\n${f.title.toLowerCase().replace(/\W+/g, " ").trim()}\n`).digest("hex").slice(0, 16);
      const { end_line: _e, ...rest } = f;
      out.push({ id, ...rest, line: 1, why: `[on a file this change deletes or makes a link] ${f.why}`, severity });
      continue;
    }
    if (!lines || f.line > lines.length) continue;
    const severity = f.severity === "important" && !own.has(f.path) ? "nit" : f.severity;
    const anchor = lines[f.line - 1]!.trim();
    const id = createHash("sha256").update(`${f.path}\n${f.title.toLowerCase().replace(/\W+/g, " ").trim()}\n${anchor}`).digest("hex").slice(0, 16);
    out.push({ id, ...f, severity, ...(f.end_line && f.end_line > lines.length ? { end_line: lines.length } : {}) });
  }
  return out;
}


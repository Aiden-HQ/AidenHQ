// Approval (spec §5): the safe class, whether code review's pass carries to a later head, and the one judgement of whether the
// App may approve an adopted PR's head. Facts only, from code: no model reads anything here. The loop reads the PR's own change
// (GitHub's compare from its merge base) and code review's verdict only where approval is needed (GitHub's review rule, or code
// review gating the repo: decide's own rule), passes judge()'s answer to decide as ShipContext.approve (canApprove) and to
// round() as RoundFacts.approval; round() files github.approve and asks code review for a fresh review once per head.
import { posix } from "node:path";
import { LOCKFILES } from "./discover.ts";
import type { ShipSettings } from "./settings.ts";

/** One file of the PR's own change: GitHub's compare (merge base...head) `files` entry. */
export interface ChangedFile { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }
/** Code review's GET /v1/verdict at the head: `kind` and `reviewed` say what a pass stands on. */
export interface Verdict { verdict: "pass" | "wait"; reasons: { code: string; text: string }[]; reviewed?: string | null; kind?: "completed" | "exhausted" | "skipped" }
export type SafeClass = { safe: boolean; why: string; lines: number; files: number };
export type Judged = { ok: boolean; why: string; ask?: boolean; safe: SafeClass };

/** GitHub's compare lists at most 300 files: past that the change can't be read whole. */
const COMPARE_CAP = 300;
const TESTS = ["**/test/**", "**/tests/**", "**/__tests__/**", "**/testdata/**", "**/fixtures/**", "**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/test_*.py"];
const DOCS = ["**/*.md", "**/*.mdx", "**/*.rst", "**/docs/**", "**/LICENSE*", "**/CHANGELOG*"];
const MANIFESTS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml"];
const hit = (path: string, globs: string[]) => globs.some((g) => posix.matchesGlob(path, g));
const isGenerated = (f: ChangedFile, generated: string[]) => LOCKFILES.includes(posix.basename(f.filename)) || hit(f.filename, generated);
const names = (fs: ChangedFile[]) => `${fs.slice(0, 3).map((f) => `\`${f.filename}\``).join(", ")}${fs.length > 3 ? ` and ${fs.length - 3} more` : ""}`;

/**
 * The safe class: substantive lines and files (generated, lock, test and docs files not counted). Out of it when the change is over
 * `max_lines` or `max_files`, touches a `deny` glob (any file, counted or not), or changes generated files without any source.
 */
export function safeClass(files: ChangedFile[], s: ShipSettings["safe"], generated: string[]): SafeClass {
  const gen = files.filter((f) => isGenerated(f, generated));
  const counted = files.filter((f) => !gen.includes(f) && !hit(f.filename, TESTS) && !hit(f.filename, DOCS));
  const lines = counted.reduce((n, f) => n + f.additions + f.deletions, 0);
  const out = (why: string): SafeClass => ({ safe: false, why, lines, files: counted.length });
  if (files.length >= COMPARE_CAP) return out(`${files.length}+ changed files: GitHub doesn't list them all`);
  const denied = files.filter((f) => hit(f.filename, s.deny) || (f.previous_filename !== undefined && hit(f.previous_filename, s.deny)));
  if (denied.length) return out(`touches ${names(denied)} (safe.deny)`);
  // A lockfile's source is a manifest at or under its directory (a workspace member's too); any other generated file's is some
  // substantive change (its generator's input).
  const under = (dir: string, path: string) => dir === "." || path.startsWith(`${dir}/`);
  const manifest = (f: ChangedFile) => files.some((m) => MANIFESTS.includes(posix.basename(m.filename)) && under(posix.dirname(f.filename), m.filename));
  const orphan = gen.filter((f) => (LOCKFILES.includes(posix.basename(f.filename)) ? !manifest(f) : !counted.length));
  if (orphan.length) return out(`changes generated files (${names(orphan)}) without the source they come from`);
  if (s.max_lines !== null && lines > s.max_lines) return out(`${lines} lines > ${s.max_lines}`);
  if (s.max_files !== null && counted.length > s.max_files) return out(`${counted.length} files > ${s.max_files}`);
  return { safe: true, why: `${lines} lines in ${counted.length} files`, lines, files: counted.length };
}

/** The PR's own change without its generated paths: each file's status, names and patch, hunk positions included (code review's
 * patch-id rule: the same edit at another place is another change). null when a file has no patch (binary, too large) or the
 * list is cut. */
function fingerprint(files: ChangedFile[], generated: string[]): string | null {
  if (files.length >= COMPARE_CAP) return null;
  const own = files.filter((f) => !isGenerated(f, generated));
  if (own.some((f) => typeof f.patch !== "string")) return null;
  return own.map((f) => `${f.status}\0${f.previous_filename ?? ""}\0${f.filename}\0${f.patch}`).sort().join("\0\0");
}

/** Whether code review's pass on an earlier head carries to this one: the PR's own change is the same at both (a base merge, or
 * only generated paths regenerated). Anything unreadable is a change. */
export function carries(reviewed: ChangedFile[], head: ChangedFile[], generated: string[]): boolean {
  const a = fingerprint(reviewed, generated);
  return a !== null && a === fingerprint(head, generated);
}

/**
 * Whether the App may approve the head, with why (the report's line). It needs code review's pass on this head: completed there, or
 * an earlier head's (`reviewed`) whose change this head keeps (carries). A pass on an earlier head with a different change asks
 * for a fresh review (`ask`). `safe` (and `observe`, which reports what `safe` would do) also needs the safe class.
 * `reviewedFiles`: the PR's own change at the verdict's `reviewed` head, read only when the verdict isn't completed at this head.
 */
export function judge(s: ShipSettings, e: { files: ChangedFile[]; generated: string[]; verdict?: Verdict; reviewedFiles?: ChangedFile[] }): Judged {
  const safe = safeClass(e.files, s.safe, e.generated);
  const no = (why: string, ask?: boolean): Judged => ({ ok: false, why, safe, ...(ask ? { ask } : {}) });
  const v = e.verdict;
  if (!v) return no("code review doesn't gate this repo, so there is no review to approve on");
  if (v.verdict !== "pass") return no(`code review: ${String(v.reasons[0]?.text ?? "not passed").slice(0, 200)}`);
  if (v.kind === "skipped") return no("code review skipped its head");
  const carried = v.kind !== "completed";
  if (carried && !(v.reviewed && e.reviewedFiles && carries(e.reviewedFiles, e.files, e.generated))) {
    return no(`its change since code review's last full review${v.reviewed ? ` (\`${v.reviewed.slice(0, 12)}\`)` : ""} has no review of its own yet`, true);
  }
  if (s.approve !== "all" && !safe.safe) return no(`outside the safe class: ${safe.why}`);
  return { ok: true, why: carried ? `code review passed at \`${v.reviewed!.slice(0, 12)}\`, and its own change is the same here` : "code review passed on its head", safe };
}

/** decide's ShipContext.approve: the repo's `approve` lets the App approve, and the evidence holds. */
export const canApprove = (s: ShipSettings, j: Judged | undefined) => (s.approve === "safe" || s.approve === "all") && j?.ok === true;

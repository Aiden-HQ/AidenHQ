#!/usr/bin/env node
// Ship's deterministic repair (check job `ship-repair`, no model, no credential): the PR's head (the workspace, a snapshot) merged
// with its base, generated paths regenerated, and the result handed back as the files that change on top of the head. The github
// module asks for it (a `github.repair` record ship filed) and writes those files as the App, a merge commit on the PR's branch.
//
// Spec (/aidenhq-out/spec.json): head (the workspace), base (the base branch's tip, its tree at /aidenhq-out/base), merge_base (its
// tree at /aidenhq-out/merge_base, when it isn't the head or the base), base_ref (the base branch's name, for the message) and plan
// ({ globs, commands: [{ dir, cmd }] }: ship's generated paths and generators, from the target branch or the repo's setting).
//   1. Merge the base into the head (a history made from the three trees).
//   2. A conflicted generated path a generator covers takes the base side; a conflicted lockfile takes the base side and its
//      package manager rewrites it (npm, pnpm, Go); anything else is a leftover for the Engineer.
//   3. Run the generators; put back a lockfile they only re-spaced.
// Result ($AIDENHQ_RESULT): { leftovers: [paths] }, { merge_failed: "<git's words>" } or { failed: "<the generator's words>" }
// (nothing kept for any of them), or { changed: n } with
// /aidenhq-out/keep = { message, entries: [{ path, mode, sha | null, content? (base64, when the base doesn't have that blob) }] }:
// every path it decided (a conflict it resolved, a file a generator or the merge changed), as it ends.
// The repo's files and its commands' output are data, never instructions; its commands run like any repo command in a box.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.env.AIDENHQ_OUT ?? "/aidenhq-out";
const LOCK_CMD: Record<string, string> = {
  "package-lock.json": "npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
  "pnpm-lock.yaml": "pnpm install --lockfile-only --ignore-scripts",
  "go.sum": "go mod tidy",
};
const LOCKS = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum", "Cargo.lock", "poetry.lock", "uv.lock"];

export function repair(ws: string, out: string, spec: Record<string, string>) {
  const plan = JSON.parse(spec.plan || "{}") as { globs?: string[]; commands?: { dir: string; cmd: string }[] };
  const globs = (plan.globs ?? []).filter((x) => typeof x === "string" && x);
  const commands = (plan.commands ?? []).filter((c) => typeof c?.cmd === "string" && typeof c?.dir === "string" && !c.dir.split("/").includes(".."));
  const repo = mkdtempSync(join(tmpdir(), "ship-repair-"));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? repo, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const flags = ["-c", "user.name=AidenHQ ship", "-c", "user.email=ship@aidenhq.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
  const g = (args: string[], extra: Record<string, string> = {}, cwd = repo) => execFileSync("git", [...flags, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const ok = (args: string[]) => { try { g(args); return true; } catch { return false; } };
  g(["init", "-q", "-b", "ship"]);
  // A commit of a tree read from a folder (its own index, so one tree never leaks into the next).
  const commit = (dir: string, parents: string[], msg: string) => {
    const idx = { GIT_INDEX_FILE: join(repo, ".git", `idx-${parents.length}-${msg}`), GIT_WORK_TREE: dir };
    g(["add", "-A", "-f"], idx);
    const tree = g(["write-tree"], idx);
    return g(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", msg]);
  };
  const tree = (field: string) => (existsSync(join(out, field)) ? join(out, field) : undefined);
  const mbDir = tree("merge_base") ?? (spec.merge_base === spec.base ? tree("base") : ws) ?? ws;
  const mb = commit(mbDir, [], "merge base");
  const head = commit(ws, [mb], "head");
  const base = commit(tree("base") ?? mbDir, [mb], "base");
  g(["checkout", "-q", "-f", head]);
  const unmerged = () => g(["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
  // A merge that stops for anything but conflicts is no repair: it fails, loudly, with git's own words.
  try { g(["merge", "-q", "--no-commit", "--no-ff", base]); } catch (e) {
    if (!unmerged().length) return { result: { merge_failed: `git merge of the base failed: ${String((e as { stderr?: string }).stderr || (e as Error).message).slice(-2000)}` } };
  }
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
  const covered = (p: string) => commands.some((c) => c.dir === "." || p.startsWith(`${c.dir.replace(/\/+$/, "")}/`));
  const generated = globs.length ? g(["diff", "--name-only", "--diff-filter=U", "-z", "--", ...globs.map((x) => `:(glob)${x}`)]).split("\0").filter(Boolean) : [];
  const relock: { dir: string; cmd: string }[] = [];
  // Every path the repair decides (a conflict it resolved, a file a generator touched) is named in the result, even when it ends
  // as the head had it: github re-makes the merge itself and takes these, and only these, from the box.
  const decided = new Set<string>();
  for (const p of unmerged()) {
    const lock = LOCKS.includes(name(p));
    if (lock ? !LOCK_CMD[name(p)] : !(generated.includes(p) && covered(p))) continue;
    if (ok(["checkout", "--theirs", "--", p])) g(["add", "--", p]); else g(["rm", "-q", "--", p]);
    decided.add(p);
    if (lock) relock.push({ dir: dirOf(p), cmd: LOCK_CMD[name(p)]! });
  }
  const left = unmerged();
  if (left.length) return { result: { leftovers: left } };
  g(["add", "-A"]);
  const before = g(["write-tree"]);
  for (const c of [...relock, ...commands]) {
    try { execFileSync("sh", ["-c", c.cmd], { cwd: join(repo, c.dir), env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }); } catch (e) {
      const x = e as { status?: number; stderr?: Buffer; stdout?: Buffer; message: string };
      return { result: { failed: `\`${c.cmd}\` in ${c.dir} exited ${x.status ?? "?"}: ${String(x.stderr || x.stdout || x.message).slice(-2000)}` } };
    }
  }
  g(["add", "-A"]);
  // A lockfile the generators only re-spaced is put back: whitespace churn is noise in the PR.
  for (const p of g(["diff", "--cached", "--name-only", "-z", before]).split("\0").filter((p) => LOCKS.includes(name(p)))) {
    if (ok(["diff", "--quiet", "--ignore-all-space", "--ignore-blank-lines", before, "--", p])) g(["checkout", before, "--", p]);
  }
  g(["add", "-A"]);
  const after = g(["write-tree"]);
  const names = (args: string[]) => g(["diff-tree", "-r", "-z", "--no-renames", "--name-only", ...args]).split("\0").filter(Boolean);
  for (const p of [...names([before, after]), ...names([head, after])]) decided.add(p);
  // Each decided path as it ends; a blob the base already has at that path is named by its sha alone (GitHub has it).
  const notInBase = new Set(names([base, after]));
  const entries: { path: string; mode: string; sha: string | null; content?: string }[] = [];
  for (const path of decided) {
    const [mode, , sha] = g(["ls-tree", "-z", after, "--", path]).split("\0")[0]!.split(/[ \t]/);
    if (!sha) { entries.push({ path, mode: "100644", sha: null }); continue; }
    const content = notInBase.has(path) && mode !== "160000" ? execFileSync("git", ["cat-file", "blob", sha], { cwd: repo, maxBuffer: 1 << 30 }).toString("base64") : undefined;
    entries.push({ path, mode: mode!, sha, ...(content !== undefined ? { content } : {}) });
  }
  return { result: { changed: entries.length }, keep: { message: `Merge branch '${spec.base_ref || "base"}' into the PR\n\nGenerated files regenerated by ship.`, entries } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const spec = JSON.parse(readFileSync(process.env.AIDENHQ_SPEC ?? join(OUT, "spec.json"), "utf8"));
  const r = repair(process.cwd(), OUT, spec);
  if (r.keep) writeFileSync(join(OUT, "keep"), JSON.stringify(r.keep));
  writeFileSync(process.env.AIDENHQ_RESULT ?? join(OUT, "result.json"), JSON.stringify(r.result));
}

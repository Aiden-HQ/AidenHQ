#!/usr/bin/env node
// Ship's deterministic repair (check job `ship-repair`, no model, no credential): the PR's head (the workspace, a snapshot) merged
// with its base, generated paths regenerated, and the result handed back as the files that change on top of the head. The github
// module asks for it (a `github.repair` record ship filed) and writes those files as the App, a merge commit on the PR's branch.
//
// Spec (/aidenhq-out/spec.json): head (the workspace), base (the base branch's tip, its tree at /aidenhq-out/base), merge_base (its
// tree at /aidenhq-out/merge_base, when it isn't the head or the base), base_ref (the base branch's name, for the message) and plan
// ({ globs, commands: [{ dir, cmd }], ci_regenerates? }: ship's generated paths and generators, from the target branch or the repo's
// setting; `ci_regenerates`: the repo's own CI regenerates those paths, so no generator runs for them).
//   1. Merge the base into the head (a history made from the three trees).
//   2. A conflicted generated path a generator covers (any, when the repo's CI regenerates) takes the base side; a conflicted lockfile takes the base side and its
//      package manager rewrites it (npm, pnpm); a conflicted go.sum keeps both sides' lines, sorted (go.mod is never rewritten:
//      `go mod tidy` would); anything else is a leftover for the Engineer.
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
};
const LOCKS = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum", "Cargo.lock", "poetry.lock", "uv.lock"];
/** A failed command's words as github keeps them (its outcome holds 2,000 characters after its own prefix): the command, then the
 * tail of stderr (where the error is) and of stdout, each within its own budget. */
const STDERR_TAIL = 1000, STDOUT_TAIL = 500, CMD_SHOWN = 200;
export function failedText(cmd: string, dir: string, status: number | string, stderr: string, stdout: string, tool?: string): string {
  const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);
  const parts = [stderr.trim() && `stderr:\n${tail(stderr.trim(), STDERR_TAIL)}`, stdout.trim() && `stdout:\n${tail(stdout.trim(), STDOUT_TAIL)}`].filter(Boolean);
  return `${tool ? `toolchain missing: ${tool}\n` : ""}\`${tail(cmd, CMD_SHOWN)}\` in ${dir.slice(0, 100)} exited ${status}:\n${parts.join("\n") || "(no output)"}`;
}

/** The tool a command's output says is missing, from the shell's or a launcher's own words only: `sh: 1: webrpc-gen: not found`,
 * `bash: buf: command not found`, a script's `./gen.sh: 2: protoc: not found`, `make: oapi-codegen: No such file or directory`, `env: 'x': No such file or directory`, or
 * Go's `exec: "protoc": executable file not found in $PATH`. */
export function missingTool(out: string): string | undefined {
  const m = /exec: "([\w.+-]{1,60})": executable file not found/.exec(out)
    ?? /^(?:\/bin\/)?(?:sh|bash|dash|zsh)(?:: line \d+:|: \d+:|:) ([\w.+-]{1,60}): (?:command )?not found$/m.exec(out)
    ?? /^\S+: (?:line )?\d+: ([\w.+-]{1,60}): (?:command )?not found$/m.exec(out)
    ?? /^make(?:\[\d+\])?: ([\w.+-]{1,60}): No such file or directory$/m.exec(out)
    ?? /^env: '?([\w.+-]{1,60})'?: No such file or directory$/m.exec(out);
  return m?.[1];
}

/** go.sum's own line order (golang.org/x/mod module.Sort): module path, then semantic version, a `/go.mod` line after its version's. */
export function goSumOrder(a: string, b: string): number {
  const key = (l: string) => { const [path = "", v = ""] = l.split(" "); return { path, gomod: v.endsWith("/go.mod"), ver: v.replace(/\/go\.mod$/, "").replace(/^v/, "").replace(/\+.*$/, "") }; };
  const x = key(a), y = key(b);
  if (x.path !== y.path) return x.path < y.path ? -1 : 1;
  const [xc = "", xp] = x.ver.split(/-(.*)/s), [yc = "", yp] = y.ver.split(/-(.*)/s);
  const xn = xc.split(".").map(Number), yn = yc.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((xn[i] ?? 0) !== (yn[i] ?? 0)) return (xn[i] ?? 0) < (yn[i] ?? 0) ? -1 : 1;
  if (xp !== yp) {
    if (xp === undefined || yp === undefined) return xp === undefined ? 1 : -1; // a release sorts after its prereleases
    const xi = xp.split("."), yi = yp.split(".");
    for (let i = 0; i < Math.max(xi.length, yi.length); i++) {
      const m = xi[i], n = yi[i];
      if (m === undefined || n === undefined) return m === undefined ? -1 : 1;
      if (m === n) continue;
      const mn = /^\d+$/.test(m), nn = /^\d+$/.test(n);
      if (mn && nn) return Number(m) < Number(n) ? -1 : 1;
      if (mn !== nn) return mn ? -1 : 1;
      return m < n ? -1 : 1;
    }
  }
  return x.gomod === y.gomod ? 0 : x.gomod ? 1 : -1;
}

export function repair(ws: string, out: string, spec: Record<string, string>) {
  const plan = JSON.parse(spec.plan || "{}") as { globs?: string[]; commands?: { dir: string; cmd: string }[]; ci_regenerates?: boolean };
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
  const relock: { dir: string; cmd: string; path: string }[] = [];
  // Every path the repair decides (a conflict it resolved, a file a generator touched) is named in the result, even when it ends
  // as the head had it: github re-makes the merge itself and takes these, and only these, from the box.
  const decided = new Set<string>();
  const side = (n: number, p: string) => { try { return g(["show", `:${n}:${p}`]).split("\n"); } catch { return []; } };
  for (const p of unmerged()) {
    // The repo's CI regenerates the generated paths, lockfiles its globs name included: the base side stands, nothing runs.
    if (plan.ci_regenerates === true && generated.includes(p)) {
      if (ok(["checkout", "--theirs", "--", p])) g(["add", "--", p]); else g(["rm", "-q", "--", p]);
      decided.add(p);
      continue;
    }
    if (name(p) === "go.sum") {
      // Every line of go.sum is a checksum that stays valid: both sides' lines together are the merge (a stale one is harmless).
      writeFileSync(join(repo, p), `${[...new Set([...side(2, p), ...side(3, p)].filter(Boolean))].sort(goSumOrder).join("\n")}\n`);
      g(["add", "--", p]);
      decided.add(p);
      continue;
    }
    const lock = LOCKS.includes(name(p));
    if (lock ? !LOCK_CMD[name(p)] : !(generated.includes(p) && covered(p))) continue;
    if (ok(["checkout", "--theirs", "--", p])) g(["add", "--", p]); else g(["rm", "-q", "--", p]);
    decided.add(p);
    if (lock) relock.push({ dir: dirOf(p), cmd: LOCK_CMD[name(p)]!, path: p });
  }
  const left = unmerged();
  if (left.length) return { result: { leftovers: left } };
  g(["add", "-A"]);
  const before = g(["write-tree"]);
  for (const c of [...relock, ...commands]) {
    try { execFileSync("sh", ["-c", c.cmd], { cwd: join(repo, c.dir), env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }); } catch (e) {
      const x = e as { status?: number; stderr?: Buffer; stdout?: Buffer; message: string };
      const stderr = String(x.stderr ?? ""), stdout = String(x.stdout ?? "");
      // A tool this box doesn't have (the shell's "not found", Go's exec error, or exit 127), read from the whole output: said
      // first, plainly, so ship can suggest the repo's own workflow instead.
      const tool = missingTool(`${stderr}\n${stdout}`) ?? (x.status === 127 ? c.cmd.trim().split(/\s+/)[0] : undefined);
      return { result: { failed: failedText(c.cmd, c.dir, x.status ?? "?", stderr || (stdout ? "" : x.message), stdout, tool) } };
    }
  }
  g(["add", "-A"]);
  // A lockfile the generators changed is put back unless it conflicted (github takes a lockfile only then), and so is one they
  // only re-spaced: whitespace churn is noise in the PR.
  const relocked = new Set(relock.map((r) => r.path));
  for (const p of g(["diff", "--cached", "--name-only", "-z", before]).split("\0").filter((p) => LOCKS.includes(name(p)))) {
    if (!relocked.has(p) || ok(["diff", "--quiet", "--ignore-all-space", "--ignore-blank-lines", before, "--", p])) g(["checkout", before, "--", p]);
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

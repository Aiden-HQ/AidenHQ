// Ship's repair check job (recipe/repair.ts) on snapshots as the kernel lays them: the head as the workspace, the base and the
// merge base as trees in the out folder. Generated conflicts are regenerated, a conflicted lockfile is rewritten by its package
// manager, a whitespace-only lockfile change is put back, and a source conflict is left over with nothing kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { goSumOrder, repair } from "../recipe/repair.ts";

test("ship-repair: generated conflicts regenerated into the files on top of the head; a source conflict is left over", () => {
  const root = mkdtempSync(join(tmpdir(), "ship-recipe-"));
  const origin = join(root, "origin");
  const git = (...a: string[]) => execFileSync("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  const put = (p: string, text: string) => { mkdirSync(dirname(join(origin, p)), { recursive: true }); writeFileSync(join(origin, p), text); };
  const regen = () => execFileSync("sh", ["-c", "cat src/*.txt > gen/out.txt"], { cwd: origin });
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  put(".gitattributes", "gen/** linguist-generated\n");
  put("src/a.txt", "a\n");
  put("lock/package-lock.json", '{\n  "lockfileVersion": 3\n}\n');
  mkdirSync(join(origin, "gen"));
  regen();
  git("add", "-A"); git("commit", "-qm", "init");
  const mb = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature"); put("src/b.txt", "b\n"); regen(); git("add", "-A"); git("commit", "-qm", "b");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-qb", "clash", "main"); put("src/a.txt", "a from the PR\n"); regen(); git("add", "-A"); git("commit", "-qm", "a");
  const clash = git("rev-parse", "HEAD");
  git("checkout", "-q", "main"); put("src/a.txt", "a2\n"); regen(); git("add", "-A"); git("commit", "-qm", "a2");
  const base = git("rev-parse", "HEAD");
  // The kernel's layout: a snapshot is the commit's tree, no .git.
  const snap = (sha: string, dir: string) => { mkdirSync(dir, { recursive: true }); execFileSync("sh", ["-c", `git -C "${origin}" archive ${sha} | tar -x -C "${dir}"`]); return dir; };
  const run = (h: string, plan: unknown) => {
    const out = mkdtempSync(join(root, "out-"));
    snap(base, join(out, "base"));
    snap(mb, join(out, "merge_base"));
    return repair(snap(h, mkdtempSync(join(root, "ws-"))), out, { base, merge_base: mb, base_ref: "main", plan: JSON.stringify(plan) });
  };
  // The generator also re-indents the lockfile: whitespace only, so it is put back.
  const GEN = "cat src/*.txt > gen/out.txt && node -e \"const f='lock/package-lock.json';require('fs').writeFileSync(f, JSON.stringify(JSON.parse(require('fs').readFileSync(f,'utf8')), null, 4))\"";
  const r = run(head, { globs: ["gen/**", "**/package-lock.json"], commands: [{ dir: ".", cmd: GEN }] });
  assert.deepEqual(r.result, { changed: 2 });
  const byPath = Object.fromEntries(r.keep!.entries.map((e) => [e.path, e]));
  assert.deepEqual(Object.keys(byPath).sort(), ["gen/out.txt", "src/a.txt"]);
  assert.equal(Buffer.from(byPath["gen/out.txt"]!.content!, "base64").toString(), "a2\nb\n");
  assert.equal(byPath["src/a.txt"]!.content, undefined, "a blob the base has is named by its sha alone");
  assert.equal(byPath["src/a.txt"]!.sha, git("rev-parse", `${base}:src/a.txt`));
  assert.match(r.keep!.message, /^Merge branch 'main'/);

  // No generator: the generated conflict is the Engineer's too. A source conflict is always.
  assert.deepEqual(run(head, { globs: ["gen/**"], commands: [] }).result, { leftovers: ["gen/out.txt"] });
  // The repo's CI regenerates them: the base side is taken and nothing runs.
  const ci = run(head, { globs: ["gen/**"], commands: [], ci_regenerates: true });
  const gen = ci.keep!.entries.find((e) => e.path === "gen/out.txt");
  assert.equal(gen?.sha, git("rev-parse", `${base}:gen/out.txt`), "the base's own blob");

  assert.deepEqual(run(clash, { globs: ["gen/**"], commands: [{ dir: ".", cmd: "cat src/*.txt > gen/out.txt" }] }).result, { leftovers: ["src/a.txt"] });
  // A failed generator stops it, with the command's own words.
  assert.match(String((run(head, { globs: ["gen/**"], commands: [{ dir: ".", cmd: "echo broken >&2; exit 3" }] }).result as any).failed), /exited 3:\nstderr:\nbroken$/);
  // A long stdout never pushes the error out: stderr and stdout each keep their own tail, together within github's 2,000.
  const loud = String((run(head, { globs: ["gen/**"], commands: [{ dir: ".", cmd: "yes progress | head -c 50000; echo the real error >&2; exit 2" }] }).result as any).failed);
  assert.match(loud, /stderr:\nthe real error\nstdout:\n…/);
  assert.ok(loud.length < 2000, String(loud.length));
  // A tool the box doesn't have is said first, plainly (ship holds and suggests the repo's own workflow).
  assert.match(String((run(head, { globs: ["gen/**"], commands: [{ dir: ".", cmd: "webrpc-gen-not-here -schema x.ridl" }] }).result as any).failed), /^toolchain missing: webrpc-gen-not-here\n/);
});

test("ship-repair: a conflicted go.sum keeps both sides' lines and no command runs (go.mod stays as merged)", () => {
  const root = mkdtempSync(join(tmpdir(), "ship-gosum-"));
  const origin = join(root, "origin");
  const git = (...a: string[]) => execFileSync("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "go.sum"), "a v1 h1:a\n");
  git("add", "-A"); git("commit", "-qm", "init");
  const mb = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature"); writeFileSync(join(origin, "go.sum"), "a v1 h1:a\nb v1 h1:b\n"); git("commit", "-qam", "b");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main"); writeFileSync(join(origin, "go.sum"), "a v1 h1:a\nc v1 h1:c\n"); git("commit", "-qam", "c");
  const base = git("rev-parse", "HEAD");
  const snap = (sha: string, dir: string) => { mkdirSync(dir, { recursive: true }); execFileSync("sh", ["-c", `git -C "${origin}" archive ${sha} | tar -x -C "${dir}"`]); return dir; };
  const out = mkdtempSync(join(root, "out-"));
  snap(base, join(out, "base")); snap(mb, join(out, "merge_base"));
  const r = repair(snap(head, mkdtempSync(join(root, "ws-"))), out, { base, merge_base: mb, base_ref: "main", plan: "{}" });
  assert.deepEqual(r.result, { changed: 1 });
  assert.equal(Buffer.from(r.keep!.entries[0]!.content!, "base64").toString(), "a v1 h1:a\nb v1 h1:b\nc v1 h1:c\n");
});

test("ship-repair, the repo's CI regenerating: a conflicted lockfile its globs name takes the base's blob and no package manager runs", () => {
  const root = mkdtempSync(join(tmpdir(), "ship-cilock-"));
  const origin = join(root, "origin");
  const git = (...a: string[]) => execFileSync("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "package-lock.json"), '{ "v": 0 }\n');
  git("add", "-A"); git("commit", "-qm", "init");
  const mb = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature"); writeFileSync(join(origin, "package-lock.json"), '{ "v": "head" }\n'); git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main"); writeFileSync(join(origin, "package-lock.json"), '{ "v": "base" }\n'); git("commit", "-qam", "base");
  const base = git("rev-parse", "HEAD");
  const snap = (sha: string, dir: string) => { mkdirSync(dir, { recursive: true }); execFileSync("sh", ["-c", `git -C "${origin}" archive ${sha} | tar -x -C "${dir}"`]); return dir; };
  const out = mkdtempSync(join(root, "out-"));
  snap(base, join(out, "base")); snap(mb, join(out, "merge_base"));
  // No package.json: an npm run here would fail the repair.
  const r = repair(snap(head, mkdtempSync(join(root, "ws-"))), out, { base, merge_base: mb, base_ref: "main", plan: JSON.stringify({ globs: ["**/package-lock.json"], commands: [], ci_regenerates: true }) });
  assert.deepEqual(r.result, { changed: 1 });
  assert.equal(r.keep!.entries[0]!.sha, git("rev-parse", `${base}:package-lock.json`));
});

test("go.sum order: path, then semantic version, /go.mod after its version", () => {
  const lines = ["b v1.0.0/go.mod h1:x", "a v1.10.0 h1:x", "a v1.9.0 h1:x", "b v1.0.0 h1:x", "a v1.9.0-rc.1 h1:x", "a v1.9.0/go.mod h1:x"];
  assert.deepEqual(lines.sort(goSumOrder), ["a v1.9.0-rc.1 h1:x", "a v1.9.0 h1:x", "a v1.9.0/go.mod h1:x", "a v1.10.0 h1:x", "b v1.0.0 h1:x", "b v1.0.0/go.mod h1:x"]);
});

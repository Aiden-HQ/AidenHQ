// Ship's repair check job (recipe/repair.ts) on snapshots as the kernel lays them: the head as the workspace, the base and the
// merge base as trees in the out folder. Generated conflicts are regenerated, a conflicted lockfile is rewritten by its package
// manager, a whitespace-only lockfile change is put back, and a source conflict is left over with nothing kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repair } from "../recipe/repair.ts";

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
  assert.deepEqual(run(clash, { globs: ["gen/**"], commands: [{ dir: ".", cmd: "cat src/*.txt > gen/out.txt" }] }).result, { leftovers: ["src/a.txt"] });
  // A failed generator stops it, with the command's own words.
  assert.match(String((run(head, { globs: ["gen/**"], commands: [{ dir: ".", cmd: "echo broken >&2; exit 3" }] }).result as any).failed), /exited 3: broken/);
  // A tool the box doesn't have is said first, plainly (ship holds and suggests the repo's own workflow).
  assert.match(String((run(head, { globs: ["gen/**"], commands: [{ dir: ".", cmd: "webrpc-gen-not-here -schema x.ridl" }] }).result as any).failed), /^toolchain missing: webrpc-gen-not-here\n/);
});

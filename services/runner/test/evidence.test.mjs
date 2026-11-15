// The duplicate-card guard's check (evidence.ts onMain): a change already on the target's main, by ancestry or identical
// files, is satisfied; a real change is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardBranch, onMain } from "../src/evidence.ts";
import { git } from "../src/git.mjs";

test("already on main by ancestry or identical files; a real change is not", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).toString().trim();
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  run(dir, "init", "-q", "--bare", "-b", "main", origin);
  run(dir, "clone", "-q", origin, work);
  const commit = (file, text, msg) => (writeFileSync(join(work, file), text), run(work, "add", file), run(work, "commit", "-qm", msg), run(work, "rev-parse", "HEAD"));
  commit("a.txt", "a\n", "init");
  run(work, "push", "-q", "origin", "main");
  // A branch whose file later lands on main by another route (a different commit, same content).
  run(work, "switch", "-qc", "dup");
  const dup = commit("b.txt", "b\n", "feat: b");
  run(work, "switch", "-qc", "real", "main");
  const real = commit("c.txt", "c\n", "feat: c");
  run(work, "switch", "-qc", "odd", "main");
  const odd = commit("café [x].txt", "new\n", "feat: an unusual name");
  run(work, "switch", "-q", "main");
  const landed = commit("b.txt", "b\n", "feat: b, by hand");
  run(work, "push", "-q", "origin", "main");
  run(work, "fetch", "-q", "origin");

  const dupOn = await onMain(git, work, "main", dup);
  assert.equal(dupOn.satisfied, true);
  assert.match(dupOn.evidence, /b\.txt.*identical on `main`/);
  assert.match((await onMain(git, work, "main", landed)).evidence, /already on `main`/);
  assert.deepEqual(await onMain(git, work, "main", real), { satisfied: false });
  assert.deepEqual(await onMain(git, work, "main", odd), { satisfied: false }, "an unusual file name is compared, not skipped");
  assert.deepEqual(await onMain(git, work, "nope", real), { satisfied: false }, "an unreadable target is never satisfied");

  // A branch with no commits of its own (its tip is main's, so trivially an ancestor) is never already applied.
  const empty = { path: work, defaultBase: "main", unpublished: [], stat: "" };
  assert.equal((await onMain(git, work, "main", landed)).satisfied, true);
  assert.deepEqual(await guardBranch(git, empty, landed), { satisfied: false });
  assert.equal((await guardBranch(git, { ...empty, stat: " 1 file changed" }, dup)).satisfied, true, "a branch with its own commits is checked");

  // The same change squash-merged as another PR, after which main moved on in that file: the patch is already merged.
  run(work, "switch", "-qc", "again", "main");
  const again = commit("c.txt", "c2\n", "feat: c2 (a repeat of a merged PR)");
  run(work, "switch", "-q", "main");
  const squash = commit("c.txt", "c2\n", "feat: c2 (#45)");
  commit("c.txt", "c3\n", "later: c3");
  run(work, "push", "-q", "origin", "main");
  run(work, "fetch", "-q", "origin");
  const repeat = await onMain(git, work, "main", again);
  assert.equal(repeat.satisfied, true, "the same patch, merged as another commit");
  assert.match(repeat.evidence, new RegExp(`already merged on \`main\` as \`${squash.slice(0, 12)}\``));
  run(work, "switch", "-qc", "other", squash);
  const other = commit("c.txt", "c9\n", "feat: something else in the same file");
  assert.deepEqual(await onMain(git, work, "main", other), { satisfied: false }, "another change to the same file");
});

test("an apply is never guarded: the instance's main can be ahead of what the host runs", () => {
  const main = readFileSync(join(import.meta.dirname, "../src/main.mjs"), "utf8");
  const start = main.indexOf("async function showFleetDiff");
  assert.ok(start > 0);
  assert.doesNotMatch(main.slice(start, main.indexOf("\n}\n", start)), /onMain|guardBranch|dupGuardOn|ALREADY_APPLIED/);
});

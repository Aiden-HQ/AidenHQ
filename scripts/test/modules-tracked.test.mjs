// scripts/modules-repo/tracked.mjs: a product checkout that tracks a file under modules/ keeps it when the official tree
// replaces the directory, so the apply's "no changes to tracked files" check doesn't stop every later run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restoreTracked } from "../modules-repo/tracked.mjs";

const git = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
const dirty = (dir) => git(dir, "status", "--porcelain", "--untracked-files=no");

/** A product checkout with modules/ gitignored, as this one is, and (optionally) one tracked file under it. */
function checkout(tracked) {
  const dir = mkdtempSync(join(tmpdir(), "modules-tracked-"));
  writeFileSync(join(dir, ".gitignore"), "/modules/\n");
  writeFileSync(join(dir, "modules-pin.json"), "{}\n");
  if (tracked) {
    mkdirSync(join(dir, "modules/security/scanner/test"), { recursive: true });
    writeFileSync(join(dir, "modules/security/scanner/test/host-scope.test.ts"), "the product's own test\n");
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  if (tracked) git(dir, "add", "-f", "modules");
  git(dir, "commit", "-qm", "c");
  return dir;
}

/** The materialise's swap: the fetched tree replaces modules/ whole, then the tracked files come back. */
const materialise = (dir) => {
  if (existsSync(join(dir, "modules"))) renameSync(join(dir, "modules"), join(dir, "modules.old"));
  mkdirSync(join(dir, "modules/security/scanner/test"), { recursive: true });
  writeFileSync(join(dir, "modules/security/scanner/test/scan.test.ts"), "the official tree's own test\n");
  if (existsSync(join(dir, "modules.old"))) rmSync(join(dir, "modules.old"), { recursive: true });
  restoreTracked(dir);
};

test("a file the product tracks under modules/ survives the swap, so the checkout stays clean", () => {
  const dir = checkout(true);
  materialise(dir);
  assert.equal(dirty(dir), "", "no tracked deletion for the apply to refuse over");
  assert.equal(readFileSync(join(dir, "modules/security/scanner/test/host-scope.test.ts"), "utf8"), "the product's own test\n");
  assert.ok(existsSync(join(dir, "modules/security/scanner/test/scan.test.ts")), "the official tree is still there");
});

test("a tracked file still there is never overwritten, so a local edit under modules/ is not discarded", () => {
  const dir = checkout(true);
  const file = join(dir, "modules/security/scanner/test/host-scope.test.ts");
  writeFileSync(file, "an edit\n");
  restoreTracked(dir);
  assert.equal(readFileSync(file, "utf8"), "an edit\n");
});

test("a checkout that tracks nothing under modules/ is left alone, and so is one that isn't a git checkout", () => {
  const plain = checkout(false);
  materialise(plain);
  assert.equal(dirty(plain), "");
  const notGit = mkdtempSync(join(tmpdir(), "modules-tracked-"));
  restoreTracked(notGit); // setup runs this before the instance checkout exists
});

test("a symlink the materialised tree holds is never written through: the blob can't land outside the checkout", () => {
  const dir = checkout(true);
  const outside = mkdtempSync(join(tmpdir(), "modules-outside-"));
  // The official tree arrives with modules/security/scanner a link to a directory outside the product checkout.
  renameSync(join(dir, "modules"), join(dir, "modules.old"));
  mkdirSync(join(dir, "modules"), { recursive: true });
  symlinkSync(outside, join(dir, "modules/security"));
  restoreTracked(dir);
  assert.equal(lstatSync(join(dir, "modules/security")).isSymbolicLink(), true, "the link is left as it is");
  assert.equal(existsSync(join(outside, "scanner/test/host-scope.test.ts")), false, "nothing was written outside the checkout");
  assert.deepEqual(readdirSync(outside), [], "the destination directory is untouched");
});

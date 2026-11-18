// The CI template's Tier 0 evidence (main.mjs ciTemplateCopy → git.mjs treeIs): a commit's `.github/` counts as the
// template only when it is the same git tree, so any extra workflow, symlink, mode change or edited byte fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { patchKey, treeIs } from "../../../modules/codehost-github/src/git.mjs";

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();
const files = { "workflows/ci.yml": "on: push\njobs: {}\n", "dependabot.yml": "version: 2\n", "supply-chain/pins.mjs": "export {};\n" };

function repo(edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-template-"));
  g(dir, "init", "-q");
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, ".github", f)), { recursive: true });
    writeFileSync(join(dir, ".github", f), text);
  }
  writeFileSync(join(dir, "app.js"), "1\n");
  edit(dir);
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "c");
  return dir;
}

test("a .github tree is the template's only when it is the same tree", async () => {
  const template = repo();
  const want = g(template, "rev-parse", "HEAD:.github");
  const is = async (edit) => {
    const dir = repo(edit);
    try {
      return await treeIs(dir, g(dir, "rev-parse", "HEAD"), ".github", want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(await is((d) => writeFileSync(join(d, "README.md"), "other files don't matter\n")), true, "an exact copy");
  assert.equal(await is((d) => writeFileSync(join(d, ".github/workflows/x.yml"), "on: push\n")), false, "an extra workflow");
  assert.equal(await is((d) => writeFileSync(join(d, ".github/workflows/ci.yml"), "on: push\njobs: {} \n")), false, "one byte");
  assert.equal(await is((d) => chmodSync(join(d, ".github/supply-chain/pins.mjs"), 0o755)), false, "a mode change");
  assert.equal(await is((d) => (rmSync(join(d, ".github/dependabot.yml")), symlinkSync("../app.js", join(d, ".github/dependabot.yml")))), false, "a symlink");
  assert.equal(await is((d) => rmSync(join(d, ".github/dependabot.yml"))), false, "a missing file");
  assert.equal(await treeIs(template, "HEAD", ".github", ""), false, "no template tree: never");
  rmSync(template, { recursive: true, force: true });
});

// rebuild(): a rejection on another branch blocks replaying an approval when it carries the same patch, however the
// branch is named and wherever it was rebased.
test("patchKey: the same change renamed and rebased is the same patch; another change isn't", async () => {
  const dir = repo();
  const base = g(dir, "rev-parse", "HEAD");
  g(dir, "checkout", "-qb", "a");
  writeFileSync(join(dir, "app.js"), "2\n");
  g(dir, "commit", "-qam", "change");
  const approved = g(dir, "rev-parse", "HEAD");
  // main moves; the same change is rebased onto it under another branch name.
  g(dir, "checkout", "-q", base);
  writeFileSync(join(dir, "other.js"), "x\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "main moves");
  const main2 = g(dir, "rev-parse", "HEAD");
  g(dir, "checkout", "-qb", "b");
  writeFileSync(join(dir, "app.js"), "2\n");
  g(dir, "commit", "-qam", "same change, renamed");
  const renamed = g(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "app.js"), "3\n");
  g(dir, "commit", "-qam", "different");
  const different = g(dir, "rev-parse", "HEAD");
  assert.equal(await patchKey(dir, main2, renamed), await patchKey(dir, base, approved), "each from its own base");
  assert.notEqual(await patchKey(dir, base, different), await patchKey(dir, base, approved));
  await assert.rejects(patchKey(dir, base, "f".repeat(40)), "a commit that isn't there throws (the caller blocks)");
  rmSync(dir, { recursive: true, force: true });
});

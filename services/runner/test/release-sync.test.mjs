// A modules pin bump carries the shared copies: the product at its tip, with the official modules materialised at the new
// pin, is synced once in a scratch checkout, and exactly the files that moved go in the bump with modules-pin.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repo as product } from "../../../scripts/sync-shared.mjs";
import { bumpFiles, commitFiles, extractTree } from "../src/release-sync.mjs";

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: "pipe", maxBuffer: 64 << 20 }).toString().trim();
const pin = (sha) => JSON.stringify({ repo: "acme/modules", sha });

/** A modules repository at one commit, built from the product's own copies so only the named starter file differs. */
function modulesRepo(root, starter) {
  const materialised = join(product, "modules");
  if (!existsSync(join(materialised, "apps-platform/starter/AGENTS.md"))) return undefined;
  const dir = join(root, "modules");
  mkdirSync(dir);
  for (const d of ["apps-platform/starter", "apps-platform/design-system", "ci/template/.github"]) cpSync(join(materialised, d), join(dir, d), { recursive: true });
  if (starter != null) writeFileSync(join(dir, "apps-platform/starter/AGENTS.md"), starter);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "modules");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

test("a modules tree that changes the app starter puts its synced copy in the bump", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "modules-bump-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mods = modulesRepo(root, "# starter from the new pin\n");
  if (!mods) return t.skip("the official modules aren't materialised (node scripts/modules-repo/materialize.mjs)");
  const clone = join(root, "product");
  git(root, "clone", "-q", product, clone);
  const tip = git(clone, "rev-parse", "HEAD");
  const files = await bumpFiles({ product: clone, tip, to: mods.sha, pin: pin(mods.sha), fetchModules: (sha, dest) => extractTree(mods.dir, sha, dest) });
  assert.deepEqual(Object.keys(files), ["modules-pin.json", "services/computer/images/agent-base/app-starter/AGENTS.md"]);
  assert.equal(files["modules-pin.json"].toString(), pin(mods.sha));
  assert.equal(files["services/computer/images/agent-base/app-starter/AGENTS.md"].toString(), "# starter from the new pin\n");
  // The commit holds exactly those files, never other work in the checkout.
  writeFileSync(join(clone, "UNRELATED"), "unrelated work\n");
  writeFileSync(join(clone, "services/computer/images/agent-base/app-starter/README.md"), "unrelated work\n");
  const sha = await commitFiles({ path: clone, tip, branch: "bump", files, index: join(root, "index"), env: { ...env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com" }, message: "bump" });
  assert.deepEqual(git(clone, "diff", "--no-renames", "--name-only", tip, sha).split("\n").sort(), Object.keys(files).sort());
  assert.equal(git(clone, "show", `${sha}:services/computer/images/agent-base/app-starter/AGENTS.md`), "# starter from the new pin");
  assert.equal(existsSync(join(root, "index")), false, "the private index is removed");
});

test("a modules tree that changes nothing shared keeps the bump to modules-pin.json", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "modules-bump-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mods = modulesRepo(root);
  if (!mods) return t.skip("the official modules aren't materialised (node scripts/modules-repo/materialize.mjs)");
  const tip = git(product, "rev-parse", "HEAD");
  const files = await bumpFiles({ product, tip, to: mods.sha, pin: pin(mods.sha), fetchModules: (sha, dest) => extractTree(mods.dir, sha, dest) });
  assert.deepEqual(Object.keys(files), ["modules-pin.json"]);
  assert.equal(files["modules-pin.json"].toString(), pin(mods.sha));
});

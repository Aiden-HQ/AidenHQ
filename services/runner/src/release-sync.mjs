// The modules pin bump's file set: the pin plus every product copy the shared sync changes when the official modules move
// to the new pin. The tree is materialised in a scratch checkout of the product's tip, never in a worktree, so the commit
// holds exactly those files and none of the checkout's other work.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ISOLATED_ENV, SAFE_GIT_ARGS } from "../../../modules/codehost-github/src/git.mjs";
import { syncShared } from "../../../scripts/sync-shared.mjs";

const execFileP = promisify(execFile);

/** A commit's tree in `dest`, as files. Symlinks and submodules are refused, as the modules materialiser does. */
export async function extractTree(repo, sha, dest) {
  const odd = (await execFileP("git", [...SAFE_GIT_ARGS, "-C", repo, "ls-tree", "-r", "-z", sha], { env: ISOLATED_ENV, maxBuffer: 256 << 20 })).stdout
    .split("\0")
    .filter((e) => /^(120000|160000) /.test(e));
  if (odd.length) throw new Error(`${sha.slice(0, 12)} has symlinks or submodules: ${odd.slice(0, 5).join(", ")}`);
  const archive = await execFileP("git", [...SAFE_GIT_ARGS, "-C", repo, "archive", "--format=tar", sha], { env: ISOLATED_ENV, maxBuffer: 256 << 20, timeout: 120_000, encoding: "buffer" });
  mkdirSync(dest, { recursive: true });
  await new Promise((res, rej) => {
    const p = execFile("tar", ["-x", "-C", dest], { maxBuffer: 32 << 20 }, (err) => (err ? rej(err) : res()));
    p.stdin.end(archive.stdout);
  });
}

/**
 * The files a bump from `tip` to `to` commits: path → bytes, or null for a removal. `pin` is the new modules-pin.json text;
 * `fetchModules(sha, dest)` puts the official modules at `sha` in `dest` (extractTree in the runner, a local repo in tests).
 */
export async function bumpFiles({ product, tip, to, pin, fetchModules }) {
  const tmp = mkdtempSync(join(tmpdir(), "aidenhq-bump-"));
  try {
    const root = join(tmp, "product");
    mkdirSync(root);
    await extractTree(product, tip, root);
    await fetchModules(to, join(root, "modules"));
    writeFileSync(join(root, "modules-pin.json"), pin);
    syncShared(root);
    const gitDir = (await execFileP("git", [...SAFE_GIT_ARGS, "-C", product, "rev-parse", "--absolute-git-dir"], { env: ISOLATED_ENV })).stdout.trim();
    const index = join(tmp, "index");
    const g = (...args) => execFileP("git", [...SAFE_GIT_ARGS, `--git-dir=${gitDir}`, `--work-tree=${root}`, ...args], { cwd: root, env: { ...ISOLATED_ENV, GIT_INDEX_FILE: index }, maxBuffer: 256 << 20 });
    await g("read-tree", tip);
    // The modules tree is materialised for the sync, never part of the product: it stays out of the index and the diff.
    await g("add", "--all", "--force", "--", ".", ":(exclude)modules");
    const changed = (await g("diff", "--cached", "--no-renames", "--name-only", "-z", tip, "--", ".", ":(exclude)modules")).stdout.split("\0").filter(Boolean);
    if (!changed.includes("modules-pin.json")) throw new Error("the bump changed no modules pin");
    // The commit writes plain files; a synced copy that moves its mode would lose it silently, so refuse it here.
    const modes = new Map((await g("ls-files", "-s", "-z", "--", ...changed)).stdout.split("\0").filter(Boolean).map((e) => [e.slice(e.indexOf("\t") + 1), e.split(" ")[0]]));
    const odd = changed.find((p) => modes.has(p) && modes.get(p) !== "100644");
    if (odd) throw new Error(`the bump would change the mode of ${odd}`);
    return Object.fromEntries(changed.sort().map((p) => [p, existsSync(join(root, p)) ? readFileSync(join(root, p)) : null]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A commit on `tip` with exactly `files` (path → bytes, or null to delete it) changed, made with git's plumbing and a
 * private index in `path`'s repository, set as `branch`. `env` is the commit identity; the index is removed afterwards.
 */
export async function commitFiles({ path, tip, branch, files, message, env, index }) {
  const g = (args, input) =>
    new Promise((res, rej) => {
      const p = execFile("git", [...SAFE_GIT_ARGS, ...args], { cwd: path, env: { ...ISOLATED_ENV, ...env, GIT_INDEX_FILE: index }, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? rej(err) : res(String(out).trim())));
      p.stdin.end(input ?? "");
    });
  try {
    await g(["read-tree", tip]);
    for (const [p, text] of Object.entries(files)) {
      if (text === null) await g(["update-index", "--force-remove", "--", p]);
      else await g(["update-index", "--add", "--cacheinfo", `100644,${await g(["hash-object", "-w", "--stdin"], text)},${p}`]);
    }
    const sha = await g(["commit-tree", await g(["write-tree"]), "-p", tip, "-F", "-"], message);
    const changed = (await g(["diff", "--no-renames", "--name-only", tip, sha])).split("\n").filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(Object.keys(files).sort())) throw new Error(`the bump commit changes ${changed.join(", ") || "nothing"}`);
    await g(["branch", "--force", branch, sha]);
    return sha;
  } finally {
    rmSync(index, { force: true });
  }
}

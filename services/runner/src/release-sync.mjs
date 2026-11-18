// The modules pin bump's file set: the pin plus every product copy the shared sync changes when the official modules move
// to the new pin. The sync runs on a scratch checkout of the product's tip, and only the paths it writes are compared, so
// no other file of a checkout can enter the commit.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ISOLATED_ENV, SAFE_GIT_ARGS } from "../../../modules/codehost-github/src/git.mjs";
import { listFiles, sharedCopies, syncShared } from "../../../scripts/sync-shared.mjs";

const execFileP = promisify(execFile);

/** A commit's tree in `dest`, as files. Symlinks and submodules are refused, as the modules materialiser does. */
export async function extractTree(repo, sha, dest) {
  const entries = (await execFileP("git", [...SAFE_GIT_ARGS, "-C", repo, "ls-tree", "-r", "-z", sha], { env: ISOLATED_ENV, maxBuffer: 256 << 20 })).stdout.split("\0").filter(Boolean);
  const odd = entries.filter((e) => /^(120000|160000) /.test(e)).map((e) => e.split("\t")[1]);
  if (odd.length) throw new Error(`${sha.slice(0, 12)} has symlinks or submodules: ${odd.slice(0, 5).join(", ")}`);
  const archive = await execFileP("git", [...SAFE_GIT_ARGS, "-C", repo, "archive", "--format=tar", sha], { env: ISOLATED_ENV, maxBuffer: 256 << 20, timeout: 120_000, encoding: "buffer" });
  mkdirSync(dest, { recursive: true });
  await new Promise((res, rej) => {
    const p = execFile("tar", ["-x", "-C", dest], { maxBuffer: 32 << 20 }, (err) => (err ? rej(err) : res()));
    p.stdin.end(archive.stdout);
  });
}

/** The blob id git gives `bytes`, with no filters applied. */
const blob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * A commit's tree as path → blob id in `repo` at `sha` (plain files only; `extractTree` refuses the rest).
 */
async function treeAt(repo, sha) {
  const out = (await execFileP("git", [...SAFE_GIT_ARGS, "-C", repo, "ls-tree", "-r", "-z", sha], { env: ISOLATED_ENV, maxBuffer: 256 << 20 })).stdout;
  return new Map(out.split("\0").filter(Boolean).map((e) => {
    const [meta, path] = e.split("\t");
    return [path, meta.split(" ")[2]];
  }));
}

/**
 * The files a bump from `tip` to `to` commits: path → bytes, or null for a removal. `pin` is the new modules-pin.json text;
 * `fetchModules(sha, dest)` puts the official modules at `sha` in `dest` (extractTree in the runner, a local repo in tests).
 * A modules tree that changes nothing shared leaves the pin alone in the bump.
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
    // Every product path the sync writes (the modules tree's own copies stay in the modules repo), and every path a
    // whole-folder copy owns: a file the new tree no longer has there is a removal in the bump.
    const copies = sharedCopies(root);
    const folders = Object.values(copies.dirs).flat();
    const written = [...Object.values(copies.files).flat(), ...folders.flatMap((d) => listFiles(join(root, d)).map((f) => join(d, f)))].filter((p) => !p.startsWith("modules/"));
    const before = await treeAt(product, tip);
    const files = new Map([["modules-pin.json", Buffer.from(pin)]]);
    for (const p of written) {
      if (!statSync(join(root, p)).isFile()) throw new Error(`the shared sync wrote ${p}, which is not a plain file`);
      const bytes = readFileSync(join(root, p));
      if (blob(bytes) !== before.get(p)) files.set(p, bytes);
    }
    for (const p of before.keys()) if (folders.some((d) => p.startsWith(`${d}/`)) && !p.startsWith("modules/") && !written.includes(p)) files.set(p, null);
    return Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)));
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

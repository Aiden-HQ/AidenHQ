// A task clone made for the jail (hardlinked to the runner's cache) whose Engineer now runs in a computer: before the box mounts
// it, it gets object files of its own, and keeps its branches; the cache is untouched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { git } from "../src/git.mjs";
import { ensureRepo } from "../src/workspace.ts";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "pw-box-clone-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = join(dir, "seed");
  execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" });
  writeFileSync(join(seed, "a"), "a\n");
  execFileSync("git", ["-C", seed, "add", "."]);
  execFileSync("git", ["-C", seed, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "HEAD:main"]);
  const cache = join(dir, "repos", "acme", "api");
  execFileSync("git", ["clone", "-q", remote, cache]);
  const repo = { org: "acme", name: "api", slug: "acme/api" };
  const jail = async (name) => { const ws = join(dir, "tasks", name); return { ws, path: await ensureRepo(ws, repo, { cache, remoteUrl: remote }) }; };
  return { cache, remote, repo, jail };
}
const objects = (p) => execFileSync("find", [join(p, ".git/objects"), "-type", "f"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);

it("a jail clone going into a box gets a fresh .git: no object file shared with the cache, its branches and files kept", async (t) => {
  const { cache, remote, repo, jail } = await setup(t);
  const { ws, path } = await jail("PEN-1");
  assert.ok(objects(path).some((f) => statSync(f).nlink > 1), "a plain local clone hardlinks");
  await git(path, "switch", "-q", "-c", "work");
  writeFileSync(join(path, "b"), "b\n");
  await git(path, "add", "b");
  await git(path, "-c", "user.email=a@b", "-c", "user.name=a", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "work");
  const tip = await git(path, "rev-parse", "work");
  writeFileSync(join(path, "c"), "uncommitted\n");
  const cacheHead = await git(cache, "rev-parse", "HEAD");

  assert.equal(await ensureRepo(ws, repo, { cache, remoteUrl: remote, copy: true }), path);
  for (const f of objects(path)) assert.equal(statSync(f).nlink, 1, `${f} is still hardlinked`);
  assert.equal(await git(path, "rev-parse", "work"), tip);
  assert.equal(await git(path, "symbolic-ref", "HEAD"), "refs/heads/work");
  assert.equal(readFileSync(join(path, "c"), "utf8"), "uncommitted\n");
  assert.equal(await git(path, "config", "remote.origin.pushurl"), "DISABLED_BY_AIDENHQ");
  assert.equal(await git(cache, "rev-parse", "HEAD"), cacheHead);
  await git(cache, "fsck", "--no-progress");
});

it("an agent-written alternates file or a symlink in a jail clone's .git is refused, and nothing is followed or changed", async (t) => {
  const { cache, remote, repo, jail } = await setup(t);
  const a = await jail("PEN-2");
  writeFileSync(join(a.path, ".git/objects/info/alternates"), `${join(cache, ".git/objects")}\n`);
  await assert.rejects(ensureRepo(a.ws, repo, { cache, remoteUrl: remote, copy: true }), /names other object stores/);
  const b = await jail("PEN-3");
  const pack = join(b.path, ".git/objects/pack");
  rmSync(pack, { recursive: true, force: true });
  symlinkSync(join(cache, ".git/objects/pack"), pack);
  const before = objects(cache).join();
  await assert.rejects(ensureRepo(b.ws, repo, { cache, remoteUrl: remote, copy: true }), /has a symlink/);
  assert.equal(objects(cache).join(), before);
  await git(cache, "fsck", "--no-progress");
});

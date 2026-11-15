// A PR's base is resolved against GitHub before the PR is created (a stacked branch's base that was squash-merged away, or
// that already holds every commit, would make a PR that can never merge). A head with nothing of its own gets one plain
// sentence naming the base, never GitHub's raw "Head sha can't be blank … No commits between …" text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrBase } from "../src/workspace.ts";

const ID = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, ...ID } }).toString().trim();
const commit = (cwd, file, text, message) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", message);
};

/** An origin with `main`, a base branch `feat/base`, and a clone at `work` that has both locally. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "pr-base-"));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, work);
  commit(work, "a.txt", "a\n", "a");
  git(work, "push", "-q", "origin", "main");
  git(work, "switch", "-qc", "feat/base", "origin/main");
  commit(work, "b.txt", "b\n", "base");
  git(work, "push", "-q", "origin", "feat/base");
  git(work, "switch", "-qc", "feat/stacked", "feat/base");
  commit(work, "c.txt", "c\n", "stacked");
  return { dir, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a base branch GitHub still has, with commits on top of it, is the PR's base", async () => {
  const r = repo();
  try {
    assert.deepEqual(await resolvePrBase(r.work, { branch: "feat/stacked", base: "feat/base", defaultBranch: "main" }), { base: "feat/base", from: "origin/feat/base" });
  } finally {
    r.done();
  }
});

test("a base that was squash-merged and deleted falls back to the default branch", async () => {
  const r = repo();
  try {
    // The base's content lands on main as one new commit (a squash), and its branch goes away.
    git(r.work, "switch", "-q", "main");
    git(r.work, "merge", "-q", "--squash", "feat/base");
    git(r.work, "commit", "-qm", "base (#1)");
    git(r.work, "push", "-q", "origin", "main");
    git(r.work, "push", "-q", "origin", "--delete", "feat/base");
    git(r.work, "fetch", "-q", "--prune", "origin");
    assert.deepEqual(await resolvePrBase(r.work, { branch: "feat/stacked", base: "feat/base", defaultBranch: "main" }), { base: "main", from: "origin/main" });
  } finally {
    r.done();
  }
});

test("a head with no commits of its own gets one sentence naming the base", async () => {
  const r = repo();
  try {
    git(r.work, "switch", "-qc", "feat/idle", "origin/main");
    const out = await resolvePrBase(r.work, { branch: "feat/idle", base: "main", defaultBranch: "main" });
    assert.equal(out.base, "main");
    assert.match(out.error, /^not opened: `feat\/idle` has no commits that aren't already on `main`, so a PR would carry nothing$/);
    assert.doesNotMatch(out.error, /Head sha can't be blank|No commits between|Base ref must be a branch/);
  } finally {
    r.done();
  }
});

test("a gone base and a head GitHub already has also get a plain sentence naming that base", async () => {
  const r = repo();
  try {
    git(r.work, "push", "-q", "origin", "--delete", "feat/base");
    git(r.work, "fetch", "-q", "--prune", "origin");
    git(r.work, "switch", "-qc", "feat/idle", "origin/main");
    const out = await resolvePrBase(r.work, { branch: "feat/idle", base: "feat/base", defaultBranch: "main" });
    assert.equal(out.base, "main");
    assert.match(out.error, /its base `feat\/base` is gone or already has every commit on `feat\/idle`/);
    assert.doesNotMatch(out.error, /Head sha can't be blank|No commits between|Base ref must be a branch/);
  } finally {
    r.done();
  }
});

/**
 * A `git` that fails the way a bad network minute does, but only for one branch (`only` and the command prefix `cmd`):
 * `resolvePrBase`'s read of that branch fails while GitHub's other branches stay readable, which is exactly the case that
 * must not be mistaken for "the base is gone".
 */
function faultyGit(bin, { cmd, only }) {
  mkdirSync(bin, { recursive: true });
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" ${cmd} "*${only}*) echo "fatal: unable to access the repository" >&2; exit 128;; esac\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

test("a base whose read fails is refused, never taken for gone: no PR opens into main with the base's commits", async () => {
  const r = repo();
  try {
    // Only `feat/base` is unreadable; `main` and the branch stay readable, so a fallback would silently open into main.
    const bin = faultyGit(join(r.dir, "bin"), { cmd: "ls-remote", only: "feat/base" });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    try {
      const out = await resolvePrBase(r.work, { branch: "feat/stacked", base: "feat/base", defaultBranch: "main" });
      assert.equal(out.from, "", "nothing to publish from");
      assert.equal(out.base, "", "no base was chosen");
      assert.match(out.error, /^couldn't read GitHub's `feat\/base`, so no PR was opened: try again in a few minutes$/);
    } finally {
      process.env.PATH = process.env.PATH.slice(bin.length + 1);
    }
  } finally {
    r.done();
  }
});

test("a base seen on GitHub whose fetch fails is refused too, not counted from a stale ref", async () => {
  const r = repo();
  try {
    // `ls-remote` sees the base, but the fetch paired with it fails: the count would otherwise read an old tip.
    const bin = faultyGit(join(r.dir, "bin"), { cmd: "fetch", only: "feat/base" });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    try {
      const out = await resolvePrBase(r.work, { branch: "feat/stacked", base: "feat/base", defaultBranch: "main" });
      assert.equal(out.from, "");
      assert.match(out.error, /^couldn't read GitHub's `feat\/base`, so no PR was opened/);
    } finally {
      process.env.PATH = process.env.PATH.slice(bin.length + 1);
    }
  } finally {
    r.done();
  }
});

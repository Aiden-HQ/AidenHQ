// An agent writes its clones' .git (jail and box alike): the runner's own git on a task clone must never run what that
// clone's config names, and must refuse a .git that points somewhere else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, historyRewritten, setUntrusted } from "../src/git.mjs";

test("a hostile clone config (hooks, fsmonitor, filters, signing program) runs nothing in the runner's git", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aidenhq-hostile-")));
  t.after(() => { setUntrusted(undefined); rmSync(dir, { recursive: true, force: true }); });
  const tasks = join(dir, "work/tasks");
  const clone = join(tasks, "PEN-7/app");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, env, stdio: "pipe" }).toString().trim();
  mkdirSync(clone, { recursive: true });
  g(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "a.txt"), "hello\n");
  writeFileSync(join(clone, ".gitattributes"), "*.txt filter=evil\n");
  g(clone, "add", ".");
  g(clone, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  // What the agent plants: each would write the marker if git ran it.
  const marker = join(dir, "pwned");
  const evil = join(dir, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat\n`);
  chmodSync(evil, 0o755);
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  for (const h of ["post-checkout", "reference-transaction", "pre-commit"]) { writeFileSync(join(hooks, h), `#!/bin/sh\necho hook >> ${marker}\n`); chmodSync(join(hooks, h), 0o755); }
  for (const [k, v] of [["core.hooksPath", hooks], ["core.fsmonitor", evil], ["filter.evil.clean", evil], ["filter.evil.smudge", evil], ["filter.evil.process", evil], ["gpg.program", evil], ["core.sshCommand", evil], ["include.path", join(dir, "other.cfg")]]) g(clone, "config", k, v);
  writeFileSync(join(dir, "other.cfg"), `[core]\n\tfsmonitor = ${evil}\n`);

  setUntrusted({ tasksDir: tasks, hooksDir: join(dir, "work/.guard-hooks") });
  // The host's own global config isn't read for a task clone's local commands either (no filters from anywhere).
  const globalCfg = join(dir, "global.cfg");
  writeFileSync(globalCfg, `[filter "evil"]\n\tclean = ${evil}\n\tsmudge = ${evil}\n`);
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  t.after(() => (before === undefined ? delete process.env.GIT_CONFIG_GLOBAL : (process.env.GIT_CONFIG_GLOBAL = before)));
  await git(clone, "status", "--porcelain");
  writeFileSync(join(clone, "a.txt"), "changed\n");
  await git(clone, "add", "a.txt");
  await git(clone, "checkout", "-q", "-b", "feature");
  await git(clone, "checkout", "-q", "--", "a.txt");
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  const left = g(clone, "config", "--file", ".git/config", "--list");
  assert.doesNotMatch(left, /filter\.|fsmonitor|gpg\.|sshcommand|include\.|hookspath/i);

  // A .git that is a symlink, or a file pointing outside the task's clones: refused before git runs.
  const other = join(tasks, "PEN-7/other");
  mkdirSync(other);
  symlinkSync(join(clone, ".git"), join(other, ".git"));
  await assert.rejects(git(other, "status"), /symlink/);
  // The scrubbed clone still talks ssh the host's way: the planted sshCommand is gone, plain ssh runs (no empty-command override).
  const sshBin = join(dir, "sshbin");
  mkdirSync(sshBin);
  writeFileSync(join(sshBin, "ssh"), `#!/bin/sh\necho ran >> ${join(dir, "ssh-ran")}\nexit 1\n`);
  chmodSync(join(sshBin, "ssh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${sshBin}:${path}`;
  await assert.rejects(git(clone, "ls-remote", "ssh://git@example.invalid/x.git"));
  process.env.PATH = path;
  assert.ok(existsSync(join(dir, "ssh-ran")), "ssh ran");
  assert.equal(existsSync(marker), false);

  // External diff programs: planted in the clone's config, or in the runner's own env, never run; the diff is git's own.
  g(clone, "config", "diff.external", evil);
  g(clone, "config", "diff.tool", "evil");
  g(clone, "config", "difftool.evil.cmd", evil);
  process.env.GIT_EXTERNAL_DIFF = evil;
  writeFileSync(join(clone, "a.txt"), "diffed\n");
  const shown = await git(clone, "diff");
  await git(clone, "log", "-p", "-1");
  delete process.env.GIT_EXTERNAL_DIFF;
  assert.match(shown, /\+diffed/);
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
  assert.doesNotMatch(g(clone, "config", "--file", ".git/config", "--list"), /diff\.external|diff\.tool|difftool\./i);

  // A bare repository planted inside a clone (its own HEAD, objects, refs and a hostile config) is never the one git uses:
  // the runner names the clone it checked (GIT_DIR) and bare repositories need naming outright.
  const bare = join(clone, "vendor");
  g(dir, "init", "-q", "--bare", bare);
  g(dir, "--git-dir", bare, "config", "core.fsmonitor", evil);
  g(dir, "--git-dir", bare, "config", "core.editor", "PLANTED");
  assert.equal(await git(bare, "config", "--get", "core.editor").catch(() => ""), "", "the planted bare repository's config isn't read");
  assert.equal(await git(bare, "rev-parse", "--absolute-git-dir"), join(clone, ".git"));
  assert.equal(existsSync(marker), false);

  // A .git that isn't a real gitdir: refused.
  const hollow = join(tasks, "PEN-7/hollow");
  mkdirSync(join(hollow, ".git"), { recursive: true });
  writeFileSync(join(hollow, ".git/config"), "[core]\n\tbare = false\n");
  await assert.rejects(git(hollow, "status"), /isn't a valid git directory/);

  // A commondir planted in a clone's .git would move the config git reads: refused.
  const moved = join(tasks, "PEN-7/moved");
  mkdirSync(moved);
  g(moved, "init", "-q");
  writeFileSync(join(moved, ".git/commondir"), `${join(dir, "elsewhere-repo/.git")}\n`);
  await assert.rejects(git(moved, "status"), /commondir/);

  const away = join(tasks, "PEN-7/away");
  mkdirSync(away);
  writeFileSync(join(away, ".git"), `gitdir: ${join(dir, "elsewhere/.git/worktrees/x")}\n`);
  await assert.rejects(git(away, "status"), /doesn't point at a clone in this task's folder/);
});

test("a replace ref in a task clone (git replace H F) never changes what the runner's git reads of H", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aidenhq-replace-")));
  t.after(() => { setUntrusted(undefined); rmSync(dir, { recursive: true, force: true }); });
  const tasks = join(dir, "work/tasks");
  const clone = join(tasks, "PEN-8/app");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: clone, env, stdio: "pipe" }).toString().trim();
  mkdirSync(clone, { recursive: true });
  g("init", "-q", "-b", "main");
  writeFileSync(join(clone, "policy.txt"), "deny\n");
  g("add", ".");
  g("commit", "-qm", "M");
  // H changes the policy (what would be pushed); F only a readme (what a reviewer would be shown).
  writeFileSync(join(clone, "policy.txt"), "allow everyone\n");
  g("commit", "-qam", "H");
  const h = g("rev-parse", "HEAD");
  g("switch", "-qc", "f", "HEAD~1");
  writeFileSync(join(clone, "readme"), "docs\n");
  g("add", ".");
  g("commit", "-qm", "F");
  g("replace", h, g("rev-parse", "HEAD"));
  assert.equal(g("diff", "--name-only", `${h}~1`, h), "readme", "plain git is fooled");
  setUntrusted({ tasksDir: tasks, hooksDir: join(dir, "work/.guard-hooks") });
  // The files reviewed are the files published: H's own.
  assert.equal(await git(clone, "diff", "--name-only", `${h}~1`, h), "policy.txt", "the runner's git reads H itself");
  assert.equal(await git(clone, "show", `${h}:policy.txt`), "allow everyone");
  assert.match(await historyRewritten(clone), /replace refs/, "and a publish from it is refused");
});

test("a grafts file in a worktree's common dir is found, and the runner's git ignores it", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aidenhq-grafts-")));
  t.after(() => { setUntrusted(undefined); rmSync(dir, { recursive: true, force: true }); });
  const tasks = join(dir, "work/tasks");
  const clone = join(tasks, "PEN-9/app");
  const tree = join(tasks, "PEN-9/app-wt");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, env, stdio: "pipe" }).toString().trim();
  mkdirSync(clone, { recursive: true });
  g(clone, "init", "-q", "-b", "main");
  for (const n of ["a", "b", "c"]) {
    writeFileSync(join(clone, `${n}.txt`), `${n}\n`);
    g(clone, "add", ".");
    g(clone, "commit", "-qm", n);
  }
  g(clone, "worktree", "add", "-q", "-b", "wt", tree);
  setUntrusted({ tasksDir: tasks, hooksDir: join(dir, "work/.guard-hooks") });
  assert.equal(await historyRewritten(tree), undefined);
  // Grafts in the common dir (not the worktree's own .git dir): c's parent becomes a, hiding b.
  const [c, , a] = g(clone, "rev-list", "main").split("\n");
  mkdirSync(join(clone, ".git/info"), { recursive: true });
  writeFileSync(join(clone, ".git/info/grafts"), `${c} ${a}\n`);
  assert.equal(g(tree, "diff", "--name-only", `${c}~1`, c), "b.txt\nc.txt", "plain git is fooled");
  assert.equal(await git(tree, "diff", "--name-only", `${c}~1`, c), "c.txt", "the runner's git isn't");
  assert.match(await historyRewritten(tree), /grafts/);
  rmSync(join(clone, ".git/info/grafts"));
  writeFileSync(join(clone, ".git/shallow"), `${a}\n`);
  assert.match(await historyRewritten(tree), /shallow/);
});

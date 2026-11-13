import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_IDENTITY, appRemoteUrl, appSlugOf, identityEnv, withGitToken } from "./github-app.mjs";

const run = promisify(execFile);

// Repos the GitHub App covers: network commands carry a repo-narrowed token through a per-command credential
// helper, and only ever in the runner's cache clone (<cacheRoot>/<org>/<name>), never in an agent-writable workspace:
// a workspace fetch is a token fetch into the cache, then a local fetch from it; a workspace push is a local push into the
// cache, then a token push from it. `setGitAuth({ cacheRoot, token: (slug, write) => token | undefined })`; unset (no App),
// git behaves exactly as before.
let gitAuth;
export const setGitAuth = (a) => (gitAuth = a);
const NETWORK = new Set(["fetch", "push", "ls-remote", "clone", "remote"]);
// No external diff program and no repository named from outside, whatever the runner's own environment says. No replace
// refs, grafts or shallow file either: an agent's `git replace H F` would show F to tiering and the reviewer while H is what gets pushed.
const ENV = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null" };
  for (const k of ["GIT_EXTERNAL_DIFF", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[k];
  return env;
};

/**
 * Every host git command runs with these: an agent writes its clones' `.git` (in the jail as the runner's uid, in a box
 * through a read-write mount), so a clone's own config must never make the runner run something. Hooks, fsmonitor and ext::
 * transports are off whatever the clone says; every other key that runs a program (ssh and proxy commands, filters, signing
 * programs, drivers, includes) the clone's config loses before the runner touches it (`scrubFor`). (An empty core.sshCommand or
 * diff.external isn't "off": git tries to run the empty command, checked 2026-11-13, so those aren't overridden here.) In a
 * task folder, every local command also runs without the user's global and system config (`TASK_ENV`: no filters or drivers
 * from anywhere); network commands keep the global config (the host's push routes and credential helpers, not the agent's).
 */
// safe.bareRepository=explicit: a bare repository an agent planted in a clone (a parser differential with our checks) is
// never discovered; only one named explicitly is used.
export const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];
// The task folders are a ceiling too: git never looks for a repository above one. A checked clone is named outright
// (GIT_DIR, GIT_WORK_TREE): git uses the repository scrubFor validated, never one it discovers.
const TASK_ENV = (global, repo) => ({ ...ENV(), GIT_CEILING_DIRECTORIES: untrusted.tasksDir, ...(global ? {} : { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }), ...(repo ? { GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.workTree } : {}) });
// Commands that can print a diff: never through an external program or a textconv driver.
const DIFFS = new Set(["diff", "log", "show"]);

async function plain(cwd, args) {
  const task = await scrubFor(cwd);
  const env = task ? TASK_ENV(NETWORK.has(args[0]), task.gitDir ? task : undefined) : ENV();
  let at = 0;
  while (args[at] === "-c") at += 2;
  const full = DIFFS.has(args[at]) ? [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)] : args;
  const { stdout } = await run("git", [...SAFE_GIT_ARGS, ...full], { cwd, maxBuffer: 32 * 1024 * 1024, env });
  return stdout.trim();
}

// Agent-writable clones: under `tasksDir` (the task folders). `hooksDir`: the guard hooks, the one core.hooksPath kept.
let untrusted;
export function setUntrusted(u) {
  if (!u) return (untrusted = undefined);
  mkdirSync(u.tasksDir, { recursive: true });
  untrusted = { tasksDir: resolve(u.tasksDir), realTasks: realpathSync(u.tasksDir), hooksDir: u.hooksDir };
}
const scrubbed = new Map(); // config file → its stat when last scrubbed
// A path under the task folders with no symlink below them (the work dir itself may sit behind one).
const noLinkBelow = (p) => realpathSync(p) === untrusted.realTasks + p.slice(untrusted.tasksDir.length);

// Repo-local keys that run a program, load other config or redirect where git reads from or talks to.
const HOSTILE = /^(core\.(fsmonitor|sshcommand|gitproxy|askpass|editor|pager|hookspath|worktree|attributesfile|excludesfile|alternaterefscommand|alternaterefsprefixes)|filter\.|diff\.[^.]+\.(command|textconv)|diff\.(external|tool|guitool)$|difftool\.|mergetool\.|merge\.(tool|guitool)$|merge\.[^.]+\.driver|gpg\.|credential\.|include\.|includeif\.|url\.|protocol\.|http\.|remote\.[^.]+\.(uploadpack|receivepack|proxy|vcs)|sequence\.editor|uploadpack\.|receive\.|submodule\.|safe\.|extensions\.worktreeconfig)/i;

/**
 * Before the runner's git touches a task clone (cwd anywhere in one): its `.git` must be a real directory at `<clone>/.git`
 * (not a symlink, not a file pointing elsewhere, except a worktree of a clone in the same task folder), and every hostile
 * key is removed from its config, read with `--file` (no includes, nothing run). Throws when the clone is not what it should
 * be. Cheap: a config file is read again only when it changed. True when cwd is in a task folder.
 */
export async function scrubFor(cwd) {
  if (!untrusted) return false;
  let dir = resolve(cwd);
  if (!(dir + "/").startsWith(untrusted.tasksDir + "/") || dir === untrusted.tasksDir) return false;
  const task = join(untrusted.tasksDir, dir.slice(untrusted.tasksDir.length + 1).split("/")[0]);
  for (; dir.length >= task.length; dir = dirname(dir)) {
    const st = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) throw new Error(`${dir}/.git is a symlink; refusing to run git there`);
    // A clone's own .git has no commondir: one would move the config git reads to wherever it points (checked 2026-11-13).
    if (st.isDirectory()) {
      if (lstatSync(join(dir, ".git", "commondir"), { throwIfNoEntry: false })) throw new Error(`${dir}/.git has a commondir; refusing to run git there`);
      gitdirShape(join(dir, ".git"), true);
      await scrubDir(join(dir, ".git"));
      return { gitDir: join(dir, ".git"), workTree: dir };
    }
    // A worktree's `.git` file: its gitdir must be <clone>/.git/worktrees/<name> of a clone in this task folder.
    const m = /^gitdir: (.+)\n?$/.exec(smallFile(join(dir, ".git")) ?? "");
    const gitdir = m && resolve(dir, m[1]);
    const common = gitdir && /^(.*\/\.git)\/worktrees\/[^/]+$/.exec(gitdir)?.[1];
    // ...and that gitdir's commondir must lead back to exactly that clone's .git.
    const back = gitdir && smallFile(join(gitdir, "commondir"))?.trim();
    if (!common || !(common + "/").startsWith(task + "/") || !lstatSync(common, { throwIfNoEntry: false })?.isDirectory() || !noLinkBelow(common) || !back || resolve(gitdir, back) !== common) throw new Error(`${dir}/.git doesn't point at a clone in this task's folder; refusing to run git there`);
    gitdirShape(common, true);
    gitdirShape(gitdir, false);
    await scrubDir(common);
    await scrubDir(gitdir);
    return { gitDir: gitdir, workTree: dir };
  }
  return true;
}

/** A real gitdir: HEAD a regular file; a clone's own also has objects/ and refs/ directories. Throws otherwise. */
function gitdirShape(gitDir, own) {
  const is = (n, dir) => { const s = lstatSync(join(gitDir, n), { throwIfNoEntry: false }); return dir ? s?.isDirectory() : s?.isFile(); };
  if (!is("HEAD") || (own && !(is("objects", true) && is("refs", true)))) throw new Error(`${gitDir} isn't a valid git directory; refusing to run git there`);
}

async function scrubDir(gitDir) {
  if (!noLinkBelow(gitDir)) throw new Error(`${gitDir} goes through a symlink; refusing to run git there`);
  for (const name of ["config", "config.worktree"]) {
    const file = join(gitDir, name);
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (!st) continue;
    if (!st.isFile()) throw new Error(`${file} isn't a regular file; refusing to run git there`);
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    if (scrubbed.get(file) === stamp) continue;
    const cfg = ["-c", "core.hooksPath=/dev/null", "config", "--file", file];
    const list = (await run("git", [...cfg, "--null", "--list"], { env: ENV() })).stdout.split("\0").filter(Boolean).map((e) => [e.split("\n")[0], e.slice(e.indexOf("\n") + 1)]);
    for (const [key, value] of list) {
      if (!HOSTILE.test(key) || (key.toLowerCase() === "core.hookspath" && untrusted.hooksDir && value === untrusted.hooksDir)) continue;
      await run("git", [...cfg, "--unset-all", key], { env: ENV() }).catch(() => {});
    }
    const after = lstatSync(file);
    scrubbed.set(file, `${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`);
  }
}

/** Where a workspace remote-tracking fetch reads from in the cache: refs/heads/x and x → refs/remotes/origin/x. */
const cacheSpec = (spec) => {
  const [src, dst] = spec.replace(/^\+/, "").split(":");
  const from = src.startsWith("refs/heads/") ? `refs/remotes/origin/${src.slice(11)}` : src.startsWith("refs/") ? src : `refs/remotes/origin/${src}`;
  return `+${from}:${dst || from}`;
};

/** Runs a network command through the App when it targets a covered repo; undefined → the plain path. */
async function viaApp(cwd, args) {
  const sub = args[0];
  if (!gitAuth || !NETWORK.has(sub) || (sub === "remote" && args[1] !== "set-head")) return undefined;
  const at = args.findIndex((a) => /github\.com[/:]/.test(a));
  const origin = args.indexOf("origin");
  const slug = appSlugOf(at >= 0 ? args[at] : origin >= 0 ? await plain(cwd, ["config", "--get", "remote.origin.url"]).catch(() => "") : "");
  const token = slug && (await gitAuth.token(slug, sub === "push"));
  if (!token) return undefined;
  const cache = join(gitAuth.cacheRoot, ...slug.split("/"));
  const t = async (dir, a) => {
    const w = withGitToken(a, ENV(), token);
    return (await run("git", w.args, { cwd: dir, maxBuffer: 32 * 1024 * 1024, env: w.env })).stdout.trim();
  };
  if (sub === "clone" || resolve(cwd) === resolve(cache)) return t(cwd, args);
  if (!existsSync(join(cache, ".git"))) throw new Error(`no runner clone of ${slug} to fetch or push through`);
  if (sub === "ls-remote") return t(cache, args);
  if (sub === "remote") {
    await t(cache, ["remote", "set-head", "origin", "--auto"]);
    return plain(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", await plain(cache, ["symbolic-ref", "refs/remotes/origin/HEAD"])]);
  }
  if (sub === "fetch") {
    await t(cache, ["fetch", "--quiet", "--prune", "origin"]);
    const opts = args.slice(1, origin).filter((a) => a.startsWith("-"));
    const specs = args.slice(origin + 1);
    return plain(cwd, ["fetch", ...opts, cache, ...(specs.length ? specs.map(cacheSpec) : ["+refs/remotes/origin/*:refs/remotes/origin/*"])]);
  }
  // push [opts] <url> <src:dst>…: each src goes into the cache under refs/aidenhq/push/, then out with the token.
  const specs = args.slice(at + 1);
  const temp = specs.map((_, i) => `refs/aidenhq/push/${randomUUID()}-${i}`);
  await plain(cwd, ["push", "--quiet", "--no-verify", "--force", cache, ...specs.map((s, i) => `${s.replace(/^\+/, "").split(":")[0]}:${temp[i]}`)]);
  try {
    return await t(cache, ["push", ...args.slice(1, at), appRemoteUrl(slug), ...specs.map((s, i) => `${s.startsWith("+") ? "+" : ""}${temp[i]}:${s.split(":")[1]}`)]);
  } finally {
    for (const ref of temp) await plain(cache, ["update-ref", "-d", ref]).catch(() => {});
  }
}

export async function git(cwd, ...args) {
  const routed = await viaApp(cwd, args);
  return routed ?? plain(cwd, args);
}

/**
 * A small regular file's text, or undefined for anything else. For files in clones an agent can write to: never follows a
 * final symlink, never blocks on a FIFO or device (opened non-blocking, checked before reading), never reads more than `max`.
 */
export function smallFile(path, max = 4096) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    return buf.subarray(0, readSync(fd, buf, 0, st.size, 0)).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The isolated git env used for every diff the user is shown (no user/system config, no attributes file). */
export const ISOLATED_ENV = { ...ENV(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Hooks dir whose pre-push always refuses: agents cannot push from task worktrees. */
export function ensureGuardHooks(workDir) {
  const dir = join(workDir, ".guard-hooks");
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, "pre-push");
  writeFileSync(hook, '#!/bin/sh\necho "push blocked: AidenHQ task worktrees are local-only. Comment \\"push\\" on the task to publish the branch." >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return dir;
}

/**
 * Runner-owned clone of org/repo (never the user's working copies), refreshed before
 * every job, with pushing disabled at the repository level. `source` is where it's cloned from: GitHub, or a local
 * repository on this host (`repo_sources` in config/runner.yaml, e.g. a person's local instance repo).
 */
export async function ensureClone(workDir, repo, source = `git@github.com:${repo.slug}.git`) {
  const path = join(workDir, "repos", repo.org, repo.name);
  const hooks = ensureGuardHooks(workDir);
  let right = false;
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(join(workDir, "repos", repo.org), { recursive: true });
    await git(join(workDir, "repos", repo.org), "clone", "--quiet", source, path);
  } else {
    // One read; the remote and the push guards are rewritten only when any of them isn't exactly right.
    const want = [["remote.origin.url", source], ["remote.origin.pushurl", "DISABLED_BY_AIDENHQ"], ["core.hookspath", hooks]];
    const have = (await git(path, "config", "--local", "--get-regexp", "^(remote\\.origin\\.(url|pushurl)|core\\.hookspath)$").catch(() => "")).split("\n").filter(Boolean).map((l) => l.split(/ (.*)/s));
    right = have.length === want.length && want.every(([k, v]) => have.some(([hk, hv]) => hk === k && hv === v));
    if (!right) await git(path, "remote", "set-url", "origin", source);
  }
  await git(path, "fetch", "--quiet", "--prune", "origin");
  if (!right) {
    await git(path, "config", "remote.origin.pushurl", "DISABLED_BY_AIDENHQ");
    await git(path, "config", "core.hooksPath", hooks);
  }
  return path;
}

export async function defaultBranch(clone) {
  // origin/HEAD is a symbolic ref, and git keeps those as loose files: read it without a git process. Anything
  // unexpected (a worktree's .git file, another ref backend, no origin/HEAD) takes the git path below.
  try {
    const m = /^ref: refs\/remotes\/origin\/(\S+)\n?$/.exec(smallFile(join(clone, ".git", "refs/remotes/origin/HEAD")) ?? "");
    if (m) return m[1];
  } catch {
    /* the git path */
  }
  try {
    return (await git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");
  } catch {
    try {
      await git(clone, "remote", "set-head", "origin", "--auto");
      return (await git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");
    } catch {
      return "main"; // empty repository: nothing on GitHub yet
    }
  }
}

/** True when the repository on GitHub has no branches at all (a freshly created, empty repo). */
export async function remoteIsEmpty(clone) {
  return (await git(clone, "ls-remote", "--heads", "origin")).length === 0;
}

/**
 * The commit a fleet change is shown and checked against: its merge base with main. A commit main already has is shown
 * against what this host last applied (`deployed`, an instance commit), so a retry after a failed apply still has a diff
 * to approve, and a live one has none. Unknown `deployed`: the commit's own change, shown again rather than skipped.
 */
export async function changeBase(path, mainRef, sha, deployed) {
  const base = await git(path, "merge-base", mainRef, sha);
  if (base !== sha) return base;
  const known = deployed && (await git(path, "cat-file", "-e", `${deployed}^{commit}`).then(() => true, () => false));
  return known ? git(path, "merge-base", deployed, sha) : git(path, "rev-parse", `${sha}~1`);
}

/**
 * Lands exactly the commit `shown` on origin/<base>: its change (against its merge base with main) merged onto the
 * current main as one new commit with main as its parent, pushed as a fast-forward. If main moves during the push the
 * merge is redone once on the new main. A change main already has (a retried apply) lands as nothing: main's sha, no push.
 * Returns the sha main is at, or null when the change conflicts with main.
 */
/**
 * Why a clone's history can't be trusted to read as it would push, or undefined: replace refs, a grafts file, or a
 * shallow file, looked for in the repository's common dir (a worktree's own .git dir doesn't hold them). The runner's git
 * ignores replace refs and grafts anyway (ENV); this keeps a publish from such a clone from happening at all.
 */
export async function historyRewritten(path) {
  if (await git(path, "for-each-ref", "--count=1", "--format=%(refname)", "refs/replace/")) return "replace refs (`refs/replace/`)";
  const common = await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (existsSync(join(common, "info", "grafts"))) return "a grafts file (`info/grafts`)";
  const shallow = join(common, "shallow");
  if (existsSync(shallow) && lstatSync(shallow).size > 0) return "a shallow history (`shallow`)";
  return undefined;
}

/**
 * The commits from..head (a straight line, no merges) replayed one by one onto `onto` in the runner's own clone `path`, as
 * the runner's own commits: each one's tree is git's three-way merge of exactly that commit's change, so the result is the
 * approved commits on the new base by construction. Returns { tip, trees } (each new commit's tree, in order), or null when
 * a commit conflicts, the range isn't a straight line on top of `from`, or it is empty.
 */
export async function replayOnto(path, from, head, onto, identity = DEFAULT_IDENTITY) {
  const env = { ...ISOLATED_ENV, ...identityEnv(identity), GIT_NO_REPLACE_OBJECTS: "1" };
  const g = (...args) => run("git", [...SAFE_GIT_ARGS, ...args], { cwd: path, env, maxBuffer: 32 * 1024 * 1024 }).then((o) => o.stdout.trim());
  if (!(await g("merge-base", "--is-ancestor", from, head).then(() => true, () => false))) return null;
  const commits = (await g("rev-list", "--reverse", "--parents", `${from}..${head}`)).split("\n").filter(Boolean).map((l) => l.split(" "));
  if (!commits.length || commits.some((c) => c.length !== 2) || commits[0][1] !== from || commits.some((c, i) => i && c[1] !== commits[i - 1][0])) return null;
  let tip = onto;
  const trees = [];
  for (const [c, parent] of commits) {
    const tree = await g("merge-tree", "--write-tree", `--merge-base=${parent}`, tip, c).catch((e) => (e.code === 1 ? null : Promise.reject(e)));
    if (!tree) return null;
    trees.push(tree.split("\n")[0]);
    tip = await g("commit-tree", trees.at(-1), "-p", tip, "-m", await g("log", "-1", "--format=%B", c));
  }
  return { tip, trees };
}

export async function landOnMain(path, base, shown, note, { guard, identity = DEFAULT_IDENTITY } = {}) {
  const id = identityEnv(identity);
  const iso = (...args) => scrubFor(path).then(() => run("git", [...SAFE_GIT_ARGS, ...args], { cwd: path, env: { ...ISOLATED_ENV, ...id } })).then((o) => o.stdout.trim());
  const url = await git(path, "remote", "get-url", "origin");
  for (let attempt = 0; ; attempt++) {
    await git(path, "fetch", "--quiet", "origin");
    const main = await git(path, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`);
    // A condition on the exact main this lands on (the trial exception: the agent is still in trial there).
    if (guard && !(await guard(main))) throw new Error(`the change no longer qualifies on ${base} as it is now (${main.slice(0, 9)}); nothing landed`);
    const tree = await iso("merge-tree", "--write-tree", `--merge-base=${await git(path, "merge-base", main, shown)}`, main, shown).catch((e) => (e.code === 1 ? null : Promise.reject(e)));
    if (!tree) return null;
    if (tree.split("\n")[0] === (await git(path, "rev-parse", `${main}^{tree}`))) return main;
    const message = `${await git(path, "log", "-1", "--format=%B", shown)}\n\n${note}`;
    const sha = await iso("commit-tree", tree.split("\n")[0], "-p", main, "-m", message);
    try {
      await git(path, "push", "--no-verify", url, `${sha}:refs/heads/${base}`);
      return sha;
    } catch (err) {
      if (attempt) throw err;
    }
  }
}

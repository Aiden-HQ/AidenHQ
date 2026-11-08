import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
const ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

async function plain(cwd, args) {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: ENV() });
  return stdout.trim();
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
export const ISOLATED_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

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
 * Lands exactly the commit `shown` on origin/<base>: its change (against its merge base with main) merged onto the
 * current main as one new commit with main as its parent, pushed as a fast-forward. If main moves during the push the
 * merge is redone once on the new main. Returns the new sha, or null when the change conflicts with main.
 */
export async function landOnMain(path, base, shown, note, { guard, identity = DEFAULT_IDENTITY } = {}) {
  const id = identityEnv(identity);
  const iso = (...args) => run("git", args, { cwd: path, env: { ...ISOLATED_ENV, ...id } }).then((o) => o.stdout.trim());
  const url = await git(path, "remote", "get-url", "origin");
  for (let attempt = 0; ; attempt++) {
    await git(path, "fetch", "--quiet", "origin");
    const main = await git(path, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`);
    // A condition on the exact main this lands on (the trial exception: the agent is still in trial there).
    if (guard && !(await guard(main))) throw new Error(`the change no longer qualifies on ${base} as it is now (${main.slice(0, 9)}); nothing landed`);
    const tree = await iso("merge-tree", "--write-tree", `--merge-base=${await git(path, "merge-base", main, shown)}`, main, shown).catch((e) => (e.code === 1 ? null : Promise.reject(e)));
    if (!tree) return null;
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

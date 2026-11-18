// The local code host's git: hardened arguments, an isolated environment, the guarded clone and the landing of a change on
// main. The bare repositories here are the host's own, so nothing of the clone's config needs scrubbing.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DEFAULT_IDENTITY = { name: "AidenHQ agent", email: "agent@aidenhq.invalid" };
export const identityEnv = (who) => ({ GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });

// No external diff program and no repository named from outside; no replace refs, grafts or shallow file.
const ENV = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null" };
  for (const k of ["GIT_EXTERNAL_DIFF", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[k];
  return env;
};
export const ISOLATED_ENV = { ...ENV(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
// Hooks, fsmonitor and ext:: transports are off whatever a repository's config says; a bare repository is only used when named.
export const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];
const DIFFS = new Set(["diff", "log", "show"]);

export async function git(cwd, ...args) {
  let at = 0;
  while (args[at] === "-c") at += 2;
  const full = DIFFS.has(args[at]) ? [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)] : args;
  const { stdout } = await run("git", [...SAFE_GIT_ARGS, ...full], { cwd, maxBuffer: 32 * 1024 * 1024, env: ENV() });
  return stdout.trim();
}

/** Hooks dir whose pre-push always refuses: agents cannot push from task worktrees. */
function ensureGuardHooks(workDir) {
  const dir = join(workDir, ".guard-hooks");
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, "pre-push");
  writeFileSync(hook, '#!/bin/sh\necho "push blocked: AidenHQ task worktrees are local-only. Comment \\"push\\" on the task to publish the branch." >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return dir;
}

/** The host's own clone of org/repo from `source`, refreshed on every call, with pushing disabled at the repository level. */
export async function ensureClone(workDir, repo, source) {
  const path = join(workDir, "repos", repo.org, repo.name);
  const hooks = ensureGuardHooks(workDir);
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(join(workDir, "repos", repo.org), { recursive: true });
    await git(join(workDir, "repos", repo.org), "clone", "--quiet", source, path);
  } else {
    await git(path, "remote", "set-url", "origin", source);
  }
  await git(path, "fetch", "--quiet", "--prune", "origin");
  await git(path, "config", "remote.origin.pushurl", "DISABLED_BY_AIDENHQ");
  await git(path, "config", "core.hooksPath", hooks);
  return path;
}

/**
 * Lands exactly the commit `shown` on origin/<base>: its change (against its merge base with main) merged onto the current
 * main as one new commit with main as its parent, pushed as a fast-forward. If main moves during the push the merge is redone
 * once on the new main. A change main already has lands as nothing: main's sha, no push. Returns the sha main is at, or null
 * when the change conflicts with main.
 */
export async function landOnMain(path, base, shown, note, { guard, identity = DEFAULT_IDENTITY } = {}) {
  const iso = (...args) => run("git", [...SAFE_GIT_ARGS, ...args], { cwd: path, env: { ...ISOLATED_ENV, ...identityEnv(identity) } }).then((o) => o.stdout.trim());
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

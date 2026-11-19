// codehost-local's git: the hardened arguments and environment every command here runs with (repo code never runs: no hooks,
// no fsmonitor, no ext:: transport, no global or system config, literal pathspecs), where each `local/…` repo's bare git dir
// is, and how a job's commits come in (a bundle its box wrote: host git never runs in a workspace).
import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readSync, readlinkSync, realpathSync, rmSync, writeSync } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];
export const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1" };
/** The code host's own commits (a new repo's first commit, a squash merge): never the owner's identity. */
export const IDENTITY = { GIT_AUTHOR_NAME: "AidenHQ", GIT_AUTHOR_EMAIL: "agent@aidenhq.invalid", GIT_COMMITTER_NAME: "AidenHQ", GIT_COMMITTER_EMAIL: "agent@aidenhq.invalid" };
export const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const IDENT = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*@\{)[\w./-]{1,200}$/;

/** git in a bare repo (`--git-dir`), or anywhere with `-C`; stdout trimmed unless `raw`. */
export async function git(args: string[], o: { input?: string; env?: Record<string, string>; raw?: boolean; maxBuffer?: number } = {}): Promise<string> {
  const p = run("git", [...SAFE_GIT_ARGS, ...args], { env: { ...ENV, ...o.env }, maxBuffer: o.maxBuffer ?? 64 * 1024 * 1024 });
  if (o.input !== undefined) p.child.stdin!.end(o.input);
  const { stdout } = await p;
  return o.raw ? stdout : stdout.trim();
}

/**
 * Where `local/<name>`'s bare repo is: `sources` names a repo kept elsewhere (setup's instance repo, AIDENHQ_INSTANCE_REMOTE),
 * every other one is <root>/local/<name>.git. Throws on anything that isn't a plain local/<name>.
 */
export function bareOf(root: string, sources: Record<string, string>, repo: string): string {
  const [org, name, ...rest] = String(repo).split("/");
  if (rest.length || org?.toLowerCase() !== "local" || !SEGMENT.test(name ?? "") || name!.endsWith(".git") || /^\.+$/.test(name!)) throw fail(400, `not a repository on this server: ${repo}`);
  const slug = `local/${name}`.toLowerCase();
  const src = Object.entries(sources).find(([k]) => k.toLowerCase() === slug)?.[1];
  return src ?? join(root, "local", `${name}.git`);
}

/** Where the in-box `aidenhq` leaves a branch's bundle for the code host: <workspace>/.aidenhq/bundles/<sha>.bundle. */
export const bundlePath = (sha: string) => `.aidenhq/bundles/${sha}.bundle`;
const MAX_BUNDLE = 1 << 30;

/**
 * A job's branch at `sha`, fetched into the bare repo at refs/ws/<ident>/<branch>. Host git never touches the workspace: the
 * job's box wrote a `git bundle` of the branch (`aidenhq publish|apply`), and the kernel reads that one regular file (never
 * through a symlink, resolved after opening to a file inside that task's folder), copies it to its own scratch, verifies it
 * and fetches from it with every object checked. Throws unless the branch is at `sha`.
 */
export async function ingest(tasksDir: string, scratchDir: string, bare: string, ident: string, b: { repo: string; branch: string; sha: string }) {
  if (!IDENT.test(String(ident))) throw fail(400, `${ident} is not a task's workspace`);
  if (!BRANCH.test(String(b.branch))) throw fail(400, `${b.branch} is not a branch name`);
  if (!SHA.test(String(b.sha))) throw fail(400, "sha is a full commit sha");
  const task = join(realpathSync(tasksDir), ident);
  const inside = (p: string) => p.startsWith(task + sep);
  const at = join(task, bundlePath(b.sha));
  const scratch = mkdtempSync(join(scratchDir, "ingest-"));
  try {
    let fd: number;
    try { fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw fail(404, `task ${ident} has no bundle of ${b.repo} \`${b.branch}\` at ${b.sha.slice(0, 12)} (publish it with aidenhq)`); }
    const copy = join(scratch, "branch.bundle");
    try {
      // What was opened, not what the path says now: /proc's link where there is one.
      const opened = existsSync(`/proc/self/fd/${fd}`) ? readlinkSync(`/proc/self/fd/${fd}`) : realpathSync(at);
      const st = fstatSync(fd);
      if (!inside(opened) || !inside(realpathSync(at)) || !st.isFile() || st.size > MAX_BUNDLE) throw fail(400, `the bundle of ${b.repo} \`${b.branch}\` isn't a regular file inside task ${ident}`);
      const out = openSync(copy, "wx", 0o600), buf = Buffer.alloc(1 << 20);
      try { for (let n, total = 0; (n = readSync(fd, buf)) > 0; ) { if ((total += n) > MAX_BUNDLE) throw fail(413, "the bundle is too large"); writeSync(out, buf, 0, n); } } finally { closeSync(out); }
    } finally {
      closeSync(fd);
    }
    await git(["--git-dir", bare, "bundle", "verify", "--quiet", copy]).catch(() => { throw fail(400, `the bundle of ${b.repo} \`${b.branch}\` isn't a valid git bundle for it`); });
    await git(["--git-dir", bare, "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", copy, `+refs/heads/${b.branch}:${`refs/ws/${ident}/${b.branch}`}`]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const ref = `refs/ws/${ident}/${b.branch}`;
  const got = await git(["--git-dir", bare, "rev-parse", "--verify", `${ref}^{commit}`]);
  if (got !== b.sha) throw fail(409, `${b.repo} \`${b.branch}\` is at ${got.slice(0, 12)} in the bundle, not ${b.sha.slice(0, 12)}`);
  return ref;
}

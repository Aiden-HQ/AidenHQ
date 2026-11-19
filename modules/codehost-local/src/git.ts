// codehost-local's git: the hardened arguments and environment every command here runs with (repo code never runs: no hooks,
// no fsmonitor, no ext:: transport, no global or system config, literal pathspecs), where each `local/…` repo's bare git dir
// is, and how a job's commits come in from its workspace.
import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit", "-c", "safe.directory=*"];
export const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1" };
/** The code host's own commits (a new repo's first commit, a squash merge): never the owner's identity. */
export const IDENTITY = { GIT_AUTHOR_NAME: "AidenHQ", GIT_AUTHOR_EMAIL: "agent@aidenhq.invalid", GIT_COMMITTER_NAME: "AidenHQ", GIT_COMMITTER_EMAIL: "agent@aidenhq.invalid" };
export const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const IDENT = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
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

/**
 * A workspace .git the agent wrote: only plain files and directories (no symlink, fifo or device anywhere), the shape of a
 * clone's own gitdir, and nothing that points git elsewhere (commondir, alternates, http-alternates).
 */
function checkGitDir(at: string) {
  for (const f of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) if (lstatSync(join(at, f), { throwIfNoEntry: false })) throw fail(400, `the workspace's .git has ${f}; refusing it`);
  if (!lstatSync(join(at, "HEAD"), { throwIfNoEntry: false })?.isFile() || !lstatSync(join(at, "objects"), { throwIfNoEntry: false })?.isDirectory() || !lstatSync(join(at, "refs"), { throwIfNoEntry: false })?.isDirectory()) throw fail(400, "the workspace's .git isn't a clone's git directory");
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (!e.isFile()) throw fail(400, `the workspace's .git has ${join(dir, e.name).slice(at.length + 1)}, which isn't a plain file; refusing it`);
    }
  };
  walk(at);
}

/**
 * A job's branch at `sha`, fetched from its task workspace (<tasks>/<ident>/<name>/.git) into the bare repo at
 * refs/ws/<ident>/<branch>. Git never reads the workspace's own config or hooks: its refs, objects and HEAD are copied to a
 * scratch gitdir with an empty config and fetched from there, every object checked. Throws unless the branch is at `sha`.
 */
export async function ingest(tasksDir: string, scratchDir: string, bare: string, ident: string, b: { repo: string; branch: string; sha: string }) {
  if (!IDENT.test(String(ident))) throw fail(400, `${ident} is not a task's workspace`);
  if (!BRANCH.test(String(b.branch))) throw fail(400, `${b.branch} is not a branch name`);
  const root = realpathSync(tasksDir), name = b.repo.split("/")[1]!;
  const at = [name, `local--${name}`].map((d) => join(root, ident, d, ".git")).find((p) => existsSync(p));
  if (!at) throw fail(404, `task ${ident} has no clone of ${b.repo}`);
  for (const p of [join(root, ident), join(at, ".."), at]) if (lstatSync(p).isSymbolicLink() || !lstatSync(p).isDirectory()) throw fail(400, `${p.slice(root.length + 1)} isn't a plain directory`);
  checkGitDir(at);
  const ref = `refs/ws/${ident}/${b.branch}`;
  const scratch = mkdtempSync(join(scratchDir, "ingest-"));
  try {
    for (const f of ["HEAD", "packed-refs", "objects", "refs"]) if (existsSync(join(at, f))) cpSync(join(at, f), join(scratch, f), { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(scratch, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n");
    checkGitDir(scratch); // again on the copy: nothing changed between the check and the copy
    await git(["--git-dir", bare, "-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", scratch, `+refs/heads/${b.branch}:${ref}`]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const got = await git(["--git-dir", bare, "rev-parse", "--verify", `${ref}^{commit}`]);
  if (got !== b.sha) throw fail(409, `${b.repo} \`${b.branch}\` is at ${got.slice(0, 12)} in the workspace, not ${b.sha.slice(0, 12)}`);
  return ref;
}

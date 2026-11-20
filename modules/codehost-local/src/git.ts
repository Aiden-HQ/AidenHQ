// codehost-local's git: the hardened arguments and environment every command here runs with (repo code never runs: no hooks,
// no fsmonitor, no ext:: transport, no global or system config, literal pathspecs), where each `local/…` repo's bare git dir
// is, and how a job's commits come in (a bundle its box wrote: host git never runs in a workspace).
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { copyBoxBundle } from "../../../kernel/sdk/src/box-bundle.ts";

const run = promisify(execFile);
export const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];
export const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1" };
/** The code host's own commits (a new repo's first commit, a squash merge): never the owner's identity. */
export const IDENTITY = { GIT_AUTHOR_NAME: "AidenHQ", GIT_AUTHOR_EMAIL: "agent@aidenhq.invalid", GIT_COMMITTER_NAME: "AidenHQ", GIT_COMMITTER_EMAIL: "agent@aidenhq.invalid" };
export const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
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
 * A job's branch at `sha`, fetched into the bare repo at refs/ws/<ident>/<branch>. Host git never touches the workspace: the
 * job's box wrote a `git bundle` of the branch (`aidenhq publish|apply`), copied out of it the one no-follow way
 * (kernel/sdk/src/box-bundle.ts), verified and fetched from with every object checked. Throws unless the branch is at `sha`.
 */
export async function ingest(tasksDir: string, scratchDir: string, bare: string, ident: string, b: { repo: string; branch: string; sha: string }) {
  if (!BRANCH.test(String(b.branch))) throw fail(400, `${b.branch} is not a branch name`);
  const scratch = mkdtempSync(join(scratchDir, "ingest-"));
  try {
    const copy = copyBoxBundle(tasksDir, scratch, ident, b.sha, `${b.repo} \`${b.branch}\``);
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

// codehost-local's snapshot op: the same contract as codehost-github's /ops/snapshot (a tar.gz of the tree at a commit, no .git
// and no credentials, the commit it is of in `x-aidenhq-commit`), read from the org `local`'s bare repos under
// <data dir>/codehost/<org>/<name>.git. The kernel's code host broker (kernel/src/codehost.ts) picks it for `local/…` repos, as
// kernel/src/apply.ts picks apply.ts. Repo code never runs: SAFE_GIT_ARGS, no global config, `git archive` only.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const run = promisify(execFile);
const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1" };
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const SHA = /^[0-9a-f]{40}$/;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** The answer shape the broker hands back for any code host: a tarball stream with its status and headers. */
export type Tarball = Readable & { statusCode: number; headers: Record<string, string> };

/** `root`: the folder of the org folders (<data dir>/codehost). `repo` is local/<name>; `ref` is a commit sha, HEAD or a branch. */
export function localSnapshot({ root }: { root: string }) {
  return async (repo: string, ref: string): Promise<Tarball> => {
    const [org, name, ...rest] = repo.split("/");
    if (rest.length || !SEGMENT.test(org ?? "") || !SEGMENT.test(name ?? "") || name!.endsWith(".git") || /^\.+$/.test(name!)) throw fail(400, `not a repository: ${repo}`);
    const dir = join(root, org!, `${name}.git`);
    if (!existsSync(join(dir, "HEAD"))) throw fail(404, `${repo} isn't on this server`);
    const git = (...args: string[]) => ({ args: [...SAFE_GIT_ARGS, "--git-dir", dir, ...args], opts: { env: ENV } });
    const want = SHA.test(ref) || ref === "HEAD" ? ref : `refs/heads/${ref}`;
    const g = git("rev-parse", "--verify", "--quiet", "--end-of-options", `${want}^{commit}`);
    const commit = (await run("git", g.args, g.opts).catch(() => ({ stdout: "" }))).stdout.trim();
    if (!commit) throw fail(404, `${ref.slice(0, 100)} isn't a commit of ${repo}`);
    const a = git("archive", "--format=tar.gz", commit);
    const p = spawn("git", a.args, { ...a.opts, stdio: ["ignore", "pipe", "ignore"] });
    return Object.assign(p.stdout, { statusCode: 200, headers: { "content-type": "application/gzip", "x-aidenhq-commit": commit } });
  };
}

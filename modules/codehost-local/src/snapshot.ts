// codehost-local's snapshot op: the same contract as codehost-github's /ops/snapshot (a tar.gz of the tree at a commit, no .git
// and no credentials, the commit it is of in `x-aidenhq-commit`), read from the org `local`'s bare repos (git.ts bareOf). The
// kernel's code host broker (kernel/src/codehost.ts) picks it for `local/…` repos. Repo code never runs: `git archive` only.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { ENV, SAFE_GIT_ARGS, fail, git } from "./git.ts";

const SHA = /^[0-9a-f]{40}$/;

/** The answer shape the broker hands back for any code host: a tarball stream with its status and headers. */
export type Tarball = Readable & { statusCode: number; headers: Record<string, string> };

/** `bare`: where a local/<name> repo's bare git dir is (host.ts's). `ref` is a commit sha, HEAD or a branch. */
export function localSnapshot({ bare }: { bare: (repo: string) => string }) {
  return async (repo: string, ref: string): Promise<Tarball> => {
    const dir = bare(repo);
    if (!existsSync(join(dir, "HEAD"))) throw fail(404, `${repo} isn't on this server`);
    const want = SHA.test(ref) || ref === "HEAD" ? ref : `refs/heads/${ref}`;
    const commit = await git(["--git-dir", dir, "rev-parse", "--verify", "--quiet", "--end-of-options", `${want}^{commit}`]).catch(() => "");
    if (!commit) throw fail(404, `${ref.slice(0, 100)} isn't a commit of ${repo}`);
    const p = spawn("git", [...SAFE_GIT_ARGS, "--git-dir", dir, "archive", "--format=tar.gz", commit], { env: ENV, stdio: ["ignore", "pipe", "ignore"] });
    return Object.assign(p.stdout, { statusCode: 200, headers: { "content-type": "application/gzip", "x-aidenhq-commit": commit } });
  };
}

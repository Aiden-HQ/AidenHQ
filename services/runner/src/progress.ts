// A brief naming a commit or branch that no workspace repository has never starts a job (the job watcher's progress stop is
// the kernel's: kernel/src/progress.ts).
import { git as taskGit } from "./git.mjs";

/** The commits and branches a brief names: `abc1234` after "commit"/"sha", or `branch` after "on/from/onto branch". */
export function namedRefs(text: string): { shas: string[]; branches: string[] } {
  const shas = [...text.matchAll(/\b(?:commit|sha|revision|rev)s?\s*[:=]?\s*`?([0-9a-f]{7,40})\b/gi)].map((m) => String(m[1]).toLowerCase());
  const branches = [...text.matchAll(/\b(?:on|from|onto|off|of)\s+(?:the\s+)?branch\s+`([^`\s]+)`/gi)].map((m) => String(m[1]));
  return { shas: [...new Set(shas)], branches: [...new Set(branches)] };
}

// The repositories are an agent's clones and the refs come from a brief: every call goes through git.mjs's hardened git
// (no hooks or clone config, ceiling dirs), after refs are checked to be plain names, and operands follow `--`.
const git = (cwd: string, ...args: string[]) => taskGit(cwd, ...args).then(() => true, () => false);

/** The first commit or branch the brief names that none of these repositories (paths) has (or that isn't a plain name), as one line; "" when all exist. */
export async function staleRef(text: string, paths: string[]): Promise<string> {
  const { shas, branches } = namedRefs(text);
  const where = paths.length > 1 ? "any of the task's repositories" : "the repository";
  const anywhere = async (ok: (p: string) => Promise<boolean>) => {
    for (const p of paths) if (await ok(p)) return true;
    return false;
  };
  for (const sha of shas) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return `the brief names \`${sha}\`, which isn't a commit id`;
    if (!(await anywhere((p) => git(p, "cat-file", "-e", `${sha}^{commit}`).then((ok) => ok || git(p, "fetch", "-q", "origin", "--", sha))))) return `the brief names commit \`${sha}\`, which isn't in ${where}`;
  }
  for (const b of branches) {
    if (b.startsWith("-") || !paths[0] || !(await git(paths[0], "check-ref-format", "--branch", b))) return `the brief names \`${b}\`, which isn't a branch name`;
    const has = (p: string) => git(p, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`).then((ok) => ok || git(p, "ls-remote", "--exit-code", "--heads", "origin", "--", b));
    if (!(await anywhere(has))) return `the brief names branch \`${b}\`, which doesn't exist in ${where}`;
  }
  return "";
}

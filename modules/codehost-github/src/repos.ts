// Push access for repos no GitHub App covers: before the runner's first approved push to a repo it gets a write deploy key
// (ops/vm/add-deploy-key.sh). The admin token lives in the vault, never in an agent's sandbox. No token: a no-op. It never
// creates a repo: a new app's repo is created only in the agents org, on an approved create_repo card (github-app.ts).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Runs a command and returns its stdout; a failed command returns what it printed before failing. */
export type Shell = (cmd: string, args: string[]) => Promise<string>;

export const shell = (token: string | undefined): Shell => async (cmd, args) => (await run(cmd, args, { env: { ...process.env, GH_TOKEN: token }, maxBuffer: 1024 * 1024 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }))).stdout;

export function repoAccess({ token, script, sh = shell(token) }: { token?: string; script: string; sh?: Shell }) {
  return {
    /** A write deploy key and push route for this repo, unless it already has one. */
    async ensureWritable(slug: string): Promise<void> {
      if (!token) return;
      const routes = await sh("git", ["config", "--global", "--get-regexp", "pushinsteadof"]);
      if (routes.toLowerCase().includes(`:${slug.toLowerCase()}.pushinsteadof`)) return;
      await sh("bash", [script, slug]);
    },
  };
}

/**
 * Normalize "org/repo", "https://github.com/org/repo(.git)", "git@github.com:org/repo.git", or any
 * of these as Paperclip stores them: Markdown links ("[url](url)"), "<url>", backslash escapes.
 */
export function normalizeRepo(value: unknown): { org: string; name: string; slug: string } | undefined {
  const text = String(value ?? "")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$2") // [text](url) → url
    .replace(/\\(.)/g, "$1") // \_ → _
    .replace(/[<>`]/g, " ")
    .trim();
  const m =
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/#?\s)]|$)/.exec(text) ??
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/#?\s]|$)/.exec(text);
  if (!m) return undefined;
  return { org: m[1]!, name: m[2]!, slug: `${m[1]}/${m[2]}` };
}

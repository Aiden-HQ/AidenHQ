// Push access for repos no GitHub App covers: before the runner's first approved push to a repo it gets a write deploy key
// (ops/vm/add-deploy-key.sh). The admin token lives in the vault, never in an agent's sandbox. No token: a no-op. It never
// creates a repo: a new app's repo is created only in the agents org, on an approved create_repo card (github-app.mjs).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const shell = (token) => async (cmd, args) => (await run(cmd, args, { env: { ...process.env, GH_TOKEN: token }, maxBuffer: 1024 * 1024 }).catch((e) => ({ stdout: e.stdout ?? "" }))).stdout;

export function repoAccess({ token, script, sh = shell(token) }) {
  return {
    /** A write deploy key and push route for this repo, unless it already has one. */
    async ensureWritable(slug) {
      if (!token) return;
      const routes = await sh("git", ["config", "--global", "--get-regexp", "pushinsteadof"]);
      if (routes.toLowerCase().includes(`:${slug.toLowerCase()}.pushinsteadof`)) return;
      await sh("bash", [script, slug]);
    },
  };
}

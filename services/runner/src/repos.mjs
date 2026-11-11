// New repos without the owner's hands: a repo a task names that doesn't exist yet is created (private, in the admin
// token's own account only), and before the runner's first approved push to a repo it gets a write deploy key
// (ops/vm/add-deploy-key.sh). The admin token lives in the vault, never in an agent's sandbox. No token: both no-ops.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** GitHub REST with the admin token: { status, body }. */
export function githubApi(token) {
  return async (method, path, body) => {
    const r = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

export const shell = (token) => async (cmd, args) => (await run(cmd, args, { env: { ...process.env, GH_TOKEN: token }, maxBuffer: 1024 * 1024 }).catch((e) => ({ stdout: e.stdout ?? "" }))).stdout;

export function repoAccess({ token, script, api = githubApi(token), sh = shell(token) }) {
  let owner;
  return {
    /** "exists" | "created" | "missing" (not ours to create) | "unknown" (no token). */
    async ensureExists(slug) {
      if (!token) return "unknown";
      const [org, name] = slug.split("/");
      if ((await api("GET", `/repos/${slug}`)).status === 200) return "exists";
      owner ??= (await api("GET", "/user")).body?.login;
      if (!owner || owner.toLowerCase() !== org.toLowerCase()) return "missing";
      const r = await api("POST", "/user/repos", { name, private: true, auto_init: true });
      if (r.status !== 201) throw new Error(`couldn't create ${slug}: GitHub said ${r.status} ${r.body?.message ?? ""}`.trim());
      return "created";
    },
    /** A write deploy key and push route for this repo, unless it already has one. */
    async ensureWritable(slug) {
      if (!token) return;
      const routes = await sh("git", ["config", "--global", "--get-regexp", "pushinsteadof"]);
      if (routes.toLowerCase().includes(`:${slug.toLowerCase()}.pushinsteadof`)) return;
      await sh("bash", [script, slug]);
    },
  };
}

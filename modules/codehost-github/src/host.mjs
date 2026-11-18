// The code host role (docs/design/codehost-local.md §2): what the runner calls for a repository, whichever provider hosts
// it. Each provider (codehost-github, codehost-local) exports `host(deps)` returning this shape; the runner resolves a slug
// to its provider once (hostOf) by its org, and every write and read goes through that object.
//
//   orgs                                   the orgs this provider owns (GitHub: [] = every org another provider doesn't own)
//   source(slug)                → string   where the runner's cache clone fetches from (a URL or a local path)
//   exists(slug)                → boolean
//   defaultBranch(slug)         → string
//   publish({ path, slug, sha, branch, lease })   push `sha` from the clone at `path` to refs/heads/<branch> (lease: the
//                                          sha it may replace, force-with-lease; absent: fast-forward only)
//   openChange({ slug, branch, base, title, body, path }) → { number, url }   a draft PR / a change request
//   readChange(slug, n)         → { state: "open"|"merged"|"closed", head, base, branch, files, title, body }
//   checks(slug, sha)           → [{ name, ok, pending, skipped }]   the named checks on that exact commit (plan.mjs reads them)
//   merge(slug, n, head)        → { sha }  squash-merges change n only while its head is `head`
//   close(slug, n)
//   createRepo(slug)            → "created" | "exists"
//   diff(slug, n)               → string   base...head
//
// GitHub's implementation wraps today's runner code: the App (github-app.ts) when an installation covers the repo, else the
// host's gh login and the git@github.com remote; merges keep the merge gate (merge-gate.mjs, injected as `mergeGate`).
import { appRemoteUrl } from "./github-app.ts";

const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/**
 * deps: { appFor(slug) → the App client or undefined, gh(slug, write, args, { cwd }) → stdout (the real gh with the right
 * token), git(cwd, ...args) → stdout, mergeGate(slug, n, head) → { sha }, repoSources: { slug: path } }.
 */
export function host({ appFor = async () => undefined, gh, git, mergeGate, repoSources = {} } = {}) {
  const json = async (slug, args, write = false, opts) => JSON.parse(await gh(slug, write, args, opts));
  return {
    name: "codehost-github",
    orgs: [],
    async source(slug) {
      return repoSources[slug] ?? ((await appFor(slug)) ? appRemoteUrl(slug) : `git@github.com:${slug}.git`);
    },
    async exists(slug) {
      const app = await appFor(slug);
      if (app) return app.repoExists(slug);
      return gh(slug, false, ["api", `repos/${slug}`, "--jq", ".full_name"]).then((o) => Boolean(String(o).trim()), () => false);
    },
    async defaultBranch(slug) {
      const name = String(await gh(slug, false, ["api", `repos/${slug}`, "--jq", ".default_branch"])).trim();
      if (!BRANCH_NAME.test(name)) throw new Error("no default branch");
      return name;
    },
    async publish({ path, slug, sha, branch, lease }) {
      const url = (await appFor(slug)) ? appRemoteUrl(slug) : await git(path, "remote", "get-url", "origin");
      await git(path, "push", "--no-verify", ...(lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : []), url, `${sha}:refs/heads/${branch}`);
    },
    async openChange({ slug, branch, base, title, body, path }) {
      const url = String(await gh(slug, true, ["pr", "create", "--draft", "--repo", slug, "--head", branch, "--base", base, "--title", title, "--body", body], { cwd: path })).trim().split("\n").pop();
      return { number: Number(url.split("/").pop()), url };
    },
    async readChange(slug, n) {
      const pr = await json(slug, ["pr", "view", String(n), "--repo", slug, "--json", "state,headRefOid,baseRefOid,headRefName,files,title,body"]);
      return { state: String(pr.state).toLowerCase(), head: pr.headRefOid, base: pr.baseRefOid, branch: pr.headRefName, files: (pr.files ?? []).map((f) => f.path), title: pr.title, body: pr.body };
    },
    async checks(slug, sha) {
      const runs = await json(slug, ["api", `repos/${slug}/commits/${sha}/check-runs?per_page=100`]);
      return (runs.check_runs ?? []).map((c) => ({ name: c.name, ok: ["success", "neutral", "skipped"].includes(c.conclusion), pending: c.status !== "completed", skipped: c.conclusion === "skipped" }));
    },
    merge: (slug, n, head) => mergeGate(slug, n, head),
    async close(slug, n) {
      await gh(slug, true, ["pr", "close", String(n), "--repo", slug]);
    },
    async createRepo(slug) {
      const app = await appFor(slug);
      if (!app) throw new Error(`no GitHub App installation covers ${slug.split("/")[0]}`);
      return app.createRepo(slug);
    },
    diff: (slug, n) => gh(slug, false, ["pr", "diff", String(n), "--repo", slug]),
  };
}

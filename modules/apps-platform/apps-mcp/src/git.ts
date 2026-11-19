import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { type RepoToken, withGitToken } from "./github-app.js";
import type { App } from "./registry.js";
import { isLocal, localRepo } from "./codehost.js";

const run = promisify(execFile);

export interface GitEnv {
  appsData: string;
  gitDir: string; // bare repos, outside appsData: an app can write anywhere it may mount, so it must never reach a .git
  tokenFile?: string;
  sshCommand?: string;
  orgs?: string[]; // GitHub orgs/users apps may be built from (setting github_orgs), besides the agents org
  agentsOrg?: string; // the instance's agents org: always allowed; its repos are read with the GitHub App when appToken is set
  appToken?: RepoToken;
  productDir?: string; // the host's product checkout (REPO_DIR): module apps are fetched from it, never from GitHub
  localRoot?: string; // this server's repos (codehost-local), mounted read-only: `local/*` apps are fetched from there
}

// The read-only token travels as an HTTP header for this process only: it never lands in a URL, .git/config or error text.
function auth(env: GitEnv): NodeJS.ProcessEnv {
  const token = env.tokenFile ? readFileSync(env.tokenFile, "utf8").trim() : "";
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` } : {}) };
}

export const inAgentsOrg = (env: GitEnv, repo: string) => !!env.agentsOrg && repo.split("/")[0]!.toLowerCase() === env.agentsOrg.toLowerCase();

type Cmd = { args: string[]; env: NodeJS.ProcessEnv };
const plain = (env: GitEnv, args: string[], extra: NodeJS.ProcessEnv = {}): Cmd => ({ args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], env: { ...auth(env), ...extra } });

async function runGit(cmd: Cmd | Promise<Cmd>, label: string[], cwd?: string): Promise<string> {
  try {
    const c = await cmd;
    return (await run("git", c.args, { cwd, env: c.env, maxBuffer: 20e6, timeout: 300_000 })).stdout.trim();
  } catch (err: any) {
    throw Object.assign(new Error(`git ${label.find((a) => !a.startsWith("-"))} failed: ${String(err.stderr ?? err.message).trim().slice(-400)}`), { code: err.code });
  }
}

const inOrgs = (env: GitEnv, repo: string) => (env.orgs ?? []).some((o) => o.toLowerCase() === repo.split("/")[0]!.toLowerCase());

/** git with the read-only token; for an agents-org `app` with the GitHub App on, a repo-narrowed App token instead. */
function git(env: GitEnv, args: string[], cwd?: string, extra: NodeJS.ProcessEnv = {}, app?: App): Promise<string> {
  const viaApp = app && env.appToken && inAgentsOrg(env, app.repo);
  const cmd = viaApp
    ? env.appToken!(app.repo).then((t) => withGitToken(args, { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extra }, t)) // no PAT header: it would shadow the helper
    : plain(env, args, extra);
  return runGit(cmd, args, cwd);
}

export function checkOrg(env: GitEnv, app: App): void {
  if (!app.untrusted && !inOrgs(env, app.repo) && !inAgentsOrg(env, app.repo) && !isLocal(env.localRoot, app.repo)) throw new Error(`repo ${app.repo} is outside the allowed orgs; only untrusted apps may use it`);
}

/**
 * Where the app's code is fetched from: its bare repo on this server for `local/*` (the read-only mount; its owner trusted
 * for that one repo), else GitHub. `pre`: the git options a fetch from there needs.
 */
const source = (env: GitEnv, app: App): { url: string; pre: string[] } => {
  if (!isLocal(env.localRoot, app.repo)) return { url: `https://github.com/${app.repo}.git`, pre: [] };
  const bare = localRepo(env.localRoot!, app.repo);
  return { url: bare, pre: ["-c", `safe.directory=${bare}`] };
};

/** Latest commit of the app's branch on origin; a module app's head is its product pin. */
export async function remoteHead(env: GitEnv, app: App): Promise<string> {
  if (app.pin) return app.pin;
  const s = source(env, app);
  const out = await git(env, [...s.pre, "ls-remote", s.url, `refs/heads/${app.branch}`], undefined, {}, app);
  const sha = out.split(/\s/)[0];
  if (!sha) throw new Error(`branch ${app.branch} not found in ${app.repo}`);
  return sha;
}

/**
 * The app's bare repo (created on first use), fetched up to date; returns its --git-dir arg. A module app's source is the
 * product commit the instance pins, which the host's product checkout already holds: its origin/<branch> is copied from
 * there (apply-config fetched it from GitHub and refused a pin not on it), so the reachability check below still means
 * "on the product's origin/<branch>", and no token is needed for the product repo.
 */
async function fetchAll(env: GitEnv, app: App): Promise<string> {
  const gd = `--git-dir=${env.gitDir}/${app.name}.git`;
  if (!existsSync(`${env.gitDir}/${app.name}.git`)) {
    mkdirSync(env.gitDir, { recursive: true });
    await git(env, ["init", "--bare", "-q", `${env.gitDir}/${app.name}.git`]);
  }
  if (app.module && env.productDir) await git(env, [gd, "fetch", "--prune", env.productDir, `+refs/remotes/origin/${app.branch}:refs/remotes/origin/${app.branch}`]);
  else await git(env, [...source(env, app).pre, gd, "fetch", "--prune", source(env, app).url, "+refs/heads/*:refs/remotes/origin/*"], undefined, {}, app);
  return gd;
}

/**
 * origin/<branch> again, straight from the app's own origin: fetchAll's copy can come from a host checkout that has not
 * fetched since a merge, while GitHub has the commit. Only refs/heads/<branch> is copied, so it can add history but never
 * make a commit reachable that origin/<branch> doesn't have.
 */
const fetchBranch = (env: GitEnv, app: App, gd: string): Promise<string> =>
  git(env, [...source(env, app).pre, gd, "fetch", "--prune", source(env, app).url, `+refs/heads/${app.branch}:refs/remotes/origin/${app.branch}`], undefined, {}, app);

/** From what fetchAll brought; when that doesn't hold (a checkout that lags origin), origin/<branch> once from the app's own origin, then once again. */
async function fromOrigin<T>(env: GitEnv, app: App, gd: string, find: () => Promise<T>): Promise<T> {
  // A fetch that can't run (no access, offline) leaves find()'s own error to be thrown.
  return find().catch(async () => (await fetchBranch(env, app, gd).catch(() => ""), find()));
}

/** Checks the app out at sha (default: its pin, else head of origin/<branch>), refusing commits not reachable from origin/<branch>. */
export async function checkout(env: GitEnv, app: App, sha?: string): Promise<{ sha: string; dir: string }> {
  checkOrg(env, app);
  if (sha && !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("sha must be 7-40 hex characters");
  const gd = await fetchAll(env, app);
  const full = await fromOrigin(env, app, gd, async () => {
    const full = await git(env, [gd, "rev-parse", "--verify", `${sha ?? app.pin ?? `origin/${app.branch}`}^{commit}`]);
    try {
      await git(env, [gd, "merge-base", "--is-ancestor", full, `origin/${app.branch}`]);
    } catch {
      throw new Error(`commit ${full.slice(0, 8)} is not reachable from origin/${app.branch}`);
    }
    return full;
  });
  return { sha: full, dir: await workTree(env, app, gd, full) };
}

/** The app's platform-only checkout of `full`: into a fresh dir, then renamed into place, so nothing pre-existing is followed. */
async function workTree(env: GitEnv, app: App, gd: string, full: string): Promise<string> {
  const dir = `${env.appsData}/.platform/${app.name}/src`; // platform-only: apps can mount their data dir, never this
  const tmp = `${dir}.new`;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(`${env.gitDir}/${app.name}.git/index`, { force: true }); // no index, so every file is written
  mkdirSync(tmp, { recursive: true });
  await git(env, [gd, `--work-tree=${tmp}`, "checkout", "--force", "--detach", full]);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}

/**
 * A pull request's preview (previews.ts) at `sha`, which must be the head GitHub has for refs/pull/<n>/head right now (a
 * local change request's: refs/changes/<n>/head in its bare repo on this server). Its
 * own bare repo (the preview's name), so it never races the parent's deploys; only that ref is fetched and no branch name
 * ever reaches git.
 */
export async function checkoutPr(env: GitEnv, app: App, sha: string): Promise<{ sha: string; dir: string }> {
  checkOrg(env, app);
  if (!app.preview || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("a preview checks out one PR head by its full sha");
  const bare = `${env.gitDir}/${app.name}.git`;
  if (!existsSync(bare)) {
    mkdirSync(env.gitDir, { recursive: true });
    await git(env, ["init", "--bare", "-q", bare]);
  }
  const gd = `--git-dir=${bare}`;
  const s = source(env, app);
  const ref = isLocal(env.localRoot, app.repo) ? `refs/changes/${app.preview.pr}/head` : `refs/pull/${app.preview.pr}/head`;
  await git(env, [...s.pre, gd, "fetch", s.url, `+${ref}:refs/remotes/pr/head`], undefined, {}, app);
  const head = await git(env, [gd, "rev-parse", "--verify", "refs/remotes/pr/head^{commit}"]);
  if (head !== sha) throw new Error(`PR #${app.preview.pr} moved to ${head.slice(0, 8)}`);
  return { sha, dir: await workTree(env, app, gd, sha) };
}

/** A deployed commit's full message, from the app's bare repo (its deploy fetched it). Read by code only, never shown. */
export async function commitMessage(env: GitEnv, app: App, sha: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("sha must be 40 hex characters");
  return git(env, [`--git-dir=${env.gitDir}/${app.name}.git`, "log", "-1", "--format=%B", sha]);
}

/** The full sha and subject of a commit on origin/<branch> (what an approval card names); throws if unknown or off-branch. */
export async function resolveCommit(env: GitEnv, app: App, sha: string): Promise<{ sha: string; subject: string }> {
  checkOrg(env, app);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("sha must be 7-40 hex characters");
  const gd = await fetchAll(env, app);
  const find = async (): Promise<{ sha: string; subject: string }> => {
    const full = await git(env, [gd, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).catch(() => "");
    if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`no single commit ${sha} in ${app.repo}`);
    await git(env, [gd, "merge-base", "--is-ancestor", full, `origin/${app.branch}`]).catch(() => {
      throw new Error(`commit ${full.slice(0, 12)} is not on origin/${app.branch}`);
    });
    return { sha: full, subject: await git(env, [gd, "log", "-1", "--format=%s", full]) };
  };
  return fromOrigin(env, app, gd, find);
}

/**
 * What a deploy changes (the deploy card's diff, read for destructive migrations and by the reviewer): the diff from
 * the running commit (or the empty tree, for a first deploy) to `sha`, in the bare repo resolveCommit fetched. Capped.
 */
export async function diffSince(env: GitEnv, app: App, from: string | undefined, sha: string, max = 60_000): Promise<{ diff: string; truncated: boolean }> {
  return diffRange(env, app, from, sha, max);
}

/**
 * What deploying `sha` changes: the same diff as diffSince, limited to the app's own directory — the only thing the
 * deploy rebuilds (deploy.ts builds from `${checkout}/${app.path}`), so a repo-wide change elsewhere must not decide
 * whether the card can be reviewed. Same cap and `truncated` meaning, so an over-cap app change is still refused.
 */
export async function diffForDeploy(env: GitEnv, app: App, from: string | undefined, sha: string, max = 60_000): Promise<{ diff: string; truncated: boolean }> {
  // Anchored at the repo root and literal, so the app's path is taken as it is, whatever the process's cwd.
  return diffRange(env, app, from, sha, max, [app.path === "." ? ":(top)" : `:(top,literal)${app.path}`]);
}

async function diffRange(env: GitEnv, app: App, from: string | undefined, sha: string, max: number, paths: string[] = []): Promise<{ diff: string; truncated: boolean }> {
  const base = from && /^[0-9a-f]{40}$/.test(from) ? from : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const diff = await git(env, [`--git-dir=${env.gitDir}/${app.name}.git`, "-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", base, sha, ...(paths.length ? ["--", ...paths] : [])]);
  return { diff: diff.slice(0, max), truncated: diff.length > max };
}

/** A file of the app at a commit, read from the bare repo (never the work tree); undefined if absent. */
export const show = (env: GitEnv, app: App, sha: string, path: string): Promise<string | undefined> =>
  git(env, [`--git-dir=${env.gitDir}/${app.name}.git`, "show", `${sha}:${path}`]).then((s) => s, () => undefined);

const registrySlug = (url: string) => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];

/**
 * The registry (instance repo) fetch or push, in apps-mcp's own clone (never the apply's checkout). An https github.com URL
 * with the GitHub App on: from/to that URL, with a token narrowed to that repo (contents read to fetch, write to push)
 * through the hardened helper. Otherwise the URL as it is, over SSH with the deploy key.
 */
export async function registryCmd(env: GitEnv, op: "fetch" | "push", url: string): Promise<Cmd> {
  const slug = registrySlug(url);
  const args = op === "fetch" ? ["fetch", url, "main"] : ["push", url, "HEAD:main"];
  if (slug && env.appToken) return withGitToken(args, { ...process.env, GIT_TERMINAL_PROMPT: "0" }, await env.appToken(slug, op === "push" ? "write" : "read"));
  return plain(env, args, env.sshCommand ? { GIT_SSH_COMMAND: env.sshCommand } : {});
}

/** The registry clone at the instance's origin/main, exactly (created on first use; local changes are discarded). */
export async function syncRegistry(env: GitEnv, dir: string, url: string): Promise<void> {
  if (!existsSync(`${dir}/.git`)) {
    mkdirSync(dir, { recursive: true });
    await git(env, ["init", "-q", dir]);
  }
  await runGit(registryCmd(env, "fetch", url), ["fetch"], dir);
  await git(env, ["reset", "-q", "--hard", "FETCH_HEAD"], dir);
}

/** Commits one file of the registry clone and pushes it to main (registryCmd); the clone was synced just before the edit. */
export async function commitPush(env: GitEnv, repoDir: string, file: string, message: string, pushUrl: string): Promise<void> {
  await git(env, ["add", file], repoDir);
  await git(env, ["-c", "user.name=apps-mcp", "-c", "user.email=apps-mcp@agents.local", "commit", "-m", message, "--", file], repoDir);
  await runGit(registryCmd(env, "push", pushUrl), ["push"], repoDir);
}

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import type { App } from "./registry.js";
import { type CodeHostOps, isLocal, localRepo } from "./codehost.js";

const run = promisify(execFile);

export interface GitEnv {
  appsData: string;
  gitDir: string; // bare repos, outside appsData: an app can write anywhere it may mount, so it must never reach a .git
  sshCommand?: string;
  orgs?: string[]; // GitHub orgs/users apps may be built from (setting github_orgs), besides the fleet org
  agentsOrg?: string; // the fleet org (setting github_fleet_org, else the compiled catalog's repos.fleet_org): always allowed; its repos are fetched through the code host's fetch op
  ops?: CodeHostOps;
  productDir?: string; // the host's product checkout (REPO_DIR): module apps are fetched from it, never from GitHub
  localRoot?: string; // this server's repos (codehost-local), mounted read-only: `local/*` apps are fetched from there
}

export const inAgentsOrg = (env: GitEnv, repo: string) => !!env.agentsOrg && repo.split("/")[0]!.toLowerCase() === env.agentsOrg.toLowerCase();

type Cmd = { args: string[]; env: NodeJS.ProcessEnv };
const plain = (args: string[], extra: NodeJS.ProcessEnv = {}): Cmd => ({ args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extra } });

async function runGit(cmd: Cmd | Promise<Cmd>, label: string[], cwd?: string): Promise<string> {
  try {
    const c = await cmd;
    return (await run("git", c.args, { cwd, env: c.env, maxBuffer: 20e6, timeout: 300_000 })).stdout.trim();
  } catch (err: any) {
    throw Object.assign(new Error(`git ${label.find((a) => !a.startsWith("-"))} failed: ${String(err.stderr ?? err.message).trim().slice(-400)}`), { code: err.code });
  }
}

const inOrgs = (env: GitEnv, repo: string) => (env.orgs ?? []).some((o) => o.toLowerCase() === repo.split("/")[0]!.toLowerCase());

/** git, with no credentials: GitHub repos of the fleet org, github_orgs and the registry come through the code host's ops instead. */
function git(args: string[], cwd?: string, extra: NodeJS.ProcessEnv = {}): Promise<string> {
  return runGit(plain(args, extra), args, cwd);
}

/** Whether `app`'s code comes through the code host's ops (a fleet-org GitHub repo, never a `local/*` one). */
// GitHub repos in the fleet org or the owner's listed orgs (github_orgs; private ones too) are read through the code host's ops.
const viaOps = (env: GitEnv, app: App): CodeHostOps | undefined => (env.ops && (inAgentsOrg(env, app.repo) || inOrgs(env, app.repo)) && !isLocal(env.localRoot, app.repo) ? env.ops : undefined);

/** The org allow-list (github_orgs, the fleet org, `local/*`) applies to apps built from GitHub. A module app's source is the host's own product checkout at the instance's pin (fetchAll), never a repo an agent or app chose: only the compiler sets `module`. */
export function checkOrg(env: GitEnv, app: App): void {
  if (app.module) return;
  if (!app.untrusted && !inOrgs(env, app.repo) && !inAgentsOrg(env, app.repo) && !isLocal(env.localRoot, app.repo)) throw new Error(`repo ${app.repo} is outside the allowed orgs; only untrusted apps may use it (add the org to github_orgs, or use the fleet org)`);
}

/**
 * A module app's source: the host's product checkout, at the commit the instance applied. Never GitHub, whatever its repo
 * says, and never a checkout this host doesn't have: a module app is part of the product, not a repo an agent registered.
 */
const productSource = (env: GitEnv, app: App): string => {
  if (!env.productDir) throw new Error(`${app.name} is a module app: its source is the host's product checkout, and none is configured (REPO_DIR)`);
  return env.productDir;
};

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
  if (app.module) throw new Error(`${app.name} is a module app without a pin: the compiler sets it on the product commit the instance applies`);
  const ops = viaOps(env, app);
  const s = source(env, app);
  const sha = ops ? await ops.head(app.repo, app.branch) : (await git([...s.pre, "ls-remote", s.url, `refs/heads/${app.branch}`])).split(/\s/)[0];
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
    await git(["init", "--bare", "-q", `${env.gitDir}/${app.name}.git`]);
  }
  if (app.module) await git([gd, "fetch", "--prune", productSource(env, app), `+refs/remotes/origin/${app.branch}:refs/remotes/origin/${app.branch}`]);
  else if (viaOps(env, app)) await env.ops!.fetch(app.repo, "refs/heads/*", `${env.gitDir}/${app.name}.git`);
  else await git([...source(env, app).pre, gd, "fetch", "--prune", source(env, app).url, "+refs/heads/*:refs/remotes/origin/*"]);
  return gd;
}

/**
 * origin/<branch> again, straight from the app's own origin: fetchAll's copy can come from a host checkout that has not
 * fetched since a merge, while GitHub has the commit. Only refs/heads/<branch> is copied, so it can add history but never
 * make a commit reachable that origin/<branch> doesn't have.
 */
const fetchBranch = async (env: GitEnv, app: App): Promise<void> => {
  // A module app comes from the product checkout too, never from app.repo: its repo is the compiled product_repo setting.
  if (app.module) return void (await git([`--git-dir=${env.gitDir}/${app.name}.git`, "fetch", "--prune", productSource(env, app), `+refs/remotes/origin/${app.branch}:refs/remotes/origin/${app.branch}`]));
  if (viaOps(env, app)) return env.ops!.fetch(app.repo, `refs/heads/${app.branch}`, `${env.gitDir}/${app.name}.git`);
  await git([...source(env, app).pre, `--git-dir=${env.gitDir}/${app.name}.git`, "fetch", "--prune", source(env, app).url, `+refs/heads/${app.branch}:refs/remotes/origin/${app.branch}`]);
};

/**
 * What a commit must be reachable from: a module app's applied product pin, so a deploy or rollback stays at or below the
 * product commit this host applied and never runs code the instance hasn't applied; any other app's origin/<branch>.
 */
function ceiling(env: GitEnv, app: App): string {
  if (!app.module) return `origin/${app.branch}`;
  if (!app.pin) throw new Error(`${app.name} is a module app without a pin: the compiler sets it on the product commit the instance applies`);
  return app.pin;
}

/** From what fetchAll brought; when that doesn't hold (a checkout that lags origin), origin/<branch> once from the app's own origin, then once again. */
async function fromOrigin<T>(env: GitEnv, app: App, gd: string, find: () => Promise<T>): Promise<T> {
  // A fetch that can't run (no access, offline) leaves find()'s own error to be thrown.
  return find().catch(async () => (await fetchBranch(env, app).catch(() => {}), find()));
}

/** Checks the app out at sha (default: its pin, else head of origin/<branch>), refusing commits not reachable from origin/<branch> (a module app: not at or below its pin). */
export async function checkout(env: GitEnv, app: App, sha?: string): Promise<{ sha: string; dir: string }> {
  checkOrg(env, app);
  if (sha && !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("sha must be 7-40 hex characters");
  const gd = await fetchAll(env, app);
  const full = await fromOrigin(env, app, gd, async () => {
    const full = await git([gd, "rev-parse", "--verify", `${sha ?? app.pin ?? `origin/${app.branch}`}^{commit}`]);
    const from = ceiling(env, app);
    try {
      await git([gd, "merge-base", "--is-ancestor", full, from]);
    } catch {
      throw new Error(app.module
        ? `commit ${full.slice(0, 8)} is not at or below the applied product pin ${from.slice(0, 8)}: apply the product commit first`
        : `commit ${full.slice(0, 8)} is not reachable from ${from}`);
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
  await git([gd, `--work-tree=${tmp}`, "checkout", "--force", "--detach", full]);
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
  // A module app is the product's own code at the instance's pin: it has no PR preview, and nothing of its is fetched from GitHub.
  if (app.module) throw new Error(`${app.name} is a module app: it has no pull request preview, its source is the applied product pin`);
  if (!app.preview || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("a preview checks out one PR head by its full sha");
  const bare = `${env.gitDir}/${app.name}.git`;
  if (!existsSync(bare)) {
    mkdirSync(env.gitDir, { recursive: true });
    await git(["init", "--bare", "-q", bare]);
  }
  const gd = `--git-dir=${bare}`;
  if (viaOps(env, app)) await env.ops!.fetch(app.repo, `refs/pull/${app.preview.pr}/head`, bare);
  else {
    const s = source(env, app);
    const ref = isLocal(env.localRoot, app.repo) ? `refs/changes/${app.preview.pr}/head` : `refs/pull/${app.preview.pr}/head`;
    await git([...s.pre, gd, "fetch", s.url, `+${ref}:refs/remotes/pr/head`]);
  }
  const head = await git([gd, "rev-parse", "--verify", "refs/remotes/pr/head^{commit}"]);
  if (head !== sha) throw new Error(`PR #${app.preview.pr} moved to ${head.slice(0, 8)}`);
  return { sha, dir: await workTree(env, app, gd, sha) };
}

/** A deployed commit's full message, from the app's bare repo (its deploy fetched it). Read by code only, never shown. */
export async function commitMessage(env: GitEnv, app: App, sha: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("sha must be 40 hex characters");
  return git([`--git-dir=${env.gitDir}/${app.name}.git`, "log", "-1", "--format=%B", sha]);
}

/** The full sha and subject of a commit on origin/<branch> (what an approval card names); throws if unknown or off-branch. */
export async function resolveCommit(env: GitEnv, app: App, sha: string): Promise<{ sha: string; subject: string }> {
  checkOrg(env, app);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("sha must be 7-40 hex characters");
  const gd = await fetchAll(env, app);
  const find = async (): Promise<{ sha: string; subject: string }> => {
    const full = await git([gd, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).catch(() => "");
    if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`no single commit ${sha} in ${app.repo}`);
    const from = ceiling(env, app);
    await git([gd, "merge-base", "--is-ancestor", full, from]).catch(() => {
      throw new Error(app.module ? `commit ${full.slice(0, 12)} is not at or below the applied product pin ${from.slice(0, 8)}` : `commit ${full.slice(0, 12)} is not on ${from}`);
    });
    return { sha: full, subject: await git([gd, "log", "-1", "--format=%s", full]) };
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
  const diff = await git([`--git-dir=${env.gitDir}/${app.name}.git`, "-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", base, sha, ...(paths.length ? ["--", ...paths] : [])]);
  return { diff: diff.slice(0, max), truncated: diff.length > max };
}

/** A file of the app at a commit, read from the bare repo (never the work tree); undefined if absent. */
export const show = (env: GitEnv, app: App, sha: string, path: string): Promise<string | undefined> =>
  git([`--git-dir=${env.gitDir}/${app.name}.git`, "show", `${sha}:${path}`]).then((s) => s, () => undefined);

const registrySlug = (url: string) => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];

/**
 * The registry (instance repo) clone at origin/main, exactly (created on first use; local changes are discarded), in
 * apps-mcp's own clone (never the apply's checkout). An https github.com URL comes through the code host's fetch op; any
 * other URL as it is, over SSH with the deploy key.
 */
export async function syncRegistry(env: GitEnv, dir: string, url: string): Promise<void> {
  if (!existsSync(`${dir}/.git`)) {
    mkdirSync(dir, { recursive: true });
    await git(["init", "-q", dir]);
  }
  const slug = registrySlug(url);
  if (slug && env.ops) {
    await env.ops.fetch(slug, "refs/heads/main", `${dir}/.git`);
    await git(["reset", "-q", "--hard", "refs/remotes/origin/main"], dir);
    return;
  }
  await git(["fetch", url, "main"], dir, env.sshCommand ? { GIT_SSH_COMMAND: env.sshCommand } : {});
  await git(["reset", "-q", "--hard", "FETCH_HEAD"], dir);
}

export interface BootRegistryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What a failed sync can say about itself without the registry's repo or org: the kernel's status when the failure came
 * from a token mint, else the git error's code. The raw messages name both, and the log never does.
 */
const failureReason = (err: unknown): string => {
  const status = /the kernel said (\d{3})/.exec(String((err as Error)?.message ?? err))?.[1];
  const code = (err as { code?: unknown })?.code;
  if (status) return `the kernel said ${status}`;
  return typeof code === "string" || typeof code === "number" ? `git exit ${code}` : "no further detail";
};

/**
 * The boot's registry sync: `syncRegistry` retried up to `attempts` times with exponential backoff (`baseDelayMs` doubling,
 * capped), so one transient failure (a token mint answering 500) cannot restart-loop the container before it listens.
 * After the bound the outcome depends on whether there is a registry to serve: with `${dir}/apps.yaml` on disk from an
 * earlier run, boot resolves and the reconcile loop retries in the background; with no registry yet there is nothing to
 * serve, so the last error is thrown and the process still fails closed. The warning per attempt names the attempt and
 * `failureReason` only: never the error's message, which names the registry's repo and org.
 */
export async function bootRegistry(env: GitEnv, dir: string, url: string, opts: BootRegistryOptions = {}): Promise<void> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 5));
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await syncRegistry(env, dir, url);
      return;
    } catch (err) {
      last = err;
      console.warn(`registry sync attempt ${attempt}/${attempts} failed (${failureReason(err)})`);
      if (attempt < attempts) await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000));
    }
  }
  if (existsSync(`${dir}/apps.yaml`)) {
    console.warn(`registry sync failed after ${attempts} attempts; serving the registry already on disk until the reconcile loop syncs it`);
    return;
  }
  throw last;
}

/**
 * One file of the registry clone committed to main. An https github.com URL: one `commit` op on the synced HEAD (the code
 * host refuses a main that moved); any other URL: a local commit pushed over SSH. The clone was synced just before the edit.
 */
export async function commitPush(env: GitEnv, repoDir: string, file: string, message: string, pushUrl: string): Promise<void> {
  const slug = registrySlug(pushUrl);
  if (slug && env.ops) {
    const parent = await git(["rev-parse", "HEAD"], repoDir);
    await env.ops.commit({ repo: slug, branch: "main", path: file, content: readFileSync(`${repoDir}/${file}`, "utf8"), parent, message });
    return;
  }
  await git(["add", file], repoDir);
  await git(["-c", "user.name=apps-mcp", "-c", "user.email=apps-mcp@agents.local", "commit", "-m", message, "--", file], repoDir);
  await git(["push", pushUrl, "HEAD:main"], repoDir, env.sshCommand ? { GIT_SSH_COMMAND: env.sshCommand } : {});
}

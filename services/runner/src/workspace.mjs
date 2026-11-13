// Task workspaces: one directory per task, with a full clone of every repository the work
// touches. The agent branches and commits there as freely as in a person's own checkout; several
// branches, stacked branches and several repositories all live under one task. It cannot push:
// publishing stays with the runner, on the user's word. Clones are local copies of the runner's
// cache (hardlinked objects), so they are quick and keep every write inside the workspace.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRepo } from "./commands.mjs";
import { readOwn } from "./files.mjs";
import { SAFE_GIT_ARGS, defaultBranch, git, smallFile } from "./git.mjs";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Whether a clone still shares object files with another (a clone made for the jail is hardlinked to the cache). Only looked
 * at, never written: the clone's .git is the agent's, so nothing here follows a link or writes by a name found in it.
 */
function sharesObjects(clone) {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() && lstatSync(join(dir, e.name)).nlink > 1));
  const objects = join(clone, ".git", "objects");
  return Boolean(lstatSync(objects, { throwIfNoEntry: false })?.isDirectory()) && walk(objects);
}
const MANIFEST = join(".aidenhq", "branches.json");

export const workspacePath = (workDir, identifier) => join(workDir, "tasks", identifier);

const hasRef = (cwd, ref) => git(cwd, "rev-parse", "--verify", "--quiet", ref).then(() => true, () => false);

// `fn(path, opts)` answered once per state of the clone's refs. Only for answers that depend on nothing but the
// refs and the commits they reach (commits never change): a run, a fetch or a rename moves a ref and asks again.
const memo = new Map();
async function sameRefs(fn, path, opts) {
  const key = async () => createHash("sha256").update(JSON.stringify([fn.name, path, opts])).update(refFiles(path) ?? (await git(path, "for-each-ref", "--format=%(refname) %(objectname)"))).digest("hex");
  const before = await key();
  if (memo.has(before)) return structuredClone(memo.get(before));
  const answer = await fn(path, opts);
  // Kept only when no ref moved while it was worked out (the agent may be committing meanwhile).
  if ((await key()) === before) {
    if (memo.size >= 500) memo.clear();
    memo.set(before, answer);
  }
  return structuredClone(answer);
}

/**
 * Every ref of a clone exactly as git stores them (the loose files under .git/refs and .git/packed-refs), read without a
 * git process. Undefined, so git lists them instead, when they aren't stored that way (a worktree, the reftable backend)
 * or when anything there isn't a directory or a small regular file: the clone is the agent's to write, so a symlink,
 * FIFO or device there is never followed, waited on or read.
 */
function refFiles(path) {
  const dir = join(path, ".git");
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, "refs")).isDirectory() || existsSync(join(dir, "reftable"))) return undefined;
    const parts = [];
    const walk = (d, rel) => {
      for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.isDirectory()) walk(join(d, e.name), `${rel}/${e.name}`);
        else {
          const text = e.isFile() ? smallFile(join(d, e.name)) : undefined;
          if (text === undefined) throw new Error("not a plain ref file");
          parts.push(`${rel}/${e.name}\0${text}`);
        }
      }
    };
    walk(join(dir, "refs"), "refs");
    const packed = lstatSync(join(dir, "packed-refs"), { throwIfNoEntry: false }) ? smallFile(join(dir, "packed-refs"), 64 * 1024) : "";
    if (packed === undefined) return undefined;
    parts.push(`packed-refs\0${packed}`);
    return parts.join("\0");
  } catch {
    return undefined; // something unusual, or a ref written while reading: git lists them
  }
}

// A clone's slug, remembered against its .git/config exactly as it was read (any write replaces the file, so a
// changed remote or a clone re-created at the same path never reads a stale slug).
const slugs = new Map();
const configStamp = (path) => {
  const s = statSync(join(path, ".git", "config"), { bigint: true, throwIfNoEntry: false });
  return s ? `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : "";
};

async function cloneSlug(path) {
  const stamp = configStamp(path);
  const known = slugs.get(path);
  if (stamp && known?.stamp === stamp) return known.repo;
  // A repository cloned from a path on this host (repo_sources) carries its slug in aidenhq.slug.
  const pairs = (await git(path, "config", "--get-regexp", "^(aidenhq\\.slug|remote\\.origin\\.url)$").catch(() => "")).split("\n").map((l) => l.split(/ (.*)/s));
  const value = (key) => pairs.findLast(([k]) => k === key)?.[1] ?? "";
  const repo = normalizeRepo(value("aidenhq.slug") || value("remote.origin.url"));
  if (repo && stamp) slugs.set(path, { stamp, repo });
  return repo;
}

/**
 * A `.git` at a workspace's root that isn't a repository: a job's sandbox masks `<workspace>/.git` by mounting a read-only
 * tmpfs over it, and bwrap creates that mount point as a real, empty directory on the host. Left behind (a restart that
 * keeps the workspace is enough), the runner's own git finds it in the task folder and refuses every command there, so
 * every clone fails. Clones live in the workspace's subdirectories, never at its root, so an empty `.git` there is only
 * that mount point: it is removed, and returns true. A real git directory is left alone (false). Anything else is a hard
 * error, with a message that says the workspace must be started afresh.
 */
export function repairWorkspaceGit(workspace) {
  const dir = join(workspace, ".git");
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(`this task's workspace can't be used: ${dir} can't be read (${err.code ?? "unknown error"}). Reply again to retry, or start the task afresh (\`aidenhq cleanup\`).`);
  }
  if (!entries.length) {
    try {
      rmdirSync(dir);
    } catch (err) {
      throw new Error(`this task's workspace can't be used yet: ${dir} is an empty mount point a job's sandbox left behind that is still attached (${err.code ?? "unknown error"}). A runner restart clears it, or start the task afresh (\`aidenhq cleanup\`).`);
    }
    return true;
  }
  const has = (name, isDir = false) => entries.includes(name) && (isDir ? lstatSync(join(dir, name), { throwIfNoEntry: false })?.isDirectory() : lstatSync(join(dir, name), { throwIfNoEntry: false })?.isFile());
  if (has("HEAD") && has("objects", true) && has("refs", true)) return false; // a real git directory: not ours to touch
  throw new Error(`this task's workspace can't be used: ${dir} holds files but isn't a git directory. Start the task afresh (\`aidenhq cleanup\`) and ask again.`);
}

/** The repositories cloned in a workspace: top-level directories that are git clones (not worktrees). */
export async function workspaceRepos(workspace) {
  if (!existsSync(workspace)) return [];
  const out = [];
  for (const name of readdirSync(workspace).sort()) {
    const path = join(workspace, name);
    if (name.startsWith(".") || !existsSync(join(path, ".git")) || !statSync(join(path, ".git")).isDirectory()) continue;
    const repo = await cloneSlug(path);
    if (repo) out.push({ ...repo, path });
  }
  return out;
}

/**
 * Clone `repo` into the workspace from the runner's cache clone (`cache`), pointed at GitHub
 * (`remoteUrl`), on its default branch. An existing clone is fetched instead. Returns its path.
 */
export async function ensureRepo(workspace, repo, { cache, remoteUrl = `git@github.com:${repo.slug}.git`, hooksDir, copy = false }) {
  mkdirSync(workspace, { recursive: true });
  const existing = (await workspaceRepos(workspace)).find((r) => r.slug.toLowerCase() === repo.slug.toLowerCase());
  if (existing) {
    await git(existing.path, "fetch", "--quiet", "--prune", "origin");
    // A box mounts this clone read-write: one sharing files with the runner's cache (made for the jail) is refused.
    if (copy && sharesObjects(existing.path)) throw new Error(`${repo.slug} in this task's workspace was cloned for the jail and shares files with the runner's cache, so it can't go into a computer. Start the task afresh (\`aidenhq cleanup\`, then ask again) or hand it back to the Software Engineer.`);
    return existing.path;
  }
  let path = join(workspace, repo.name);
  if (existsSync(path)) path = join(workspace, `${repo.org}--${repo.name}`);
  // copy: a box job's clone shares no object file with the cache clone (its box writes the workspace through a mount).
  await git(workspace, "clone", "--quiet", "--no-checkout", ...(copy ? ["--no-hardlinks"] : []), cache, path);
  await git(path, "remote", "set-url", "origin", remoteUrl);
  if (!remoteUrl.includes("github.com")) await git(path, "config", "aidenhq.slug", repo.slug);
  // Pushing is the runner's job: the clone has no push URL and a pre-push hook that refuses.
  await git(path, "config", "remote.origin.pushurl", "DISABLED_BY_AIDENHQ");
  if (hooksDir) await git(path, "config", "core.hooksPath", hooksDir);
  await git(path, "fetch", "--quiet", "--prune", "origin");
  await git(path, "remote", "set-head", "origin", "--auto").catch(() => {});
  const base = await defaultBranch(path);
  if (await hasRef(path, `origin/${base}`)) await git(path, "checkout", "--quiet", "-B", base, `origin/${base}`);
  else await git(path, "symbolic-ref", "HEAD", `refs/heads/${base}`); // empty repository
  for (const b of (await git(path, "for-each-ref", "--format=%(refname:short)", "refs/heads")).split("\n").filter(Boolean)) {
    if (b !== base) await git(path, "branch", "-D", b); // only what the task makes
  }
  return path;
}

/** The agent's optional note on its branches: [{ repo, branch, base, purpose }]. */
export function readManifest(workspace) {
  try {
    const list = JSON.parse(readOwn(workspace, MANIFEST, 256 * 1024)?.toString("utf8") ?? "[]");
    return Array.isArray(list) ? list.filter((e) => e && typeof e.branch === "string") : [];
  } catch {
    return [];
  }
}

/** The pushed tip of a branch per the last fetch, or "". */
const remoteTip = (path, branch) => git(path, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`).catch(() => "");

const count = async (path, tip, not) => Number(await git(path, "rev-list", "--count", tip, "--not", not).catch(() => "1000000"));

/**
 * The task's branches in one clone, each with its base: the branch it was made from. That's the
 * closest of the task's other branches it is stacked on and the branches on GitHub (the default one,
 * or another long-lived one such as `v2`): the one leaving the fewest commits of its own. The agent's
 * manifest wins when it names one of those. A local branch with no commits beyond its base (the
 * default branch, a plain checkout of `v2`) isn't a task branch.
 */
export const findBranches = (path, { base, manifest = [], slug, known = [] }) => sameRefs(findBranchesNow, path, { base, manifest, slug, known });

async function findBranchesNow(path, { base, manifest, slug, known }) {
  const onBase = await hasRef(path, `origin/${base}`);
  const heads = (await git(path, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads")).split("\n").filter(Boolean).map((l) => l.split(" "));
  // Branches on GitHub that could be a base: the default one first, then the most recently updated.
  const remotes = (await git(path, "for-each-ref", "--sort=-committerdate", "--count=60", "--format=%(refname:lstrip=3)", "refs/remotes/origin")).split("\n").filter((r) => r && r !== "HEAD");
  const bases = [...new Set([...(onBase ? [base] : []), ...remotes])];
  const found = [];
  for (const [branch, tip] of heads) {
    if (branch === base) continue;
    // A checkout of a branch on GitHub with nothing new (a local `v2`) is only the task's if the task
    // made it (pushed, maybe with a PR).
    if (!known.includes(branch) && (await hasRef(path, `origin/${branch}`)) && !(await count(path, tip, `origin/${branch}`))) continue;
    let best;
    for (const r of bases) {
      if (r === branch) continue; // its own pushed copy is not its base
      const n = await count(path, tip, `origin/${r}`);
      if (!best || n < best.n) best = { base: r, n };
    }
    const own = best ? best.n : Number(await git(path, "rev-list", "--count", tip));
    if (own) found.push({ branch, tip, own, remoteBase: best?.base ?? base, counts: new Map([[best?.base ?? base, own]]) });
  }
  // A repository that is still empty on GitHub: its default branch is published as the first commits.
  const baseTip = heads.find(([b]) => b === base)?.[1];
  if (!onBase && baseTip) found.unshift({ branch: base, tip: baseTip, own: Number(await git(path, "rev-list", "--count", baseTip)), remoteBase: base, counts: new Map() });
  for (const b of found) {
    const named = manifest.find((m) => m.branch === b.branch && (!m.repo || !slug || String(m.repo).toLowerCase() === slug.toLowerCase()));
    let pick = { base: b.remoteBase, n: b.own };
    for (const o of found) {
      if (o.branch === b.branch || o.tip === b.tip || o.branch === base) continue;
      if (!(await git(path, "merge-base", "--is-ancestor", o.tip, b.tip).then(() => true, () => false))) continue;
      const n = await count(path, b.tip, o.tip);
      b.counts.set(o.branch, n);
      if (n < pick.n) pick = { base: o.branch, n };
    }
    // The manifest's base, if it is one of the candidates and as close as the best one.
    if (named?.base && named.base !== b.branch && (bases.includes(named.base) || found.some((o) => o.branch === named.base))) {
      const n = b.counts.get(named.base) ?? (found.some((o) => o.branch === named.base) ? await count(path, b.tip, named.base) : await count(path, b.tip, `origin/${named.base}`));
      if (n <= pick.n) pick = { base: named.base, n };
    }
    b.base = pick.base;
    b.purpose = typeof named?.purpose === "string" ? named.purpose.slice(0, 300) : "";
  }
  return found.map(({ branch, base: b, purpose, tip }) => ({ branch, base: b, purpose, tip }));
}

/**
 * What a branch's base is in git: the task branch of that name when there is one (stacked), else the
 * branch on GitHub (`origin/<base>`), else nothing (an empty repository).
 */
export const baseRef = (path, { branch, base, taskBranches = [] }) => sameRefs(baseRefNow, path, { branch, base, taskBranches });

async function baseRefNow(path, { branch, base, taskBranches = [] }) {
  if (base !== branch && taskBranches.includes(base) && (await hasRef(path, `refs/heads/${base}`))) return base;
  return (await hasRef(path, `origin/${base}`)) ? `origin/${base}` : "";
}

/** Commits on `branch` that aren't on GitHub yet (oldest first), and the diffstat against its base. */
export const branchChanges = (path, { branch, base, taskBranches = [] }) => sameRefs(branchChangesNow, path, { branch, base, taskBranches });

async function branchChangesNow(path, { branch, base, taskBranches = [] }) {
  const from = (await baseRef(path, { branch, base, taskBranches })) || EMPTY_TREE;
  const stop = from === EMPTY_TREE ? [] : [from];
  const unpublished = (await git(path, "log", "--reverse", "--format=%h %s", branch, "--not", "--remotes=origin", ...stop)).split("\n").filter(Boolean);
  const stat = await git(path, "diff", "--shortstat", from === EMPTY_TREE ? EMPTY_TREE : `${from}...${branch}`, ...(from === EMPTY_TREE ? [branch] : [])).catch(() => "");
  return { unpublished, stat, onGitHub: Boolean(await remoteTip(path, branch)) };
}

/** Full messages of the commits on `branch` since `from` (oldest first), for PR descriptions and checks. */
export const messagesSince = (path, from, branch) => sameRefs(messagesNow, path, [from, branch]);

async function messagesNow(path, [from, branch]) {
  return (await git(path, "log", "--reverse", "--format=%B%x1e", from ? `${from}..${branch}` : branch).catch(() => "")).split("\x1e").map((m) => m.trim()).filter(Boolean);
}

/** Worktrees of a clone (the clone itself first): [{ path, branch (or ""), head }]. */
export async function worktrees(path) {
  const out = [];
  let cur;
  for (const line of (await git(path, "worktree", "list", "--porcelain")).split("\n")) {
    if (line.startsWith("worktree ")) out.push((cur = { path: line.slice(9), branch: "", head: "" }));
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return out.filter((w) => existsSync(w.path));
}

/**
 * Sign the commits the agent made (it has no SSH agent, so it commits unsigned), keeping their trees,
 * messages, authors and dates. Only commits GitHub doesn't have are touched, oldest first; their
 * descendants follow, and every local branch is moved to the rewritten tip. Worktrees on those
 * branches stay clean: the trees are identical. Returns the number of commits rewritten.
 */
export async function signUnsigned(path) {
  // Whether to sign is the host user's own setting (global config): the clone's config is the agent's to write, and task-folder git reads none.
  if ((await gitEnv(tmpdir(), {}, "config", "--global", "--bool", "--get", "commit.gpgsign").catch(() => "")) !== "true") return 0;
  const list = (await git(path, "rev-list", "--reverse", "--topo-order", "--parents", "--branches", "--not", "--remotes=origin")).split("\n").filter(Boolean).map((l) => l.split(" "));
  const map = new Map();
  const dir = mkdtempSync(join(tmpdir(), "pw-sign-"));
  try {
    for (const [sha, ...parents] of list) {
      const raw = await git(path, "cat-file", "commit", sha);
      const header = raw.split("\n\n")[0];
      if (/^gpgsig /m.test(header) && !parents.some((p) => map.has(p))) continue;
      const person = (role) => {
        const m = new RegExp(`^${role} (.*) <([^>]*)> (\\d+ [+-]\\d{4})$`, "m").exec(header);
        return m ? { name: m[1], email: m[2], date: m[3] } : undefined;
      };
      const author = person("author");
      const committer = person("committer");
      const msgFile = join(dir, "msg");
      writeFileSync(msgFile, raw.slice(raw.indexOf("\n\n") + 2));
      const tree = /^tree (\w+)$/m.exec(header)[1];
      const args = ["commit-tree", "-S", tree, ...parents.flatMap((p) => ["-p", map.get(p) ?? p]), "-F", msgFile];
      const env = {
        GIT_AUTHOR_NAME: author?.name, GIT_AUTHOR_EMAIL: author?.email, GIT_AUTHOR_DATE: author?.date,
        GIT_COMMITTER_NAME: committer?.name, GIT_COMMITTER_EMAIL: committer?.email, GIT_COMMITTER_DATE: committer?.date,
      };
      map.set(sha, await gitEnv(path, env, ...args));
    }
    if (!map.size) return 0;
    for (const line of (await git(path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")).split("\n").filter(Boolean)) {
      const [ref, tip] = line.split(" ");
      if (map.has(tip)) await git(path, "update-ref", ref, map.get(tip), tip);
    }
    // Worktrees on a detached HEAD at a rewritten commit follow too.
    for (const w of await worktrees(path)) if (!w.branch && map.has(w.head)) await git(w.path, "update-ref", "--no-deref", "HEAD", map.get(w.head), w.head);
    return map.size;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gitEnv(cwd, env, ...args) {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v));
  return new Promise((resolve, reject) =>
    execFile("git", [...SAFE_GIT_ARGS, ...args], { cwd, env: { ...process.env, ...clean, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout.trim()))),
  );
}

/**
 * Commits made on the default branch itself move to a new branch (`name`), and the default branch goes
 * back to GitHub's: nothing is ever published as the default branch by accident. Returns the new
 * branch, or "" when the default branch has nothing of its own.
 */
export async function moveOffDefault(path, base, name) {
  if (!(await hasRef(path, `origin/${base}`)) || !(await hasRef(path, `refs/heads/${base}`))) return "";
  if (!Number(await git(path, "rev-list", "--count", base, "--not", `origin/${base}`))) return "";
  await git(path, "branch", name, base);
  for (const w of await worktrees(path)) if (w.branch === base) await git(w.path, "switch", "--quiet", name); // same commit: changes stay
  await git(path, "branch", "-f", base, `origin/${base}`);
  return name;
}

/** Carry the commits after `since` on `branch` onto a new branch `name` from origin/<base> (a merged PR's follow-ups). */
export async function carryOver(path, { branch, base, since, name }) {
  const range = (await hasRef(path, `${since}^{commit}`)) ? `${since}..${branch}` : `origin/${base}..${branch}`;
  const carry = (await git(path, "rev-list", "--reverse", "--no-merges", range)).split("\n").filter(Boolean);
  if (!carry.length) return 0;
  const tmp = mkdtempSync(join(tmpdir(), "pw-carry-"));
  try {
    await git(path, "worktree", "add", "--quiet", "-b", name, join(tmp, "w"), `origin/${base}`);
    try {
      for (const sha of carry) await git(join(tmp, "w"), "-c", "core.hooksPath=/dev/null", "cherry-pick", "--allow-empty", sha);
    } catch (err) {
      await git(join(tmp, "w"), "cherry-pick", "--abort").catch(() => {});
      await git(path, "worktree", "remove", "--force", join(tmp, "w"));
      await git(path, "branch", "-D", name);
      throw err;
    }
    await git(path, "worktree", "remove", "--force", join(tmp, "w"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await git(path, "worktree", "prune").catch(() => {});
  }
  // Wherever the old branch is checked out cleanly, continue on the new one.
  for (const w of await worktrees(path)) if (w.branch === branch && !(await git(w.path, "status", "--porcelain"))) await git(w.path, "switch", "--quiet", name);
  return carry.length;
}

/** Every worktree of every clone with uncommitted changes: [{ repo, path, branch }]. */
export async function dirtyCheckouts(repos) {
  const out = [];
  for (const r of repos) for (const w of await worktrees(r.path)) if (await git(w.path, "status", "--porcelain").catch(() => "")) out.push({ repo: r, path: w.path, branch: w.branch });
  return out;
}

/** Copy every local branch of a clone into the cache as refs/kept/<task>/… before a workspace is removed. */
export async function keepBranches(path, cache, identifier) {
  await git(cache, "fetch", "--quiet", path, `+refs/heads/*:refs/kept/${identifier}/*`).catch(() => {});
}


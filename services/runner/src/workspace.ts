// Task workspaces: one directory per task, with a full clone of every repository the work
// touches. The agent branches and commits there as freely as in a person's own checkout; several
// branches, stacked branches and several repositories all live under one task. It cannot push:
// publishing stays with the runner, on the user's word. Clones are local copies of the runner's
// cache (hardlinked objects), so they are quick and keep every write inside the workspace.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRepo } from "./commands.mjs";
import { readOwn } from "./files.ts";
import { SAFE_GIT_ARGS, defaultBranch, git, smallFile } from "./git.mjs";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Whether a clone still shares object files with another (a clone made for the jail is hardlinked to the cache). Only looked
 * at, never written: the clone's .git is the agent's, so nothing here follows a link or writes by a name found in it.
 */
function sharesObjects(clone: string): boolean {
  const walk = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() && lstatSync(join(dir, e.name)).nlink > 1));
  const objects = join(clone, ".git", "objects");
  return Boolean(lstatSync(objects, { throwIfNoEntry: false })?.isDirectory()) && walk(objects);
}
const MANIFEST = join(".aidenhq", "branches.json");

export const workspacePath = (workDir: string, identifier: string) => join(workDir, "tasks", identifier);

const hasRef = (cwd: string, ref: string) => git(cwd, "rev-parse", "--verify", "--quiet", ref).then(() => true, () => false);

// `fn(path, opts)` answered once per state of the clone's refs. Only for answers that depend on nothing but the
// refs and the commits they reach (commits never change): a run, a fetch or a rename moves a ref and asks again.
const memo = new Map<string, any>();
async function sameRefs(fn: (path: string, opts: any) => Promise<any>, path: string, opts: any): Promise<any> {
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
function refFiles(path: string): string | undefined {
  const dir = join(path, ".git");
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, "refs")).isDirectory() || existsSync(join(dir, "reftable"))) return undefined;
    const parts: string[] = [];
    const walk = (d: string, rel: string): void => {
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

// What a turn asks about every branch is answered from facts that never change (how many commits one commit has that another
// lacks) or from one read of the refs, so a clone with many old branches costs a turn nothing for the ones that didn't move.
const relations = new Map<string, number>(); // `${clone}\0${a}\0${b}` -> commits reachable from a and not from b
const related = new Map<string, Set<string>>(); // clone -> commit ids whose relation to every branch and remote branch has been read
let aheadBehind = true;
const relKey = (path: string, a: string, b: string) => `${path}\0${a}\0${b}`;

/** In one git process: how each branch and remote branch of the clone stands against commit `c`, remembered for good. */
async function readRelations(path: string, c: string) {
  const done = related.get(path) ?? related.set(path, new Set()).get(path)!;
  if (!aheadBehind || done.has(c)) return;
  let out: string;
  try {
    out = await git(path, "for-each-ref", `--format=%(objectname) %(ahead-behind:${c})`, "refs/heads", "refs/remotes/origin");
  } catch {
    aheadBehind = false; // git before 2.41: each count is its own process below
    return;
  }
  if (relations.size > 50_000) {
    relations.clear();
    related.clear();
  }
  for (const line of out.split("\n")) {
    const [sha, ahead, behind] = line.split(" ");
    if (!behind) continue;
    relations.set(relKey(path, sha!, c), Number(ahead));
    relations.set(relKey(path, c, sha!), Number(behind));
  }
  (related.get(path) ?? related.set(path, new Set()).get(path)!).add(c);
}

/** Commits reachable from `a` and not from `b` (commit ids). */
async function commitsNotIn(path: string, a: string, b: string): Promise<number> {
  const key = relKey(path, a, b);
  if (!relations.has(key)) relations.set(key, Number(await git(path, "rev-list", "--count", a, "--not", b).catch(() => "1000000")));
  return relations.get(key)!;
}

// A clone's refs as of now, read once per change of them (the key costs no git process for an ordinary clone).
const snapshots = new Map<string, { key: string; refs: Map<string, string>; remotes: string }>();
async function snapshot(path: string) {
  const key = refFiles(path) ?? (await git(path, "for-each-ref", "--format=%(refname) %(objectname)"));
  const hit = snapshots.get(path);
  if (hit?.key === key) return hit;
  const lines = (await git(path, "for-each-ref", "--format=%(refname) %(objectname)")).split("\n").filter(Boolean);
  const refs = new Map(lines.map((l): [string, string] => l.split(" ") as [string, string]));
  const remotes = createHash("sha256").update(lines.filter((l) => l.startsWith("refs/remotes/")).join("\n")).digest("hex");
  const made = { key, refs, remotes };
  if (snapshots.size >= 200) snapshots.clear();
  snapshots.set(path, made);
  return made;
}

// A clone's slug, remembered against its .git/config exactly as it was read (any write replaces the file, so a
// changed remote or a clone re-created at the same path never reads a stale slug).
const slugs = new Map<string, { stamp: string; repo: any }>();
const configStamp = (path: string) => {
  const s = statSync(join(path, ".git", "config"), { bigint: true, throwIfNoEntry: false });
  return s ? `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : "";
};

async function cloneSlug(path: string) {
  const stamp = configStamp(path);
  const known = slugs.get(path);
  if (stamp && known?.stamp === stamp) return known.repo;
  // A repository cloned from a path on this host (repo_sources) carries its slug in aidenhq.slug.
  const pairs = (await git(path, "config", "--get-regexp", "^(aidenhq\\.slug|remote\\.origin\\.url)$").catch(() => "")).split("\n").map((l) => l.split(/ (.*)/s));
  const value = (key: string) => pairs.findLast(([k]) => k === key)?.[1] ?? "";
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
export function repairWorkspaceGit(workspace: string): boolean {
  const dir = join(workspace, ".git");
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: any) {
    throw new Error(`this task's workspace can't be used: ${dir} can't be read (${err.code ?? "unknown error"}). Reply again to retry, or start the task afresh (\`aidenhq cleanup\`).`);
  }
  if (!entries.length) {
    try {
      rmdirSync(dir);
    } catch (err: any) {
      throw new Error(`this task's workspace can't be used yet: ${dir} is an empty mount point a job's sandbox left behind that is still attached (${err.code ?? "unknown error"}). A runner restart clears it, or start the task afresh (\`aidenhq cleanup\`).`);
    }
    return true;
  }
  const has = (name: string, isDir = false) => entries.includes(name) && (isDir ? lstatSync(join(dir, name), { throwIfNoEntry: false })?.isDirectory() : lstatSync(join(dir, name), { throwIfNoEntry: false })?.isFile());
  if (has("HEAD") && has("objects", true) && has("refs", true)) return false; // a real git directory: not ours to touch
  throw new Error(`this task's workspace can't be used: ${dir} holds files but isn't a git directory. Start the task afresh (\`aidenhq cleanup\`) and ask again.`);
}

/** The repositories cloned in a workspace: top-level directories that are git clones (not worktrees). */
export async function workspaceRepos(workspace: string) {
  if (!existsSync(workspace)) return [];
  const out: any[] = [];
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
export async function ensureRepo(workspace: string, repo: any, { cache, remoteUrl = `git@github.com:${repo.slug}.git`, hooksDir, copy = false }: { cache: string; remoteUrl?: string; hooksDir?: string; copy?: boolean }): Promise<string> {
  mkdirSync(workspace, { recursive: true });
  const existing = (await workspaceRepos(workspace)).find((r) => r.slug.toLowerCase() === repo.slug.toLowerCase());
  if (existing) {
    await git(existing.path, "fetch", "--quiet", "--prune", "origin");
    await git(existing.path, "fetch", "--quiet", "--no-tags", cache, `+${REVIEWED}/*:${REVIEWED}/*`).catch(() => {});
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
  // `.aidenhq/` (screenshots, reports, the PR body) is the task's scratch, never the repository's: one committed shows that
  // run's app to every later reviewer as if it were theirs.
  mkdirSync(join(path, ".git", "info"), { recursive: true });
  appendFileSync(join(path, ".git", "info", "exclude"), "\n.aidenhq/\n");
  await git(path, "fetch", "--quiet", "--prune", "origin");
  // The reviewed heads the runner kept for a task that came before this one (refs/reviewed/…): local, never GitHub's.
  await git(path, "fetch", "--quiet", "--no-tags", cache, `+${REVIEWED}/*:${REVIEWED}/*`).catch(() => {});
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
export function readManifest(workspace: string): any[] {
  try {
    const list = JSON.parse(readOwn(workspace, MANIFEST, 256 * 1024)?.toString("utf8") ?? "[]");
    return Array.isArray(list) ? list.filter((e: any) => e && typeof e.branch === "string") : [];
  } catch {
    return [];
  }
}

/** The pushed tip of a branch per the last fetch, or "". */
const remoteTip = (path: string, branch: string) => git(path, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`).catch(() => "");

const countAgainst = async (path: string, tip: string, not: string) => Number(await git(path, "rev-list", "--count", tip, "--not", not).catch(() => "1000000"));

/**
 * The task's branches in one clone, each with its base: the branch it was made from. That's the
 * closest of the task's other branches it is stacked on and the branches on GitHub (the default one,
 * or another long-lived one such as `v2`): the one leaving the fewest commits of its own. The agent's
 * manifest wins when it names one of those. A local branch with no commits beyond its base (the
 * default branch, a plain checkout of `v2`) isn't a task branch.
 */
export const findBranches = (path: string, { base, manifest = [], slug, known = [] }: { base: string; manifest?: any[]; slug?: string; known?: string[] }) => sameRefs(findBranchesNow, path, { base, manifest, slug, known });

async function findBranchesNow(path: string, { base, manifest, slug, known }: { base: string; manifest: any[]; slug?: string; known: string[] }) {
  const { refs } = await snapshot(path);
  const heads = [...refs].filter(([r]) => r.startsWith("refs/heads/")).map(([r, sha]): [string, string] => [r.slice(11), sha]);
  const remoteTip = new Map([...refs].filter(([r]) => r.startsWith("refs/remotes/origin/")).map(([r, sha]): [string, string] => [r.slice(20), sha]));
  const onBase = remoteTip.has(base);
  // Branches on GitHub that could be a base: the default one first, then the most recently updated.
  const remotes = (await git(path, "for-each-ref", "--sort=-committerdate", "--count=60", "--format=%(refname:lstrip=3)", "refs/remotes/origin")).split("\n").filter((r) => r && r !== "HEAD");
  const bases = [...new Set([...(onBase ? [base] : []), ...remotes])];
  // Every branch against every candidate base, in one process per commit not read before (new branch or new base).
  for (const [, tip] of heads) await readRelations(path, tip);
  for (const r of bases) if (remoteTip.has(r)) await readRelations(path, remoteTip.get(r)!);
  const count = (tip: string, r: string) => (remoteTip.has(r) ? commitsNotIn(path, tip, remoteTip.get(r)!) : countAgainst(path, tip, `origin/${r}`));
  const found: any[] = [];
  for (const [branch, tip] of heads) {
    if (branch === base) continue;
    // A checkout of a branch on GitHub with nothing new (a local `v2`) is only the task's if the task
    // made it (pushed, maybe with a PR).
    if (!known.includes(branch) && remoteTip.has(branch) && !(await count(tip, branch))) continue;
    let best: { base: string; n: number } | undefined;
    for (const r of bases) {
      if (r === branch) continue; // its own pushed copy is not its base
      const n = await count(tip, r);
      if (!best || n < best.n) best = { base: r, n };
    }
    const own = best ? best.n : Number(await git(path, "rev-list", "--count", tip));
    if (own) found.push({ branch, tip, own, remoteBase: best?.base ?? base, counts: new Map([[best?.base ?? base, own]]) });
  }
  // A repository that is still empty on GitHub: its default branch is published as the first commits.
  const baseTip = heads.find(([b]) => b === base)?.[1];
  if (!onBase && baseTip) found.unshift({ branch: base, tip: baseTip, own: Number(await git(path, "rev-list", "--count", baseTip)), remoteBase: base, counts: new Map() });
  for (const b of found) {
    const named = manifest.find((m: any) => m.branch === b.branch && (!m.repo || !slug || String(m.repo).toLowerCase() === slug.toLowerCase()));
    let pick = { base: b.remoteBase, n: b.own };
    for (const o of found) {
      if (o.branch === b.branch || o.tip === b.tip || o.branch === base) continue;
      if ((await commitsNotIn(path, o.tip, b.tip)) !== 0) continue; // o is not an ancestor of b
      const n = await commitsNotIn(path, b.tip, o.tip);
      b.counts.set(o.branch, n);
      if (n < pick.n) pick = { base: o.branch, n };
    }
    // The manifest's base, if it is one of the candidates and as close as the best one.
    if (named?.base && named.base !== b.branch && (bases.includes(named.base) || found.some((o: any) => o.branch === named.base))) {
      const n = b.counts.get(named.base) ?? (found.some((o: any) => o.branch === named.base) ? await countAgainst(path, b.tip, named.base) : await countAgainst(path, b.tip, `origin/${named.base}`));
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
export async function baseRef(path: string, { branch, base, taskBranches = [] }: { branch: string; base: string; taskBranches?: string[] }): Promise<string> {
  const { refs } = await snapshot(path);
  if (base !== branch && taskBranches.includes(base) && refs.has(`refs/heads/${base}`)) return base;
  return refs.has(`refs/remotes/origin/${base}`) ? `origin/${base}` : "";
}

/** Whether the clone has a local branch of that name. */
export const hasBranch = async (path: string, branch: string) => (await snapshot(path)).refs.has(`refs/heads/${branch}`);

/**
 * The base a new PR opens into, resolved against GitHub first: a stacked branch's base only while GitHub still has that
 * branch and the head has commits on top of it. A base branch that was squash-merged leaves no ref (or a head it already
 * contains), and a PR into it could never merge, so the PR goes into the repository's default branch instead. A head with
 * nothing of its own gives one sentence saying so, rather than GitHub's raw "No commits between …" error.
 * Only confirmed absence falls back: a read that fails (network, auth) returns an error and opens nothing, because a base
 * that can't be shown to be gone may still be the one the branch's own commits must not be read without.
 */
export async function resolvePrBase(path: string, { branch, base, defaultBranch }: { branch: string; base: string; defaultBranch: string }): Promise<{ base: string; from: string; error?: string }> {
  let reading = base;
  const unread = () => ({ base: "", from: "", error: `couldn't read GitHub's \`${reading}\`, so no PR was opened: try again in a few minutes` });
  /** False only when GitHub itself says the branch isn't there (a clean `ls-remote` with no ref). A failed read throws. */
  const onGitHub = async (name: string) => {
    reading = name;
    const remote = (await git(path, "ls-remote", "--heads", "origin", name)).trim();
    if (!remote) return false;
    await git(path, "fetch", "--quiet", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`);
    return true;
  };
  /** Commits on `branch` GitHub's `name` doesn't have. Throws when either side can't be read. */
  const ahead = async (name: string) => {
    reading = name;
    const tip = await git(path, "rev-parse", "--verify", `refs/remotes/origin/${name}^{commit}`);
    return Number(await git(path, "rev-list", "--count", `${tip}..${branch}`));
  };
  let into: string;
  let own: number;
  try {
    const stacked = base !== defaultBranch && (await onGitHub(base)) && (await ahead(base)) > 0;
    into = stacked ? base : defaultBranch;
    if (!stacked && !(await onGitHub(into))) return { base: into, from: "", error: `\`${into}\` isn't on GitHub, so there's no branch to open a PR into` };
    own = await ahead(into);
  } catch {
    return unread();
  }
  if (!Number.isFinite(own)) return unread();
  if (!own) {
    const why = base === into ? `\`${branch}\` has no commits that aren't already on \`${into}\`` : `its base \`${base}\` is gone or already has every commit on \`${branch}\`, and \`${branch}\` has none that aren't on \`${into}\``;
    return { base: into, from: "", error: `not opened: ${why}, so a PR would carry nothing` };
  }
  return { base: into, from: `origin/${into}` };
}

/** Commits on `branch` that aren't on GitHub yet (oldest first), and the diffstat against its base. */
const changes = new Map<string, { answer: any; remotes: string }>();
export async function branchChanges(path: string, { branch, base, taskBranches = [] }: { branch: string; base: string; taskBranches?: string[] }): Promise<any> {
  const snap = await snapshot(path);
  const from = await baseRef(path, { branch, base, taskBranches });
  const own = snap.refs.get(`refs/remotes/origin/${branch}`);
  // Answered again only when this branch, its base or its own pushed copy moved. What isn't published also depends on the
  // other remote branches (pushing a branch stacked on this one publishes its commits), so that answer waits for them too.
  const key = [path, branch, snap.refs.get(`refs/heads/${branch}`), from && snap.refs.get(from.startsWith("origin/") ? `refs/remotes/${from}` : `refs/heads/${from}`), own].join("\0");
  const hit = changes.get(key);
  if (hit && (hit.remotes === snap.remotes || (hit.answer.onGitHub && !hit.answer.unpublished.length))) return structuredClone(hit.answer);
  const answer = await branchChangesNow(path, { branch, base, taskBranches });
  if (changes.size >= 2000) changes.clear();
  changes.set(key, { answer, remotes: snap.remotes });
  return structuredClone(answer);
}

async function branchChangesNow(path: string, { branch, base, taskBranches = [] }: { branch: string; base: string; taskBranches?: string[] }) {
  const from = (await baseRef(path, { branch, base, taskBranches })) || EMPTY_TREE;
  const stop: string[] = from === EMPTY_TREE ? [] : [from];
  const unpublished = (await git(path, "log", "--reverse", "--format=%h %s", branch, "--not", "--remotes=origin", ...stop)).split("\n").filter(Boolean);
  const stat = await git(path, "diff", "--shortstat", from === EMPTY_TREE ? EMPTY_TREE : `${from}...${branch}`, ...(from === EMPTY_TREE ? [branch] : [])).catch(() => "");
  return { unpublished, stat, onGitHub: Boolean(await remoteTip(path, branch)) };
}

/** Full messages of the commits on `branch` since `from` (oldest first), for PR descriptions and checks. */
export const messagesSince = (path: string, from: string | undefined, branch: string): Promise<string[]> => sameRefs(messagesNow, path, [from, branch]);

async function messagesNow(path: string, [from, branch]: [string | undefined, string]) {
  return (await git(path, "log", "--reverse", "--format=%B%x1e", from ? `${from}..${branch}` : branch).catch(() => "")).split("\x1e").map((m) => m.trim()).filter(Boolean);
}

/** Worktrees of a clone (the clone itself first): [{ path, branch (or ""), head }]. */
export async function worktrees(path: string) {
  const out: { path: string; branch: string; head: string }[] = [];
  let cur: { path: string; branch: string; head: string } | undefined;
  for (const line of (await git(path, "worktree", "list", "--porcelain")).split("\n")) {
    if (line.startsWith("worktree ")) out.push((cur = { path: line.slice(9), branch: "", head: "" }));
    else if (line.startsWith("HEAD ")) cur!.head = line.slice(5);
    else if (line.startsWith("branch ")) cur!.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return out.filter((w) => existsSync(w.path));
}

/**
 * Sign the commits the agent made (it has no SSH agent, so it commits unsigned), keeping their trees,
 * messages, authors and dates. Only commits GitHub doesn't have are touched, oldest first; their
 * descendants follow, and every local branch is moved to the rewritten tip. Worktrees on those
 * branches stay clean: the trees are identical. Returns the number of commits rewritten.
 */
export async function signUnsigned(path: string): Promise<number> {
  // Whether to sign is the host user's own setting (global config): the clone's config is the agent's to write, and task-folder git reads none.
  if ((await gitEnv(tmpdir(), {}, "config", "--global", "--bool", "--get", "commit.gpgsign").catch(() => "")) !== "true") return 0;
  const list = (await git(path, "rev-list", "--reverse", "--topo-order", "--parents", "--branches", "--not", "--remotes=origin")).split("\n").filter(Boolean).map((l) => l.split(" "));
  const map = new Map<string, string>();
  const dir = mkdtempSync(join(tmpdir(), "pw-sign-"));
  try {
    for (const [sha, ...parents] of list) {
      const raw = await git(path, "cat-file", "commit", sha);
      const header = raw.split("\n\n")[0]!;
      if (/^gpgsig /m.test(header) && !parents.some((p) => map.has(p))) continue;
      const person = (role: string) => {
        const m = new RegExp(`^${role} (.*) <([^>]*)> (\\d+ [+-]\\d{4})$`, "m").exec(header);
        return m ? { name: m[1], email: m[2], date: m[3] } : undefined;
      };
      const author = person("author");
      const committer = person("committer");
      const msgFile = join(dir, "msg");
      writeFileSync(msgFile, raw.slice(raw.indexOf("\n\n") + 2));
      const tree = /^tree (\w+)$/m.exec(header)![1]!;
      const args = ["commit-tree", "-S", tree, ...parents.flatMap((p) => ["-p", map.get(p) ?? p]), "-F", msgFile];
      const env = {
        GIT_AUTHOR_NAME: author?.name, GIT_AUTHOR_EMAIL: author?.email, GIT_AUTHOR_DATE: author?.date,
        GIT_COMMITTER_NAME: committer?.name, GIT_COMMITTER_EMAIL: committer?.email, GIT_COMMITTER_DATE: committer?.date,
      };
      map.set(sha!, await gitEnv(path, env, ...args));
    }
    if (!map.size) return 0;
    for (const line of (await git(path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")).split("\n").filter(Boolean)) {
      const [ref, tip] = line.split(" ") as [string, string];
      if (map.has(tip)) await git(path, "update-ref", ref, map.get(tip)!, tip);
    }
    // Worktrees on a detached HEAD at a rewritten commit follow too.
    for (const w of await worktrees(path)) if (!w.branch && map.has(w.head)) await git(w.path, "update-ref", "--no-deref", "HEAD", map.get(w.head)!, w.head);
    return map.size;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gitEnv(cwd: string, env: Record<string, string | undefined>, ...args: string[]): Promise<string> {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v));
  return new Promise((resolve, reject) =>
    execFile("git", [...SAFE_GIT_ARGS, ...args], { cwd, env: { ...process.env, ...clean, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null" } }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout.trim()))),
  );
}

/**
 * Commits made on the default branch itself move to a new branch (`name`), and the default branch goes
 * back to GitHub's: nothing is ever published as the default branch by accident. Returns the new
 * branch, or "" when the default branch has nothing of its own.
 */
export async function moveOffDefault(path: string, base: string, name: string): Promise<string> {
  if (!(await hasRef(path, `origin/${base}`)) || !(await hasRef(path, `refs/heads/${base}`))) return "";
  if (!Number(await git(path, "rev-list", "--count", base, "--not", `origin/${base}`))) return "";
  await git(path, "branch", name, base);
  for (const w of await worktrees(path)) if (w.branch === base) await git(w.path, "switch", "--quiet", name); // same commit: changes stay
  await git(path, "branch", "-f", base, `origin/${base}`);
  return name;
}

/** Carry the commits after `since` on `branch` onto a new branch `name` from origin/<base> (a merged PR's follow-ups). */
export async function carryOver(path: string, { branch, base, since, name }: { branch: string; base: string; since: string; name: string }): Promise<number> {
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
export async function dirtyCheckouts(repos: any[]) {
  const out: { repo: any; path: string; branch: string }[] = [];
  for (const r of repos) for (const w of await worktrees(r.path)) if (await git(w.path, "status", "--porcelain").catch(() => "")) out.push({ repo: r, path: w.path, branch: w.branch });
  return out;
}

/** Copy every local branch of a clone into the cache as refs/kept/<task>/… before a workspace is removed. */
export async function keepBranches(path: string, cache: string, identifier: string) {
  await git(cache, "fetch", "--quiet", path, `+refs/heads/*:refs/kept/${identifier}/*`).catch(() => {});
}

// ------------------------------------------------------------------ reviewed heads

/**
 * Where a reviewed head waits for the task that comes next: `refs/reviewed/<approval>/<branch>` in the runner's cache clone
 * of its repository. Under `refs/reviewed/`, never `refs/heads/`, so a task branch literally named `reviewed/…` is another
 * ref and neither shadows the other; and never on GitHub, so an unapproved head is published nowhere.
 */
export const REVIEWED = "refs/reviewed";
export const reviewedRef = (approval: string, branch: string) => `${REVIEWED}/${approval}/${branch}`;
/** What has been kept, and when: [{ repo, ref, at }], beside the cache clones (the refs themselves can't carry a date). */
const reviewedIndex = (cacheRoot: string) => join(cacheRoot, ".reviewed-refs.jsonl");
const readReviewed = (cacheRoot: string): any[] => {
  try {
    return readFileSync(reviewedIndex(cacheRoot), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l): any[] => {
        try {
          const e = JSON.parse(l);
          return typeof e?.repo === "string" && typeof e?.ref === "string" ? [e] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

/**
 * Keep the head a card reviewed, exactly (`sha`), in the cache clone `cache` of `repo`, as refs/reviewed/<approval>/<branch>,
 * so it outlives the task's workspace: the branch goes by name, and the object itself when the branch has moved on since.
 * Returns the ref; throws when what landed isn't `sha` (nothing is kept then).
 */
export async function keepReviewedHead(path: string, cache: string, { repo, approval, branch, sha, cacheRoot, now = new Date() }: { repo: string; approval: string; branch: string; sha: string; cacheRoot: string; now?: Date }): Promise<string> {
  const ref = reviewedRef(approval, branch);
  // The exact commit the card names, whatever its branch says by now (a commit the source clone has is enough).
  await git(cache, "fetch", "--quiet", "--no-tags", path, `+${sha}:${ref}`).catch(() => git(cache, "fetch", "--quiet", "--no-tags", path, `+refs/heads/${branch}:${ref}`));
  const got = await git(cache, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).catch(() => "");
  if (got !== sha) {
    if (got) await git(cache, "update-ref", "-d", ref).catch(() => {});
    throw new Error(`the reviewed head of ${repo} \`${branch}\` (${sha.slice(0, 9)}) isn't what landed at ${ref}, so nothing was kept`);
  }
  // Appended, one entry per line: two tasks filing cards at once each keep theirs (a rewrite could lose one).
  appendFileSync(reviewedIndex(cacheRoot), `${JSON.stringify({ repo, ref, at: now.toISOString() })}\n`);
  return ref;
}

/**
 * Drop kept reviewed heads past their retention (`days`, default 30) and any whose ref is already gone. The runner calls
 * this on its cache sweep; nothing else ever deletes them, and a merged PR's branch is still GitHub's to delete as before.
 */
export async function pruneReviewedRefs(cacheRoot: string, { days = 30, now = Date.now() } = {}) {
  const cut = now - days * 86_400_000;
  // One entry per ref, the latest date: a ref kept again (a second card on it) takes the newer retention.
  const latest = new Map<string, any>();
  for (const e of readReviewed(cacheRoot)) {
    const key = `${e.repo.toLowerCase()} ${e.ref}`;
    const prev = latest.get(key);
    if (!prev || Date.parse(e.at) > Date.parse(prev.at)) latest.set(key, e);
  }
  const kept: any[] = [];
  const removed: string[] = [];
  for (const e of latest.values()) {
    const cache = join(cacheRoot, ...e.repo.split("/"));
    const tip = await git(cache, "rev-parse", "--verify", "--quiet", `${e.ref}^{commit}`).catch(() => "");
    if (tip && Date.parse(e.at) >= cut) kept.push(e);
    else {
      if (tip) await git(cache, "update-ref", "-d", e.ref).catch(() => {});
      removed.push(e.ref);
    }
  }
  if (latest.size) writeFileSync(reviewedIndex(cacheRoot), kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return removed;
}


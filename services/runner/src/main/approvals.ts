import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isAgentSubtask } from "../agents.mjs";
import { asApproval, branchCardArgs } from "../cards.ts";
import { ISOLATED_ENV, SAFE_GIT_ARGS, git, historyRewritten, replayOnto, patchKey } from "../../../../modules/codehost-github/src/git.mjs";
import { READ, appRemoteUrl } from "../../../../modules/codehost-github/src/github-app.ts";
import { appliedNote } from "../prompt.ts";
import { UserError } from "../../../../modules/codehost-github/src/workspace.ts";
import * as prQueue from "../../../../modules/engineering/src/merge-queue.mjs";
import { cardBase, pickBranchPr, siblingBlock, siblingCandidates, siblingsOf } from "../siblings.ts";
import { laterRejections, rejectedSince } from "../../../../kernel/src/tier.ts";
import { readCardSourceExceptions, unreadSourceExceptions } from "../review-request.mjs";
import { appFor, botIdentity, cfg, execFileP, gho, log, pc, running, sameRepo, state } from "./context.ts";
import { CLOSED } from "./poll.ts";
import { reportActivity } from "./activity.ts";
import { cardDesignReviews } from "./watch.ts";
import { drainQueue } from "./dispatch.ts";
import { mergeGithub, startMerges } from "./merge.ts";
import { graded, tellParent } from "./grading.ts";
import { autonomyNow, branchTierState, currentTier, fileApproval, kernel, recordsOn, tierFor } from "./tier-state.ts";
import { applyApproved } from "./apply-path.ts";
import { publish } from "./pr-path.ts";
import { branchRows, createRepoApproved, findRealGh, prepareWorkspace } from "./unsplit.ts";

/** Busy on the task while an approved write runs: no agent turn starts, and the board shows it. */
async function whileApplying(issue: any, mode: any, fn: any) {
  if (running.has(issue.id)) throw new UserError("a run is in progress on the task");
  running.set(issue.id, { controller: new AbortController(), identifier: issue.identifier, startedAt: new Date().toISOString(), info: { mode } });
  reportActivity();
  try {
    return await fn(running.get(issue.id).controller.signal);
  } finally {
    running.delete(issue.id);
    reportActivity();
    drainQueue();
  }
}

/** Approved push or pr: the same branches at the same commits, or nothing. */
async function publishApproved(issue: any, a: any) {
  const task = state.task(issue.id);
  if (!task?.workspace) throw new UserError("the task has no workspace any more");
  const workspace = await prepareWorkspace(issue, task, { clone: false });
  const rows = await branchRows(issue, workspace);
  for (const b of a.args.only) {
    const r = rows.find((x) => x.repo.toLowerCase() === b.repo.toLowerCase() && x.branch === b.branch);
    const tip = r ? await git(r.path, "rev-parse", "--verify", `refs/heads/${b.branch}^{commit}`).catch(() => "") : "";
    if (tip !== b.sha) throw new UserError(`${b.repo} \`${b.branch}\` changed since it was approved (approved \`${b.sha.slice(0, 9)}\`, now ${tip ? `\`${tip.slice(0, 9)}\`` : "gone"}); nothing was published. The agent has to ask again.`);
    // A bound base: what goes out is still exactly the reviewed range on GitHub's default branch.
    if (b.base && (await trustedBase(r, b.sha).catch(() => "")) !== b.base) throw new UserError(`${b.repo} \`${b.branch}\` no longer leaves GitHub's default branch where the approved change did, so it would carry commits nobody reviewed; nothing was published. The agent has to ask again.`);
  }
  // Checked again right before the push: nothing rewrote the clone's history since the card.
  await refuseRewritten(a.args.only.map((b: any) => rows.find((x) => sameRepo(x.repo, b.repo) && x.branch === b.branch)));
  // Exactly the approved commits go out, whatever the branch says by the time they are pushed.
  const pins = new Map(a.args.only.map((b: any) => [pinKey(b.repo, b.branch), b.sha]));
  const out = await whileApplying(issue, a.action === "pr" ? "opening PRs" : "pushing branches", (signal: any) => publish(issue, workspace, a.action, signal, { only: a.args.only.map(({ repo, branch }: any) => ({ repo, branch })), text: a.args.text, check: async () => pins }));
  if (out.ok) {
    const by = a.decidedBy?.startsWith("reviewer:") ? "reviewer" : "owner";
    // Only a range bound into the card before it was reviewed can be replayed later: never a base found afterwards.
    for (const b of a.args.only.filter((x: any) => x.base)) approvedRecord(issue.id, b, { sha: b.sha, base: b.base, approval: a.id, action: a.action, merge: Boolean(a.args.merge), by, text: textHash(a.args.text) });
  }
  return out;
}

/**
 * Approved commits (owner, 2026-11-13: a PR card came back after every rebase with the same commits). Per task and branch,
 * the last approved head and the base it was approved on (its merge base with the default branch on GitHub), in runner
 * state. When the agent later publishes the same branch rebased onto a moved default branch, the runner replays those
 * approved commits itself onto GitHub's current tip, in its own clone (rebuild), and publishes its own result: the approved
 * change on the new base by construction. Any conflict, or any agent commit that isn't the replayed one tree for tree,
 * gets a new card.
 */
const approvedKey = (issueId: any, b: any) => `approved-commits:${issueId}:${b.repo.toLowerCase()}|${b.branch}`;
const approvedRecord = (issueId: any, b: any, record?: any) => (record ? state.set(approvedKey(issueId, b), JSON.stringify(record)) : JSON.parse(state.get(approvedKey(issueId, b)) || "null"));
/** Refuses a publish from a clone whose history reads differently from what it would push (git.mjs historyRewritten). */
async function refuseRewritten(rows: any) {
  for (const r of (new Map(rows.map((r: any) => [r.path, r])).values() as any)) {
    const why = await historyRewritten(r.path);
    if (why) throw new UserError(`Not done: ${r.repo} has ${why}, which makes git show different commits from the ones that would be pushed. Remove it and publish again.`);
  }
}

/** A published branch's key in a pin map: the repository case-insensitive, as rows and approvals spell it differently. */
const pinKey = (repo: any, branch: any) => `${String(repo).toLowerCase()}|${branch}`;
const textHash = (text: any) => (text ? createHash("sha256").update(JSON.stringify([text.title, text.body])).digest("hex") : undefined);

/**
 * The runner's own clone of a repository, for replaying approved commits (state dir: no job sees it), never an agent's
 * workspace, whose refs, remotes and objects the agent controls. Its origin is the real GitHub remote (through the App's
 * cache clone where the App covers it); objects reach it only through git's transfer, which hashes each one.
 */
async function checkRepo(slug: any) {
  const path = join(cfg.stateDir, "replay", ...slug.toLowerCase().split("/"));
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(path, { recursive: true });
    await execFileP("git", [...SAFE_GIT_ARGS, "init", "-q", path], { env: ISOLATED_ENV });
  }
  const url = (await appFor(slug)) ? appRemoteUrl(slug) : `git@github.com:${slug}.git`;
  await execFileP("git", [...SAFE_GIT_ARGS, "-C", path, "config", "remote.origin.url", url], { env: ISOLATED_ENV });
  return path;
}

const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
/** The repository's default branch, from GitHub (never the workspace's idea of it). */
async function githubDefault(slug: any) {
  const { stdout } = await execFileP(await findRealGh(), ["api", `repos/${slug}`, "--jq", ".default_branch"], await gho(slug, READ));
  const name = stdout.trim();
  if (!BRANCH_NAME.test(name)) throw new Error("no default branch");
  return name;
}

/**
 * The branch's own PR, in the runner's canonical read (merges.PR_QUERY), for the base a card's siblings are read against.
 * `existing` says whether the branch has a PR at all; a read that fails is `existing: true` with no PR, never "no PR" — an
 * unread base must claim no sibling, and only a branch that was never opened may take the default branch. The list is
 * asked for this head exactly (not a cached page of the repo's newest), so an older PR on the branch is still found.
 */
async function branchPr(repo: any, branch: any) {
  let found;
  try {
    found = JSON.parse((await execFileP(await findRealGh(), ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", "20", "--json", "number,state"], await gho(repo, READ))).stdout);
    if (!Array.isArray(found)) throw new Error("not a list");
  } catch (err: any) {
    log("branch PR unread", { repo, branch, err: String(err.message ?? err).slice(0, 160) });
    return { existing: true };
  }
  const picked = pickBranchPr(found);
  if (!picked.number) return { existing: picked.existing };
  const pr = (await mergeGithub.pr(repo, picked.number).catch(() => undefined))?.repository?.pullRequest;
  return { existing: true, pr };
}

/** The PR-carrying branch records of the task and its parent tasks (a chain deeper than 10 is not walked). */
async function taskChainRuns(issue: any) {
  const seen = [issue];
  for (let hops = 0; hops < 10; hops++) {
    const parentId = seen.at(-1)?.parentId;
    if (!parentId) break;
    const parent = await pc.issue(parentId).catch(() => undefined);
    if (!parent || seen.some((t) => t.id === parent.id)) break;
    seen.push(parent);
  }
  return seen.flatMap((t) => state.branches(t.id));
}

/**
 * A card's bases, from GitHub: cardBase (a PR's own base, the default branch only when the branch has no PR at all), and
 * for a merge card each PR's own. `own` is the PR that is the card's, never its sibling.
 */
async function cardBases({ branches = [], prs = [] }: any = {}) {
  const bases = [];
  for (const b of branches) {
    const own = await branchPr(b.repo, b.branch);
    bases.push({ repo: b.repo, base: cardBase({ existing: own.existing, pr: own.pr, defaultBranch: await githubDefault(b.repo).catch(() => undefined) }), own: own.pr?.number });
  }
  for (const p of prs) {
    const pr = (await mergeGithub.pr(p.repo, p.number).catch(() => undefined))?.repository?.pullRequest;
    bases.push({ repo: p.repo, base: typeof pr?.baseRefName === "string" ? pr.baseRefName : "", own: p.number });
  }
  return bases;
}

/**
 * The owner-approved source exceptions in a card's bases: `.github/supply-chain-source-exceptions.yaml` at each base branch,
 * never at the branch under review, so a change can never record its own approval. A missing or unreadable file is no
 * records, and no base at all (an apply card) is no block: an unread record never passes a new source.
 */
async function cardSources(bases: any) {
  if (!bases.length) return undefined;
  try {
    const gh = await findRealGh();
    // A base code could not name (a merge card's unreadable PR) is never guessed: readCardSourceExceptions skips it.
    const read = async (repo: any, url: any) => (await execFileP(gh, ["api", "-H", "Accept: application/vnd.github.raw", url], await gho(repo, READ, { maxBuffer: 4 * 1024 * 1024 }))).stdout;
    return await readCardSourceExceptions(bases, read);
  } catch (err: any) {
    log("source exceptions unread", { err: String(err.message ?? err).slice(0, 200) });
    return unreadSourceExceptions();
  }
}

/** The task's other PRs already merged into the card's bases: every name in the block is encoded, and it is fenced as data. */
async function cardSiblings(issue: any, bases: any) {
  try {
    // The task's PRs, and its parent tasks' (the fix may have landed as the delegator's PR): every branch record of the chain.
    // The card's own PRs are never its siblings: neither a merge card's nor the one its branch already has.
    const own: any = new Set(bases.filter((b: any) => b.own).map((b: any) => `${b.repo.toLowerCase()}#${b.own}`));
    const candidates = siblingCandidates(await taskChainRuns(issue), own);
    const seen = new Map();
    for (const { repo, base } of bases) {
      if (!base) continue;
      for (const s of await siblingsOf({ prs: candidates, base, repo, read: (slug, n) => mergeGithub.pr(slug, n), filesSince: (slug, name, oid) => mergeGithub.prBaseFiles(slug, name, oid) })) {
        seen.set(`${s.repo.toLowerCase()}#${s.number}`, s);
      }
    }
    return siblingBlock([...seen.values()]);
  } catch (err: any) {
    // Siblings are context, never a reason to refuse a card: an unread table is simply not shown.
    log("siblings unread", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) });
    return "";
  }
}

/**
 * What the reviewer reads from the base, never from the branch under review: the task's merged siblings and the owner's
 * recorded source approvals. Read once, so both the card's review and the pre-filing check see the same two blocks.
 */
async function cardContext(issue: any, target: any, known: any) {
  const bases = known ?? (await cardBases(target));
  return { siblings: await cardSiblings(issue, bases), sources: await cardSources(bases) };
}

/** `fn(path, oids, out)` with GitHub's `branches` fetched into the runner's clone (their tips: `oids`); `out` is a spare ref. */
async function withTrusted(slug: any, branches: any, fn: any) {
  if (!branches.every((b: any) => BRANCH_NAME.test(b ?? ""))) throw new Error("not a branch name");
  const path = await checkRepo(slug);
  const ref = `refs/check/${randomBytes(8).toString("hex")}`;
  const refs = branches.map((_: any, i: any) => `${ref}-${i}`);
  try {
    await git(path, "fetch", "--quiet", "origin", ...branches.map((b: any, i: any) => `+refs/heads/${b}:${refs[i]}`));
    return await fn(path, await Promise.all(refs.map((x: any) => git(path, "rev-parse", "--verify", `${x}^{commit}`))), `${ref}-out`);
  } finally {
    for (const x of [...refs, `${ref}-out`]) await git(path, "update-ref", "-d", x).catch(() => {});
  }
}

/**
 * Where a branch's commit `sha` (in the agent's workspace `r`) leaves GitHub's default branch: sent to the runner's clone
 * (git's transfer hashes every object) and merge-based there against the default branch as GitHub has it now.
 */
async function trustedBase(r: any, sha: any) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("not a commit");
  const main = await githubDefault(r.repo);
  return withTrusted(r.repo, [main], async (path: any, [tip]: any, out: any) => {
    await git(r.path, "push", "--quiet", "--no-verify", "--force", path, `${sha}:${out}`);
    return git(path, "merge-base", tip, sha);
  });
}

/**
 * A product branch's reviewed range, bound before anything is tiered, reviewed or carded: its trusted base must be the base
 * the workspace shows (so the diff the tier and the reviewer read is everything that would go out), and is returned to bind
 * into the card. Refuses on a mismatch (a stale or forged origin/main), and when it can't be read (try again). Undefined for
 * other repos.
 */
async function bindBase(r: any, sha: any) {
  if (!sameRepo(r.repo, cfg.productRepo)) return undefined;
  const shown = await git(r.path, "merge-base", `refs/remotes/origin/${r.defaultBase}`, sha).catch(() => "");
  // Unreadable fails closed: never back to the workspace's own origin for the product repo.
  const real = await trustedBase(r, sha).catch((err) => void log("trusted base unread", { repo: r.repo, branch: r.branch, err: String(err.message ?? err).slice(0, 200) }));
  if (!real) throw new UserError(`Not done: couldn't read where \`${r.branch}\` leaves GitHub's \`${r.defaultBase}\` (GitHub or the network on a bad minute), so nothing was published or filed. Try the same command again in a few minutes.`);
  if (real !== shown) throw new UserError(`Not done: \`${r.branch}\` leaves GitHub's \`${r.defaultBase}\` at \`${real.slice(0, 9)}\`, but your \`origin/${r.defaultBase}\` says \`${shown.slice(0, 9) || "nothing"}\`, so the change would include commits nobody sees. Fetch, rebase onto \`origin/${r.defaultBase}\` and publish again.`);
  return real;
}

/**
 * A push or PR request that runs on an earlier approval instead of a new card: every branch has an approval record of the
 * same action (and merge) and, when the request rewrites the PR's text, the same text; GitHub's branch is still the
 * approved commit; the default branch moved on; the approved commits replay onto its tip with no conflict; and the agent's
 * new commits are exactly the replayed ones, tree for tree (read from its workspace: a mismatch there only means a card).
 * The owner's approval holds at any tier; the reviewer's only while autonomy is full and the change is still Tier 1 or
 * lower. `t`: the request's tier now (undefined when unread: fails closed). Returns { records, pins (the runner's commits
 * to push), moves } or undefined.
 */
async function rebuild(issue: any, action: any, args: any, ordered: any, branches: any, t: any) {
  const records = await approvalStands(issue, action, args, ordered, branches, t);
  if (!records) return undefined;
  const pins = new Map();
  const moves = [];
  for (const [i, r] of ordered.entries()) {
    const rec = records[i];
    const theirs = branches[i].sha;
    const main = await githubDefault(r.repo);
    const built = await withTrusted(r.repo, [main, r.branch], async (path: any, [tip, onGithub]: any, out: any) => {
      if (onGithub !== rec.sha || (await git(path, "merge-base", "--is-ancestor", tip, rec.sha).then(() => true, () => false))) return null;
      const re = await replayOnto(path, rec.base, rec.sha, tip, await botIdentity());
      if (!re) return null;
      const commits = (await git(r.path, "rev-list", "--reverse", `${tip}..${theirs}`)).split("\n").filter(Boolean);
      const trees = [];
      for (const c of commits) trees.push(await git(r.path, "rev-parse", "--verify", `${c}^{tree}`));
      if (trees.join(" ") !== re.trees.join(" ")) return null;
      // Into the workspace, so the push pinned to it can send it: fetched by the workspace from the runner's clone.
      await git(path, "update-ref", out, re.tip);
      await git(r.path, "fetch", "--quiet", path, `+${out}:refs/aidenhq/replayed`);
      return { tip: re.tip, base: tip };
    }).catch((err) => void log("rebuild refused", { issue: issue.identifier, branch: r.branch, err: String(err.message ?? err).slice(0, 200) }));
    if (!built) return undefined;
    pins.set(pinKey(r.repo, r.branch), built.tip);
    moves.push({ r, from: theirs, to: built.tip, base: built.base });
  }
  return { records, pins, moves };
}

/**
 * Whether the earlier approvals of these branches still cover the request (rebuild() and rebaseInCode()): every branch has
 * an approval record of the same action (and merge, and text); the reviewer's yes only while autonomy is full and the
 * request is still Tier 1 or lower (`t`: its tier now, undefined fails closed); and no later rejection of these branches,
 * or of the same patch on another branch. The records, or undefined.
 */
async function approvalStands(issue: any, action: any, args: any, ordered: any, branches: any, t: any) {
  if (!t || t.reject) return undefined;
  const records = branches.map((b: any) => approvedRecord(issue.id, b));
  if (records.some((r: any) => !r || r.action !== action || r.merge !== Boolean(args.merge) || (args.text && r.text !== textHash(args.text)))) return undefined;
  if (records.some((r: any) => r.by !== "owner") && !(autonomyNow() === "full" && t.tier <= 1)) return undefined;
  // A later no on these branches (or the owner's veto) outranks an earlier yes; another branch's rejection doesn't.
  const cards = await recordsOn(issue);
  const since = records.map((r: any) => cards.find((c: any) => c.id === r.approval)?.decidedAt ?? "").sort()[0] ?? "";
  // A rejection on another branch blocks too when it carries the same patch (renamed and rebased): matched by content.
  const samePatch: any = new Set();
  for (const rj of laterRejections(cards, action, args.merge ? ["merge"] : [], since)) {
    for (const [i, r] of ordered.entries()) {
      for (const b of (rj.args?.only ?? []).filter((x: any) => sameRepo(x.repo, r.repo) && x.branch !== r.branch)) {
        // Its own bound base, else where it leaves the default branch as the workspace last fetched it.
        const theirs = await patchKey(r.path, b.base ?? `refs/remotes/origin/${r.defaultBase}`, b.sha).catch(() => null);
        const ours = await patchKey(r.path, records[i].base, records[i].sha).catch(() => null);
        if (!theirs || !ours || theirs === ours) samePatch.add(rj.id);
      }
    }
  }
  if (rejectedSince(cards, action, args.merge ? ["merge"] : [], branches, since, samePatch)) return undefined;
  return records;
}

/**
 * A product PR GitHub calls conflicting with its default branch (or red while behind a green one), rebased by the runner
 * itself before any Engineer job (owner, 2026-11-15: 48 jobs in a day were only rebases, several "clean, no conflict"). Its
 * approved commits are replayed onto GitHub's tip in the runner's own clone. Only when the replay is clean, the change
 * against its new base is the approved one (patchKey: the same lines, only the positions moved) and the approval still
 * stands (approvalStands) does it go out: force-pushed, leased to the approved head; the workspace branch moved to it (the
 * same trees); the approval record moved with it; and merged on the same approval. No new job, no new card. True when done;
 * anything else (a conflict, a changed diff, a job running, a branch the agent moved) is the Engineer's, as before.
 */
async function rebaseInCode(issue: any, pr: any, why: any) {
  if (running.has(issue.id)) return false;
  const repo = cfg.productRepo;
  const b = { repo, branch: pr.headRefName };
  const rec = approvedRecord(issue.id, b);
  const task = state.task(issue.id);
  if (!rec?.base || rec.action !== "pr" || rec.sha !== pr.headRefOid || !task?.workspace) return false;
  // Red on the runner's own rebase: the base wasn't the cause, so the Engineer looks (no replay onto every later commit).
  const mine = `rebased-in-code:${pr.url.toLowerCase()}`;
  if (why === "red" && state.get(mine) === pr.headRefOid) return false;
  return whileApplying(issue, "rebasing onto the default branch", async () => {
    const workspace = await prepareWorkspace(issue, task, { clone: false });
    const r = (await branchRows(issue, workspace)).find((x) => sameRepo(x.repo, repo) && x.branch === b.branch);
    if (!r || (await git(r.path, "rev-parse", "--verify", `refs/heads/${b.branch}^{commit}`).catch(() => "")) !== rec.sha) return false;
    // A checkout of the branch must be clean: it is moved to the rebased commit, files and all, so nothing is lost and the
    // next job doesn't start from the old base (whose files would read as reverting the default branch).
    const checkouts = (await git(r.path, "worktree", "list", "--porcelain")).split("\n\n").filter((w) => w.split("\n").includes(`branch refs/heads/${b.branch}`)).map((w: any) => w.split("\n")[0].replace(/^worktree /, ""));
    for (const w of checkouts) if (await git(w, "status", "--porcelain").catch(() => "dirty")) return false;
    const approved = [{ ...b, sha: rec.sha, base: rec.base }];
    const args = branchCardArgs(approved, { merge: rec.merge });
    const t = await tierFor(issue, "pr", { branches: [await branchTierState(r, rec.sha, rec.base)] }, rec.merge ? ["merge"] : []);
    if (!(await approvalStands(issue, "pr", args, [r], approved, t))) return false;
    const main = await githubDefault(repo);
    let replayRecord: any; // the replay's own record, filed before its push
    const moved = await withTrusted(repo, [main, b.branch], async (path: any, [tip, onGithub]: any, out: any) => {
      if (onGithub !== rec.sha || (await git(path, "merge-base", "--is-ancestor", tip, rec.sha).then(() => true, () => false))) return null;
      const re = await replayOnto(path, rec.base, rec.sha, tip, await botIdentity());
      const patch = re && (await patchKey(path, tip, re.tip));
      if (!re || (await patchKey(path, rec.base, rec.sha)) !== patch) return null;
      // Its record before anything is pushed, carried by the approval it replays (the kernel checks it: the same patch).
      const filed = await fileApproval(issue, { action: "pr", args: { ...args, only: [{ ...b, sha: re.tip, base: tip, ...(patch ? { patch } : {}) }] }, ts: [{ tier: 0, rule: "replayed-approval", reason: `the commits of approval ${rec.approval}, replayed by the runner onto a new base with no conflict` }], carries: [rec.approval] }).catch(() => undefined);
      if (filed?.state !== "used") return null;
      replayRecord = filed;
      await git(path, "update-ref", out, re.tip);
      await git(path, "push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${b.branch}:${rec.sha}`, await git(path, "remote", "get-url", "origin"), `${re.tip}:refs/heads/${b.branch}`);
      await git(r.path, "fetch", "--quiet", path, `+${out}:refs/aidenhq/replayed`);
      return { tip: re.tip, base: tip };
    }).catch((err) => void log("rebase in code refused", { issue: issue.identifier, branch: b.branch, err: String(err.message ?? err).slice(0, 200) }));
    if (!moved) return false;
    // GitHub has the replay: the workspace branch (its checkouts too), the approval and the push record follow it.
    if (checkouts.length) for (const w of checkouts) await git(w, "reset", "--quiet", "--hard", moved.tip).catch((err) => log("rebase in code: checkout not moved", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }));
    else await git(r.path, "update-ref", `refs/heads/${b.branch}`, moved.tip, rec.sha).catch(() => {});
    await git(r.path, "update-ref", "-d", "refs/aidenhq/replayed").catch(() => {});
    state.set(mine, moved.tip);
    await git(r.path, "fetch", "--quiet", "origin").catch(() => {});
    state.recordPush(repo, b.branch, moved.tip);
    approvedRecord(issue.id, b, { ...rec, sha: moved.tip, base: moved.base });
    const only = [{ ...b, sha: moved.tip, base: moved.base }];
    log("rebased in code", { issue: issue.identifier, pr: pr.url, from: rec.sha, to: moved.tip, onto: moved.base });
    const said = `Rebased by the runner: ${pr.url}'s approved commits (approval ${rec.approval}) replayed onto \`${main}\` at \`${moved.base.slice(0, 12)}\` with no conflict and the same change, pushed as \`${moved.tip.slice(0, 12)}\`. No job and no new card.`;
    const outcome = rec.merge ? await mergeAfterPublish(issue, { args: { ...args, only } }, { ok: true, text: said }) : { ok: true, text: said };
    await reportOutcome(replayRecord.id, outcome);
    await pc.comment(issue.id, outcome.text);
    return true;
  });
}

async function executeApproval(a: any) {
  const issue = await pc.issue(a.issueId);
  if (a.action === "pr" && a.args.merge) {
    const out = await publishApproved(issue, a);
    return out.ok ? mergeAfterPublish(issue, a, out) : out;
  }
  if (a.action === "push" || a.action === "pr") return publishApproved(issue, a);
  if (a.action === "apply") return applyApproved(issue, a);
  if (a.action === "create_repo") return createRepoApproved(issue, a);
  if (a.action === "merge") {
    await startMerges(issue, { prs: a.args.prs, gapMinutes: a.args.gap, strict: Boolean(a.decidedBy?.startsWith("reviewer:")) });
    const design = await cardDesignReviews(a.args.prs).catch((err) => (log("card design reviews failed", { err: String(err.message ?? err).slice(0, 300) }), ""));
    return { ok: true, text: `Merge queue started: ${a.args.prs.map((p: any) => p.url).join(", ")}. Its progress is on ${issue.identifier}.${design}` };
  }
  throw new UserError(`unknown action ${a.action}`);
}

/**
 * The merge half of an approved product PR card: each published PR goes on the task's merge queue bound to exactly the
 * commit the card showed, strict (every named check green on it, and the base branch green), as an approved merge card's
 * queue would. A head that moves afterwards stops it; a new card is needed then.
 */
async function mergeAfterPublish(issue: any, a: any, out: any) {
  const prs: any = [];
  const missing = [];
  for (const b of a.args.only) {
    const row = sameRepo(b.repo, cfg.productRepo) ? state.branches(issue.id).find((x) => sameRepo(x.repo, b.repo) && x.branch === b.branch) : undefined;
    const pr = row?.pr_url && !row.merged ? prQueue.findPrs(row.pr_url)[0] : undefined;
    if (pr) prs.push({ ...pr, head: b.sha, noReview: true });
    else missing.push(`${b.repo} \`${b.branch}\``);
  }
  const started = prs.length ? Boolean(await startMerges(issue, { prs, strict: true, during: true })) : false;
  const said = [prs.length ? (started ? `Merging ${prs.map((p: any) => p.url).join(", ")} once green on the approved commit.` : "The merge didn't start (said on the task).") : "", missing.length ? `Not merged (no open PR): ${missing.join(", ")}.` : ""].filter(Boolean).join(" ");
  return { ok: !missing.length && (started || !prs.length), text: `${out.text}\n\n${said}` };
}

/** Outcomes wait here until the kernel takes them (an apply restarts it): kept in state, retried every poll. */
function queueOutcome(id: any, outcome: any) {
  const box = JSON.parse(state.get("approval_outbox") || "{}");
  box[id] = { ok: Boolean(outcome.ok), text: String(outcome.text ?? "").slice(0, 8000) };
  state.set("approval_outbox", JSON.stringify(box));
}
/** A refusal retrying won't change (4xx), except 401/403: a runner key missing or wrong now is right again after a fix. */
const refusedForGood = (err: any) => / → 4(?!01|03)\d\d:/.test(String(err.message));
async function flushOutcomes() {
  const box = JSON.parse(state.get("approval_outbox") || "{}");
  for (const [id, o] of Object.entries(box)) {
    // Delivered, or refused for good (e.g. a record the kernel no longer knows): either way, not retried forever.
    const sent = await kernel("POST", `/v1/writes/${id}/outcome`, o).then(() => true, refusedForGood);
    if (sent) delete box[id];
  }
  state.set("approval_outbox", JSON.stringify(box));
}
/** A claimed record's outcome, queued and sent. */
async function reportOutcome(id: any, outcome: any) {
  queueOutcome(id, outcome);
  await flushOutcomes().catch(() => {});
}

/** Every poll, first: claim each approved record of the runner's once (approved → claimed in the kernel), run it, report how it went. Never retried. */
async function runApprovals() {
  await flushOutcomes();
  const { records = [] }: any = await kernel("GET", "/v1/writes?state=approved&limit=200");
  for (const a of records.map(asApproval)) {
    if (running.has(a.issueId)) continue; // after the run in progress
    const claimed = await kernel("POST", `/v1/writes/${a.id}/claim`).then(asApproval, (err) => void log("approval claim failed", { approval: a.id, err: String(err.message ?? err).slice(0, 200) }));
    if (!claimed) continue;
    log("approval claimed", { approval: a.id, issue: a.identifier, action: a.action });
    // One card's trouble is that card's outcome: a claimed record never goes without one, and the others still run this tick.
    await runClaimed(claimed).catch(async (err) => {
      const text = `Not run: ${String(err.message ?? err).slice(0, 2000)}`;
      log("approval dispatch failed", { approval: claimed.id, issue: claimed.identifier, action: claimed.action, err: text });
      await reportOutcome(claimed.id, { ok: false, text });
    });
  }
}

/** One claimed record: run it and report the outcome on the card and the task. */
async function runClaimed(claimed: any) {
  // A task closed since its card was approved runs nothing: what the card would publish or merge was asked for before
  // someone finished or cancelled the task, and the outcome on the task would reopen it. Done and cancelled alike, as the
  // classifier says (tiers.mjs); the card carries the outcome, the task hears nothing. A status we can't read is no proof
  // the task is open, so it refuses too (as the board's applyOnBoard does): an unreadable task runs nothing.
  const status = await pc.issue(claimed.issueId).then((i) => i.status, () => undefined);
  if (!status || CLOSED.includes(status)) {
    const text = `Not run: the task is ${status ?? "unreadable"}: a leftover request runs nothing.`;
    log("approval skipped: its task is closed", { approval: claimed.id, issue: claimed.identifier, status });
    await reportOutcome(claimed.id, { ok: false, text });
    return;
  }
  // The AI reviewer approved it: recompute the tier just before running. Refused by code now (it moved, say): it runs
  // nothing and the agent is told. Owner's now (autonomy off, a veto): a fresh card for the owner. The panel's now while one
  // reviewer approved it, or not checkable this minute: a fresh card for the reviewers.
  if (claimed.decidedBy?.startsWith("reviewer:")) {
    const issue = await pc.issue(claimed.issueId);
    const t: any =
      autonomyNow() !== "full"
        ? { tier: 2, reason: "autonomy is no longer full" }
        : await currentTier(issue, claimed).catch((err) => (err instanceof UserError ? { reject: true, tier: 2, reason: err.message } : { tier: 1, rule: "recheck", reason: `couldn't recheck it (${String(err.message ?? err).slice(0, 200)}), so it is reviewed again` }));
    const panelMissing = (t.panel || claimed.panel) && !claimed.decidedBy.includes("+");
    if (t.reject || t.tier > 1 || panelMissing || t.rule === "recheck") {
      const tier = t.reject || t.tier > 1 ? 2 : 1;
      const refiled = t.reject ? undefined : await fileApproval(issue, { action: claimed.action, args: claimed.args, diff: claimed.action === "apply" ? claimed.details : undefined, ts: [tier === 2 ? { ...t, tier: 2, reviewFirst: false, byMerit: false } : { ...t, tier: 1 }] }).catch(() => undefined);
      const text = t.reject
        ? `Not run: since the reviewer approved it, code refuses it (${t.reason}). Ask again.`
        : `Not run yet: ${panelMissing ? "it is authority-expanding now, so a second reviewer must approve it too" : tier === 2 ? `since the reviewer approved it, code puts it at Tier 2 (${t.reason})` : t.reason}.${refiled ? ` A new card (${refiled.id}) goes to ${tier === 2 ? cfg.selfName : "the reviewers"}.` : ""}`;
      log("tier rose before running", { approval: claimed.id, issue: claimed.identifier, reason: t.reason });
      await pc.comment(claimed.issueId, text).catch(() => {});
      await reportOutcome(claimed.id, { ok: false, text });
      return;
    }
  }
  let outcome;
  try {
    outcome = await executeApproval(claimed);
  } catch (err: any) {
    outcome = { ok: false, text: String(err instanceof UserError ? err.message : err.stderr || err.message || err).trim().slice(0, 2000) };
    await pc.comment(claimed.issueId, `**Approved, but it failed** (approval ${claimed.id}): ${outcome.text}`).catch(() => {});
  }
  log("approval applied", { approval: claimed.id, ok: outcome.ok });
  queueOutcome(claimed.id, outcome);
  // The agent that delegated this (e.g. the Agent Architect, on its chat) learns a failure, or the result of work no grade
  // will judge; a graded task's grade is the news (notices.ts).
  const full = await pc.issue(claimed.issueId).catch(() => null);
  if (full && isAgentSubtask(full)) {
    const kind = !outcome.ok ? "failed" : (await graded(full.id)) ? "applied" : "done";
    await tellParent(full, kind, appliedNote(claimed.identifier, claimed.id, outcome)).catch(() => {});
  }
  await flushOutcomes();
}

export { approvedRecord, bindBase, cardBases, cardContext, githubDefault, mergeAfterPublish, pinKey, rebaseInCode, rebuild, refuseRewritten, refusedForGood, reportOutcome, runApprovals, whileApplying, withTrusted };

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_MARKER, repoAllowed } from "../agents.mjs";
import { defaultBranch, ensureClone, ensureGuardHooks, git } from "../../../../modules/codehost-github/src/git.mjs";
import { READ, appRemoteUrl, inOrg } from "../../../../modules/codehost-github/src/github-app.ts";
import { retryTransient } from "../retry.ts";
import { branchGuidance, checkBranchName, chooseBranchName, exampleBranches } from "../branch.ts";
import { cleanMessages, leaksInternal } from "../describe.ts";
import { latestReport } from "../prompt.ts";
import { startRepoHelper } from "../repohelper.ts";
import { baseRef, branchChanges, carryOver, ensureRepo, findBranches, hasBranch, messagesSince, moveOffDefault, readManifest, repairWorkspaceGit, signUnsigned, workspacePath, workspaceRepos, UserError } from "../../../../modules/codehost-github/src/workspace.ts";
import { normalizeRepo, repoAccess } from "../../../../modules/codehost-github/src/repos.ts";
import { app, appFor, cfg, execFileP, gho, log, pc, state } from "./context.ts";
import { agentStatus, publicRepo } from "./dispatch.ts";
import { agentApply } from "./apply-path.ts";
import { agentPublish, agentReview, prRequest } from "./pr-path.ts";
import { agentAdvise, agentCleanup, agentClose, agentCreateRepo, agentEngine, agentMerge, agentPass, agentPrimer, agentReset, agentTask, agentTasks } from "./commands.ts";
import { saveTools } from "./jobs.ts";

// ------------------------------------------------------------------ workspaces

const BRANCH_DOCS = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", ".github/pull_request_template.md"];
const ghJson = async (args: any) => execFileP(await findRealGh(), args).then(({ stdout }) => JSON.parse(stdout), () => undefined);
let ghLogin;
const login = async () => (ghLogin ??= (await ghJson(["api", "user"]))?.login ?? "");
const recentPrs = new Map(); // repo → { at, prs }
async function repoPrs(slug: any) {
  const hit = recentPrs.get(slug);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.prs;
  const prs = (await ghJson(["pr", "list", "--repo", slug, "--state", "all", "--limit", "60", "--json", "headRefName,author"])) ?? [];
  recentPrs.set(slug, { at: Date.now(), prs });
  return prs;
}
const branchDocs = (path: any) => branchGuidance(BRANCH_DOCS.map((f) => [f, existsSync(join(path, f)) ? readFileSync(join(path, f), "utf8") : ""]));
const writable = (slug: any) => repoAllowed(normalizeRepo(slug), cfg.allowed_orgs);

/** Repositories this task works in besides its main one, remembered across runs. */
function rememberRepos(issueId: any, slugs: any) {
  const key = `repos:${issueId}`;
  const list = JSON.parse(state.get(key) || "[]");
  for (const s of slugs) if (!list.some((l: any) => l.toLowerCase() === s.toLowerCase())) list.push(s);
  state.set(key, JSON.stringify(list));
  return list;
}

/** Push access for repos no App covers, with the vault's admin token (read on each use, so adding it needs no restart). */
const access = () => repoAccess({ token: existsSync(cfg.githubAdminTokenFile) ? readFileSync(cfg.githubAdminTokenFile, "utf8").trim() : "", script: cfg.repoAccessScript });

/** True when slug is an agents-org repo that doesn't exist on GitHub (the App reads it; nothing is created). */
const missingRepo = async (slug: any) => Boolean(app && inOrg(cfg.agentsOrg, slug) && !cfg.repo_sources?.[slug]) && !(await app.repoExists(slug));
const missingRepoText = (slug: any) =>
  `\`${slug}\` doesn't exist on GitHub. Naming or adding a repository never creates it: check the name your task gives, and never try made-up names. Only when your task asks you to build a new app in a new repository, \`aidenhq create-repo ${slug}\` asks for it on an approval card.`;

/** Clone one repository into a workspace (from the runner's cache clone). */
async function addRepo(workspace: any, slug: any, { copy = false } = {}) {
  const repo: any = normalizeRepo(slug);
  const local = cfg.repo_sources?.[repo.slug];
  // Never created here: a repo named in a task, added by the agent or detected in text that doesn't exist (a typo, a path,
  // a probe) is an error. A new app's repo comes only from an approved create_repo card (`aidenhq create-repo`).
  if (await missingRepo(repo.slug)) throw new UserError(missingRepoText(repo.slug));
  // A repo an App covers goes over HTTPS with its tokens.
  const source = local ?? ((await appFor(repo.slug)) ? appRemoteUrl(repo.slug) : undefined);
  const cache = await ensureClone(cfg.workDir, repo, source);
  return ensureRepo(workspace, repo, { cache, copy, hooksDir: ensureGuardHooks(cfg.workDir), ...(source ? { remoteUrl: source } : {}) });
}

/**
 * The task's workspace, with its main repository and every other one it uses cloned (unless
 * `clone: false`).
 */
async function prepareWorkspace(issue: any, task: any, { clone = true, copy = false } = {}) {
  const workspace = task.workspace ?? workspacePath(cfg.workDir, issue.identifier);
  if (!task.workspace) state.updateTask(issue.id, { workspace });
  // A restart keeps the workspace, and a job's sandbox leaves an empty `.git` mount point at its root: the runner's git
  // would refuse every clone in it. Cleared before anything else touches the workspace (clone or not).
  if (repairWorkspaceGit(workspace)) log("cleared a stray .git at the workspace root", { issue: issue.identifier });
  if (clone) {
    mkdirSync(workspace, { recursive: true });
    for (const slug of [task.repo, ...rememberRepos(issue.id, [])].filter(Boolean)) {
      await addRepo(workspace, slug, { copy }).catch((err) => {
        if (slug === task.repo) throw err;
        log("repository clone failed", { issue: issue.identifier, repo: slug, err: String(err.message ?? err).slice(0, 300) });
      });
    }
  }
  return workspace;
}

/** `aidenhq-repo <org/name>` from a running job: clone another repository into its workspace. */
const repoHelper = startRepoHelper(async ({ issue, workspace, box }: any, raw) => {
  const repo = normalizeRepo(raw);
  if (!repo) throw new Error(`\`${raw}\` isn't a GitHub repository (use org/name).`);
  if (!repoAllowed(repo, cfg.allowed_orgs) && !(await publicRepo(repo.slug))) throw new Error(`${repo.slug} is outside ${cfg.allowed_orgs.join(", ")} and isn't a public repository I can read.`);
  // The run's own sandbox masks the workspace's root `.git` mount point: the same repair the runner makes before a
  // turn, so a clone in a turn that began before it still works.
  if (repairWorkspaceGit(workspace)) log("cleared a stray .git at the workspace root", { issue: issue.identifier });
  const path = await addRepo(workspace, repo.slug, { copy: Boolean(box) });
  rememberRepos(issue.id, [repo.slug]);
  log("repository added by the agent", { issue: issue.identifier, repo: repo.slug });
  // A box job sees its workspace at /workspace.
  return `${repo.slug} is at ${box ? path.replace(workspace, "/workspace") : path} (default branch ${await defaultBranch(path)})${writable(repo.slug) ? "" : ". It is read-only: changes there can't be published"}.`;
}, log, {
  status: agentStatus,
  push: (ctx, args) => agentPublish(ctx, "push", args),
  review: agentReview,
  pr: (ctx, args) => agentPublish(ctx, "pr", args),
  merge: agentMerge,
  close: agentClose,
  "create-repo": agentCreateRepo,
  apply: agentApply,
  engine: async (ctx, args) => agentEngine(ctx, args).finally(() => saveTools(ctx)),
  primer: agentPrimer,
  pass: agentPass,
  reset: async (ctx) => agentReset(ctx).finally(() => saveTools(ctx)),
  cleanup: async (ctx) => agentCleanup(ctx).finally(() => saveTools(ctx)),
  task: agentTask,
  tasks: agentTasks,
  advise: agentAdvise,
}, cfg.helperPort);
// One port across restarts: runs a restart left going keep reaching their tools.
// The one host port a job's jail opens besides the kernel's 8201 (runner.yaml helper_port): the kernel refuses any other.
repoHelper.listening.then((port) => port !== cfg.helperPort && log("WARNING: the helper isn't on its port: jobs can't start until it is", { port, want: cfg.helperPort }));

/** Each repository in the workspace for the prompt; with `naming`, its branch naming rules and examples. */
async function repoInfo(workspace: any, { naming }: any = {}) {
  const out = [];
  for (const r of await workspaceRepos(workspace)) {
    const info: any = { slug: r.slug, path: r.path, base: await defaultBranch(r.path), writable: writable(r.slug) };
    if (naming && info.writable) {
      const examples = exampleBranches(await repoPrs(r.slug), { login: await login(), base: info.base });
      const guidance = branchDocs(r.path);
      info.naming = [
        guidance ? `From the repository's guides:\n\n${guidance}` : "",
        examples.mine.length ? `${cfg.selfName}'s recent branches here: ${examples.mine.slice(0, 10).map((b) => `\`${b}\``).join(", ")}` : "",
        examples.others.length ? `Others' recent branches: ${examples.others.slice(0, 12).map((b) => `\`${b}\``).join(", ")}` : "",
        !guidance && !examples.mine.length && !examples.others.length ? "No convention found: use `<type>/<short-description>` with a conventional commit type." : "",
      ].filter(Boolean).join("\n\n");
    }
    out.push(info);
  }
  return out;
}

/** A branch name in the repository's style for commits that aren't on a proper branch yet. */
async function nameBranch(issue: any, { path, slug, base, messages = [] }: any) {
  const full = await pc.issue(issue.id);
  const taken = async (name: any) => Boolean(await git(path, "branch", "--list", name)) || Boolean(await git(path, "ls-remote", "--heads", "origin", name).catch(() => ""));
  const { name, generated } = await chooseBranchName({
    cfg, repo: slug, base, defaultBranch: base, login: await login(), guidance: branchDocs(path), prs: await repoPrs(slug),
    request: await prRequest(full), messages: cleanMessages(messages.join("\x1e")), title: leaksInternal(full.title) ? "" : full.title, taken,
  });
  log("branch named", { issue: issue.identifier, repo: slug, branch: name, generated });
  return name;
}

/**
 * After a run, and before publishing: move commits made on a default branch or a detached HEAD onto a branch, rename branches that aren't publishable
 * (aidenhq/…, internal words), and sign the agent's commits. Returns notes for the report.
 */
async function tidyBranches(issue: any, workspace: any) {
  const notes = [];
  for (const r of await workspaceRepos(workspace)) {
    const base: any = await defaultBranch(r.path);
    try {
      const onBase = await messagesSince(r.path, `origin/${base}`, base).catch(() => []);
      if (onBase.length) {
        const moved = await moveOffDefault(r.path, base, await nameBranch(issue, { path: r.path, slug: r.slug, base, messages: onBase }));
        if (moved) notes.push(`Commits made on \`${base}\` in ${r.slug} were moved to \`${moved}\`.`);
      }
      for (const b of await findBranches(r.path, { base, slug: r.slug, known: state.branches(issue.id).filter((k) => k.repo === r.slug).map((k) => k.branch) })) {
        if (b.branch === base || checkBranchName(b.branch, { base, defaultBranch: base }) || (await git(r.path, "ls-remote", "--heads", "origin", b.branch).catch(() => ""))) continue;
        const name = await nameBranch(issue, { path: r.path, slug: r.slug, base, messages: await messagesSince(r.path, `origin/${base}`, b.branch) });
        await git(r.path, "branch", "-m", b.branch, name);
        state.deleteBranch(issue.id, r.slug, b.branch);
        notes.push(`Renamed \`${b.branch}\` to \`${name}\` in ${r.slug}.`);
      }
      await signUnsigned(r.path);
    } catch (err: any) {
      log("tidy failed", { issue: issue.identifier, repo: r.slug, err: String(err.stderr || err.message || err).slice(0, 300) });
      notes.push(`Couldn't finish tidying ${r.slug}'s branches: ${String(err.stderr || err.message || err).trim().split("\n").pop()!.slice(0, 200)}`);
    }
  }
  return notes;
}

/** Every local branch tip in the workspace, as one string: compared before and after a run. */
async function branchTips(workspace: any) {
  const out = [];
  for (const r of await workspaceRepos(workspace)) out.push(`${r.slug}\n${await git(r.path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").catch(() => "")}`);
  return out.join("\n");
}

/**
 * The task's branches now, saved to the state: every local branch with commits of its own in
 * every workspace repository, with what GitHub doesn't have yet. Rows of branches that disappeared
 * are dropped unless they were pushed.
 */
async function branchRows(issue: any, workspace: any) {
  const manifest = readManifest(workspace);
  const rows = [];
  const repos = await workspaceRepos(workspace);
  for (const r of repos) {
    const base: any = await defaultBranch(r.path);
    const found = await findBranches(r.path, { base, manifest, slug: r.slug, known: state.branches(issue.id).filter((k) => k.repo === r.slug).map((k) => k.branch) });
    for (const b of found) state.saveBranch(issue.id, { repo: r.slug, branch: b.branch, base: b.base, purpose: b.purpose });
    for (const k of state.branches(issue.id).filter((k) => k.repo === r.slug && !found.some((b: any) => b.branch === k.branch))) {
      if (!k.pushed && !k.pr_url) state.deleteBranch(issue.id, k.repo, k.branch);
    }
    const taskBranches = state.branches(issue.id).filter((k) => k.repo === r.slug).map((k) => k.branch);
    for (const b of state.branches(issue.id).filter((k) => k.repo === r.slug)) {
      if (!(await hasBranch(r.path, b.branch))) continue;
      const head = await git(r.path, "rev-parse", "--verify", "--quiet", `refs/heads/${b.branch}`).catch(() => "");
      const c = await branchChanges(r.path, { branch: b.branch, base: b.base, taskBranches });
      rows.push({ repo: r.slug, path: r.path, branch: b.branch, head, base: b.base, baseRef: await baseRef(r.path, { branch: b.branch, base: b.base, taskBranches }), defaultBase: base, purpose: b.purpose, unpublished: c.unpublished, stat: c.stat, onGitHub: c.onGitHub, pushed: b.pushed, prUrl: b.pr_url ?? undefined, merged: b.merged, writable: writable(r.slug), readOnly: !writable(r.slug) });
    }
  }
  return rows;
}

/** Last few lines of a job log, without terminal colour codes (for failure reports). */
function logTail(path: any, lines = 6) {
  try {
    return readFileSync(path, "utf8").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter((l) => !l.startsWith("#")).slice(-lines).join("\n").slice(-1500) || "(empty)";
  } catch {
    return "(log unavailable)";
  }
}

async function lastReport(issueId: any) {
  const comments = [...(await pc.comments(issueId))].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return latestReport(comments.map((c) => c.body), RUNNER_MARKER);
}

/**
 * PRs of the task's branches that were merged or closed since we last looked. A closed one is
 * forgotten, so "pr" opens a new one. A merged one stays as merged; commits made on its branch after
 * the merge move to a new branch from the latest default branch. Returns sentences for the user.
 */
async function leaveFinishedPrs(issue: any, workspace: any) {
  const notes = [];
  const repos = await workspaceRepos(workspace);
  for (const b of state.branches(issue.id).filter((b) => b.pr_url && !b.merged)) {
    let pr;
    try {
      const { stdout } = await execFileP(await findRealGh(), ["pr", "view", b.pr_url, "--json", "state,number,headRefOid"], await gho(b.repo, READ));
      pr = JSON.parse(stdout);
    } catch (err: any) {
      log("pr state check failed", { issue: issue.identifier, err: String(err.stderr || err.message).slice(0, 300) });
      continue;
    }
    if (pr.state === "OPEN") continue;
    if (pr.state === "CLOSED") {
      // Closed without merging: remembered as closed, so a receipt leaves the finished work out. `pr` still opens a new one:
      // it takes the closed row as a branch with no PR and clears the flag when it does.
      state.updateBranch(issue.id, b.repo, b.branch, { pr_url: null, closed: 1, closed_head: pr.headRefOid ?? null });
      notes.push(`PR #${pr.number} (\`${b.branch}\`) was closed without merging, so **pr** will open a new one.`);
      continue;
    }
    state.updateBranch(issue.id, b.repo, b.branch, { merged: 1 });
    const r = repos.find((x) => x.slug === b.repo);
    if (!r) continue;
    const base: any = await defaultBranch(r.path);
    let note = `PR #${pr.number} (\`${b.branch}\`) is merged.`;
    try {
      const after = await git(r.path, "rev-list", "--count", `${pr.headRefOid}..${b.branch}`).catch(() => "0");
      if (Number(after)) {
        const next = await nameBranch(issue, { path: r.path, slug: r.slug, base, messages: await messagesSince(r.path, pr.headRefOid, b.branch) });
        const carried = await carryOver(r.path, { branch: b.branch, base, since: pr.headRefOid, name: next });
        note += ` The ${carried} commit${carried === 1 ? "" : "s"} made on it since moved to a new branch \`${next}\` from the latest \`${base}\`.`;
      }
    } catch (err: any) {
      note += ` The commits made on it since don't apply cleanly on the latest \`${base}\`, so they're still on \`${b.branch}\`. Git said: ${String(err.stderr || err.message).trim().split("\n").pop()!.slice(0, 200)}`;
    }
    log("pr merged", { issue: issue.identifier, pr: pr.number, branch: b.branch });
    notes.push(note);
  }
  return notes;
}

/** True when the task has commits on a branch (something to push or open a PR for). */
async function taskHasCommits(task: any) {
  if (!task?.workspace || !existsSync(task.workspace)) return false;
  for (const r of await workspaceRepos(task.workspace)) if ((await findBranches(r.path, { base: (await defaultBranch(r.path) as any), known: state.branches(task.issue_id).filter((k) => k.repo === r.slug).map((k) => k.branch) }).catch(() => [])).length) return true;
  return false;
}

let realGh;
/** The host's gh (the runner's own login), found once. */
async function findRealGh() {
  return (realGh ??= (await execFileP("sh", ["-c", "command -v gh"])).stdout.trim());
}

async function reportError(issue: any, err: any) {
  const userFacing = err instanceof UserError || /not allowed|unknown engine|isn't set up|this task's workspace/.test(String(err.message));
  log("error", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 500) });
  try {
    await retryTransient(() => pc.comment(issue.id, userFacing ? err.message : `Runner error: \`${String(err.message ?? err).slice(0, 400)}\``));
  } catch {
    /* Paperclip unavailable: logged above */
  }
}

export { access, branchRows, branchTips, findRealGh, lastReport, leaveFinishedPrs, logTail, missingRepo, prepareWorkspace, rememberRepos, repoHelper, repoInfo, reportError, taskHasCommits, tidyBranches };

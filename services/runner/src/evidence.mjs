// Evidence, read by code (wave 3, item 5): one function per deliverable kind, shared by the grader (grade.mjs gather) and
// the duplicate-card guard (item 4). Facts here were checked by code and are trusted; anything an agent wrote is returned
// as data for the caller to fence. Nothing here closes a task or decides a card: it only reports what is true.
import { createHash } from "node:crypto";
import { findPrs, namedChecks } from "./merges.mjs";
import { MAX_DIFF } from "./review.mjs";

/** Marks the grader's own notes on a task, so they never count as the deliverable's evidence. */
export const GRADER_MARKER = "<!-- aidenhq:grader -->";

/** The board's reason code for a change already satisfied on the target (services/board/src/approvals.ts ALREADY_APPLIED). */
export const ALREADY_APPLIED = "already_applied";

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * The task's PRs as evidence: { awaiting } or { version, facts, data }. `prs` are the runner's own PRs for the task, narrowed
 * by the ref (a PR named only in the ref is never read). deps: pr(repo, n) (merges.PR_QUERY's data), diff(repo, n), ownRepo(slug).
 */
export async function prEvidence(prs, ref, deps) {
  prs = byRef(prs, ref);
  if (!prs.length) return { awaiting: "no pull request yet" };
  const facts = [];
  const versions = [];
  let diff = "";
  for (const p of prs.slice(0, 5)) {
    const pr = (await deps.pr(p.repo, p.number))?.repository?.pullRequest;
    if (!pr) return { awaiting: `${p.url} can't be read yet` };
    const checks = namedChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup);
    if (checks.some((c) => c.pending)) return { awaiting: `checks still running on ${p.url}` };
    // Outside the agents org and the product repo the runner can't merge and the owner doesn't: someone else merges it.
    if (pr.state === "OPEN" && deps.ownRepo && !deps.ownRepo(p.repo)) return { awaiting: `${p.url} is not merged yet` };
    const merged = pr.state === "MERGED";
    const sha = merged ? (pr.mergeCommit?.oid ?? pr.headRefOid) : pr.headRefOid;
    versions.push(`${p.repo}#${p.number}@${sha}`);
    facts.push(`${p.url}: ${pr.state.toLowerCase()}${merged ? ` into ${pr.baseRefName}` : ` (base ${pr.baseRefName})`}, head ${pr.headRefOid}${merged && pr.mergeCommit?.oid ? `, merge commit ${pr.mergeCommit.oid}` : ""}; checks: ${checks.length ? checks.map((c) => `${c.name} ${c.ok ? "green" : "red"}`).join(", ") : "none"}`);
    diff += `### ${p.url}\n${(await deps.diff(p.repo, p.number).catch(() => "(the diff could not be read)")).slice(0, MAX_DIFF)}\n`;
  }
  // The board keeps a version in 200 characters: several PRs are bound by their hash.
  const version = versions.join(" ").length <= 200 ? versions.join(" ") : `prs:${hash(versions.join(" "))}`;
  return { version, facts, data: { DIFF: diff.slice(0, MAX_DIFF) } };
}

/** A deployed app (apps-mcp status row, or null) as evidence: its commit, state, health and incident. */
export function appEvidence(app, name) {
  if (!app) return { awaiting: `no app named ${name || "(none)"} is deployed yet` };
  if (!app.sha) return { awaiting: `${app.name} is not deployed yet` };
  const facts = [`app ${app.name}: deployed commit ${app.sha}${app.deployed_at ? ` at ${app.deployed_at}` : ""}; state ${app.state}; ${app.healthy ? "healthy" : "not healthy"}; ${app.incident ? `open incident (${app.incident.kind})` : "no open incident"}`];
  return { version: `${app.name}@${app.sha}`, facts, data: {} };
}

/** The task's latest fleet apply (its approval records) as evidence: its state and outcome. */
export function applyEvidence(cards) {
  const applied = cards.filter((a) => a.action === "apply").at(-1);
  if (!applied) return { awaiting: "no apply filed yet" };
  const facts = [`apply ${applied.id}: ${applied.state}${applied.outcome ? `, ${applied.outcome}` : ""}`];
  return { version: applied.id, facts, data: { APPLY_OUTCOME: applied.outcomeText ?? "", APPLY_CHANGE: applied.details ?? "" } };
}

/** The task's own words (the latest comments other than the grader's) and its files: the evidence for file and report, context for the rest. */
export async function wordsEvidence(deps) {
  const comments = (await deps.comments()).filter((c) => !String(c.body ?? "").includes(GRADER_MARKER)).slice(-4);
  const files = await deps.attachments().catch(() => []);
  const facts = files.length ? [`files attached: ${files.map((f) => f.originalFilename ?? f.name ?? f.id).join(", ")}`] : ["no files attached"];
  const version = comments.length || files.length ? hash([...comments.map((c) => c.id), ...files.map((f) => f.id)].join(" ")) : "";
  return { version, facts, data: { TASK_COMMENTS: comments.map((c) => String(c.body ?? "")).join("\n\n---\n\n"), ...(files.length ? { FILES: (await deps.fileTexts?.(files).catch(() => "")) ?? "" } : {}) } };
}

/**
 * Whether one branch commit is already satisfied on the target's current default branch (the duplicate-card guard): its
 * commit is an ancestor of `origin/<base>`, or every file it changes against their merge base is identical there. Reads only
 * the caller's own fetch. { satisfied, evidence }; any git error is "not satisfied", so a card is filed (the safe direction).
 * `git(path, ...args)` resolves with trimmed stdout and rejects on a non-zero exit.
 */
export async function onMain(git, path, base, sha) {
  const main = `refs/remotes/origin/${base}`;
  try {
    const tip = await git(path, "rev-parse", "--verify", `${main}^{commit}`);
    if (await git(path, "merge-base", "--is-ancestor", sha, main).then(() => true, () => false)) return { satisfied: true, evidence: `commit \`${sha.slice(0, 12)}\` is already on \`${base}\` (at \`${tip.slice(0, 12)}\`)` };
    const mb = await git(path, "merge-base", main, sha);
    // NUL-separated (unusual names are not C-quoted), each a literal pathspec (no globbing on names like app/[id]).
    const files = (await git(path, "diff", "-z", "--no-renames", "--name-only", mb, sha)).split("\0").filter(Boolean);
    // No files: nothing to compare (an empty pathspec would diff the whole tree).
    if (!files.length) return { satisfied: false };
    const same = await git(path, "diff", "--quiet", "--no-renames", main, sha, "--", ...files.map((f) => `:(literal)${f}`)).then(() => true, () => false);
    return same ? { satisfied: true, evidence: `every file \`${sha.slice(0, 12)}\` changes (${files.length}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}) is already identical on \`${base}\` (at \`${tip.slice(0, 12)}\`)` } : { satisfied: false };
  } catch {
    return { satisfied: false };
  }
}

/**
 * The guard for one branch row of `aidenhq push`/`pr` (main.mjs branchRows: `unpublished` commits and the diffstat against its
 * base, read before the guard's fetch): a branch with no commits of its own has nothing to be satisfied, so it is never
 * "already applied" (its tip is trivially an ancestor of main); otherwise onMain.
 */
export async function guardBranch(git, row, sha) {
  if (!row.unpublished?.length && !row.stat) return { satisfied: false };
  return onMain(git, row.path, row.defaultBase, sha);
}

/** The task's PRs the ref narrows to: a PR ref (link or owner/name#n) by repo and number, a repo ref by repo, else all. */
function byRef(prs, ref) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const named = findPrs(ref);
  if (named.length) return prs.filter((p) => named.some((n) => same(n.repo, p.repo) && n.number === p.number));
  const repo = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(ref ?? "").trim())?.[1];
  return repo ? prs.filter((p) => same(p.repo, repo)) : prs;
}

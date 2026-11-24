// The code host's merge gate: whether an approved merge record's PR merges now, from GitHub's view of it. One decision per PR
// (`decide`); merges.ts polls, merges and reports. A PR merges only when it is open on the default branch, at the head the
// record bound (only our own repos: agents org and product; the approved record is the review), every named
// check is green on that head, GitHub can merge it and the default branch is green (or this PR already holds its tip: its own
// checks proved the tree after the merge, so a fix for a red base lands, and a PR at the tip doesn't wait for the tip's CI).
// Anything else waits (with no
// time limit: merges.ts) or fails with the reason: nothing here updates, rebases, retargets,
// re-runs or forces. A moved head, a moved base (behind, conflicts) or a red check goes back to the PR's own path, which asks
// for a new merge at its new head. Missing evidence (no checks, a truncated page of checks, the base's aggregate gate
// check not yet on the head) never counts as passing.

import { DESIGN_REVIEW_CHECK, GATE_CHECK, contextStatus, namedChecks, skippedImageScan } from "./aidenhq-sdk/checks.ts";
import type { ReviewGate } from "./review-gate.ts";

/** A check on a head, by name (service.ts checksAt, checks.ts namedChecks). */
export type NamedCheck = { name?: string; ok?: boolean; success?: boolean; pending?: boolean; skipped?: boolean };
/** Code review's answer for a head (review-gate.ts). */
export type Verdict = Awaited<ReturnType<ReviewGate>>;

/**
 * The one product-merge eligibility rule (owner, 2026-11-23), used when planning (plan.ts) and again right before the merge
 * (merges.ts): the product repo, `ci-required` successful on this exact head, and code review's real pass for it (a bypass,
 * an ungated repo or a wait is not one). Eligible, a product merge skips the AI reviewer.
 */
export function productMergeEligible(p: { repo: string; head: string; checks: NamedCheck[]; verdict: Verdict | undefined; productRepo: string }): boolean {
  const same = String(p.repo).toLowerCase() === String(p.productRepo ?? "").toLowerCase() && Boolean(p.productRepo);
  // Success itself: a neutral or skipped gate is no pass for a merge that skips the reviewer.
  const ci = p.checks.some((c) => c.name === GATE_CHECK && c.success === true && !c.pending);
  return same && Boolean(p.head) && ci && Boolean(p.verdict && "pass" in p.verdict && p.verdict.pass === true);
}

// GitHub GraphQL payloads (PR_QUERY's answer), read by field.
type Json = any;

export const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $pullRef: String!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      id number title body url state isDraft reviewDecision mergeStateStatus headRefOid headRefName isCrossRepository baseRefName
      mergedAt mergedBy { login } mergeCommit { oid message }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      latestOpinionatedReviews(first: 30) { nodes { state } }
      reviews(last: 100) { nodes { state commit { oid } author { login } } }
      reviewRequests(first: 30) { nodes { asCodeOwner requestedReviewer { __typename ... on Team { combinedSlug } ... on User { login } } } }
      isInMergeQueue mergeQueueEntry { headCommit { oid } }
      timelineItems(last: 10, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { __typename ... on AddedToMergeQueueEvent { createdAt } ... on RemovedFromMergeQueueEvent { createdAt reason beforeCommit { oid } actor { __typename login } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state description } } } } } } }
      baseRef { compare(headRef: $pullRef) { behindBy } target { oid ... on Commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
    }
  }
}`;

const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/**
 * Files that change what people see: styles, markup and component files, the usual UI folders, the vendored design system,
 * and server-rendered page code by its name (render, styles, layout, view, page, template). Conservative: a false match
 * costs a design review (advisory: it never holds a merge), a miss leaves a page unreviewed.
 */
const UI_EXT = /\.(css|scss|sass|less|html?|tsx|jsx|vue|svelte|astro|hbs|handlebars|ejs|njk|pug|erb|liquid|mustache)$/i;
const UI_DIR = /(^|\/)(web|public|templates|views|static|pages|components|layouts|design-system)\//i;
const UI_PAGE_CODE = /(^|\/)([^/]*[-_.])?(render|styles?|layouts?|views?|pages?|templates?)\.(m?[jt]s|cjs)$/i;
const isUiFile = (f: string) => UI_EXT.test(f) || UI_DIR.test(f) || UI_PAGE_CODE.test(f);

/** Whether the PR changes UI files. A file list cut off at the first page counts as UI; no list at all doesn't. */
export function prTouchesUi(pr: Json) {
  const files = pr?.files?.nodes;
  if (!Array.isArray(files)) return false;
  if (pr.files.pageInfo?.hasNextPage) return true;
  return files.some((f: Json) => isUiFile(f.path ?? ""));
}

/** The design-review check on a rollup: "success", "failure", "pending" or "missing". */
function designReview(rollup: Json) {
  const n = (rollup?.contexts?.nodes ?? []).find((n: Json) => (n.name ?? n.context) === DESIGN_REVIEW_CHECK);
  if (!n) return "missing";
  const v = contextStatus(n);
  return v === "SUCCESS" ? "success" : FAILING.has(v as string) ? "failure" : "pending";
}

/**
 * Why an open design-review task no longer needs its reviewer, from its marker ({ head }) and the PR as GitHub returns it: its
 * head moved on, the PR merged or closed, or a verdict is on that exact head already. Undefined while it is still the one live
 * review (or the PR can't be read: unknown is never a reason to close).
 */
export function supersededDesignReview(marker: Json, pr: Json) {
  if (!marker || !pr) return undefined;
  // A merged PR's review stays open: the verdict is advisory, and a defect on the shipped head becomes a follow-up fix.
  if (pr.state === "CLOSED") return "its PR was closed";
  if (pr.headRefOid && pr.headRefOid !== marker.head) return `its PR has moved on to head \`${String(pr.headRefOid).slice(0, 12)}\``;
  const dr = designReview(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup);
  return dr === "success" || dr === "failure" ? "its verdict is on that head already" : undefined;
}

/**
 * The aggregate gate check a repository's CI may end with (the product's ci.yml `ci-required`): it appears only once the jobs it
 * covers finish, so a head can look all green before it. When the base branch's rollup has it, a head without it is pending.
 */
const hasGate = (rollup: Json) => (rollup?.contexts?.nodes ?? []).some((n: Json) => (n.name ?? n.context) === GATE_CHECK);
export function withGate(data: Json) {
  const pr = data?.repository?.pullRequest;
  if (pr?.state && pr.state !== "OPEN") return data;
  const head = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!head || !hasGate(pr?.baseRef?.target?.statusCheckRollup) || hasGate(head)) return data;
  head.contexts = { ...(head.contexts ?? {}), nodes: [...(head.contexts?.nodes ?? []), { __typename: "CheckRun", name: GATE_CHECK, status: "QUEUED", conclusion: null }] };
  return data;
}

/**
 * The default branch's CI at its tip: "red", "pending" or "green" (no checks: green). A cancelled check never judged the commit
 * (a newer push superseded its run), and the aggregate gate check fails along with it, so neither makes the base red.
 */
function baseCi(rollup: Json) {
  const named = namedChecks(rollup);
  const cancelled = named.some((c) => c.status === "CANCELLED");
  if (named.some((c) => !c.ok && !c.pending && c.status !== "CANCELLED" && !(cancelled && c.name === GATE_CHECK))) return "red";
  return named.some((c) => c.pending) ? "pending" : "green";
}

/** The merge method: squash, then merge commit, then rebase, as the repository allows. */
export function mergeMethod(repo: Json) {
  if (repo.squashMergeAllowed) return "squash";
  if (repo.mergeCommitAllowed) return "merge";
  if (repo.rebaseMergeAllowed) return "rebase";
  return undefined;
}

/**
 * What to do with one PR of an approved record, from `data` (PR_QUERY's answer, withGate applied) and the record's bound `head`:
 * { do: "merge" | "done" | "wait" | "fail", why }. Before a "merge", merges.ts still asks code review's gate.
 * Only our own repos (agents org, product) reach it, so the record is the review. The design review is advisory: it never
 * holds a merge.
 */
export function decide(data: Json, head: string) {
  const pr = data?.repository?.pullRequest;
  if (!pr) return { do: "fail", why: "not found on GitHub" };
  if (pr.state === "MERGED") return pr.headRefOid === head ? { do: "done", why: "already merged" } : { do: "fail", why: `merged by someone else at \`${String(pr.headRefOid).slice(0, 12)}\`, not the approved head` };
  if (pr.state !== "OPEN") return { do: "fail", why: "closed" };
  const def = data.repository.defaultBranchRef?.name;
  if (!def || pr.baseRefName !== def) return { do: "fail", why: `based on \`${pr.baseRefName}\`, not the default branch \`${def}\`: retarget it and ask for its merge again` };
  if (pr.headRefOid !== head) return { do: "fail", why: `its head moved since the merge was approved (now \`${String(pr.headRefOid).slice(0, 12)}\`): for an agent's PR the queue files its merge again at the new head once its checks are green, so there is nothing to do; any other PR needs a new merge request` };
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r: Json) => r.state);
  if (pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED")) return { do: "fail", why: "changes are requested on it" };
  if (pr.isDraft) return { do: "fail", why: "it is a draft" };
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (rollup?.contexts?.pageInfo?.hasNextPage) return { do: "fail", why: "more than 100 checks on its head, so not all of them can be read" };
  const named = namedChecks(rollup);
  if (!named.length) return { do: "wait", why: "no checks on its head yet" };
  // Check names are set by whoever can push to the repo: counted, never quoted.
  const red = named.filter((c) => !c.ok && !c.pending);
  if (red.length) return { do: "fail", why: `${red.length} check(s) failed on its head (\`gh pr checks ${pr.number}\` names them)` };
  if (named.some((c) => c.pending)) return { do: "wait", why: `${named.filter((c) => c.pending).length} check(s) still running on its head` };
  if (skippedImageScan(pr)) return { do: "fail", why: "it changes an image but its image-scan check was skipped" };
  switch (pr.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE": { // only an advisory context isn't green: every named one is, above
      // A PR that holds the tip merges on its own green checks: they prove the tree after the merge (the fix for a red base
      // lands, and the tip's own CI is no wait). One behind a red or still-running tip waits for it. The tip is in the reason,
      // so each new tip gets its own wait.
      const base = baseCi(pr.baseRef?.target?.statusCheckRollup), tip = String(pr.baseRef?.target?.oid ?? "").slice(0, 12);
      const behind = pr.baseRef?.compare?.behindBy !== 0;
      if (behind && base === "pending") return { do: "wait", why: `CI is running on \`${def}\` at \`${tip}\`` };
      if (behind && base === "red") return { do: "wait", why: `\`${def}\` is red at \`${tip}\`: merged once it is green again` };
      return { do: "merge" };
    }
    case "DIRTY":
      return { do: "fail", why: `it conflicts with \`${def}\`: rebase it and ask for its merge again` };
    case "BEHIND":
      return { do: "fail", why: `it is behind \`${def}\`: rebase it and ask for its merge again` };
    case "BLOCKED":
      return { do: "fail", why: "GitHub won't merge it (blocked by a branch rule)" };
    default:
      return { do: "wait", why: "GitHub is still working out whether it can merge" };
  }
}

// ---- the ship module's readiness (docs/superpowers/specs/2026-11-24-ship-design.md §3, §6) ----

/** What ship does next with an adopted PR: one decision per pass, recomputed by every writer right before it writes. */
export type Action = "wait" | "repair" | "fix_ci" | "fix_review" | "approve" | "enqueue" | "merge" | "done" | "stall" | "fail";
/** Why the PR last left its branch's merge queue at this head: a failed group, a conflict, a timeout, a person, or not known. */
export type Removal = "group_failed" | "conflict" | "timeout" | "dequeued" | "unknown";
/**
 * Ship's view of the PR that only ship knows:
 * - `queue`: the merge path (mergePath);
 * - `approve`: whether ship may post the reviewer App's approval now (its setting, and code review's pass that holds for this
 *   head: a completed review of it, or one carried from an earlier head whose own patch is unchanged — ship's call);
 * - `review`: an approval on the head is needed before merging though GitHub doesn't ask for one (code review gates the repo);
 * - `findings`: code review's open important findings on the head;
 * - `since`: when the adoption's generation began (an older queue removal is history);
 * - `base`: the branch it is bound to (any branch, not only the default);
 * - `required`: the check names the target branch's rules require (requiredChecks); only those are judged, and none required
 *   with none on the head is green. Undefined: not read, so every named check is judged and a head with none waits;
 * - `checks`: every check on the head (read whole, every page), in place of the query's first page.
 */
export type ShipContext = { queue: boolean; approve: boolean; review?: boolean; findings?: boolean; since?: string; base?: string; required?: string[]; checks?: NamedCheck[] };

/**
 * The merge path from the branch's rules (GET /repos/{r}/rules/branches/{b}: every ruleset that applies to it): the merge queue
 * when one requires it, else the direct merge.
 */
export function mergePath(rules: unknown): "queue" | "direct" {
  return Array.isArray(rules) && rules.some((r: Json) => r?.type === "merge_queue") ? "queue" : "direct";
}

/**
 * How many checks the target branch requires: the rulesets' (the rules read above) plus classic branch protection's
 * (GET /repos/{r}/branches/{b}/protection/required_status_checks; a 404 is none), by name. An empty list is a confirmed answer.
 */
export function requiredChecks(rules: unknown, classic?: Json): string[] {
  const named = new Set<string>();
  for (const r of Array.isArray(rules) ? rules : []) if (r?.type === "required_status_checks") for (const c of r.parameters?.required_status_checks ?? []) named.add(String(c.context));
  for (const c of classic?.contexts ?? []) named.add(String(c));
  for (const c of classic?.checks ?? []) named.add(String(c.context));
  return [...named];
}

/**
 * Why the PR last left its merge queue, when that is the latest queue event, it happened at this head and after `since`. GitHub
 * names the reason in free text, so it is read by its words; a reason with none of them is `unknown`, which ship shows as a wait
 * rather than guessing a repair or a re-enqueue.
 */
export function queueRemoval(pr: Json, head: string, since?: string): { removal: Removal; reason: string } | undefined {
  const last = (pr?.timelineItems?.nodes ?? []).at(-1);
  if (last?.__typename !== "RemovedFromMergeQueueEvent") return undefined;
  if (last.beforeCommit?.oid && last.beforeCommit.oid !== head) return undefined;
  if (since && String(last.createdAt ?? "") < since) return undefined;
  const reason = String(last.reason ?? "");
  const removal: Removal = /conflict/i.test(reason) ? "conflict"
    : /time[ds]?[ _-]?out/i.test(reason) ? "timeout"
    : /fail|check/i.test(reason) ? "group_failed"
    : /manual|dequeued|removed by/i.test(reason) || (!reason && last.actor?.__typename === "User") ? "dequeued"
    : "unknown";
  return { removal, reason: reason.slice(0, 200) };
}

/** Whether a person's or the reviewer App's approval stands on exactly this head (a dismissed one, or one of an older head, doesn't). */
export const approvedAt = (pr: Json, head: string) => (pr?.reviews?.nodes ?? []).some((r: Json) => r?.state === "APPROVED" && r.commit?.oid === head);

/** The review GitHub still asks for: the code owner team or person it requested as owner, else a plain required review. */
function reviewWait(pr: Json) {
  const owner = (pr?.reviewRequests?.nodes ?? []).find((r: Json) => r?.asCodeOwner)?.requestedReviewer;
  const who = owner?.combinedSlug ?? owner?.login;
  return who ? `waiting on code owner @${who}` : "waiting for required review";
}

/**
 * Ship's decision for an adopted PR (`decideShip`): `data` is PR_QUERY's answer (withGate applied) and `head` the head ship
 * read. It never fails a PR that a round can move (a conflict is a repair, red is a fix, a missing review is a wait): `fail`
 * is only a closed PR, a moved head or target, or a merge by someone else. Before an enqueue or a merge it needs a person's or
 * the App's approval on this head even where GitHub requires none.
 */
export function decideShip(data: Json, head: string, ctx: ShipContext): { do: Action; why: string; removal?: Removal } {
  const pr = data?.repository?.pullRequest;
  if (!pr) return { do: "fail", why: "not found on GitHub" };
  const target = ctx.base ?? data.repository.defaultBranchRef?.name;
  if (pr.state === "MERGED") return pr.headRefOid === head && pr.baseRefName === target ? { do: "done", why: `merged into \`${target}\`` } : { do: "fail", why: `merged at \`${String(pr.headRefOid).slice(0, 12)}\` into \`${pr.baseRefName}\`, not the bound head and target` };
  if (pr.state !== "OPEN") return { do: "fail", why: "closed" };
  if (pr.baseRefName !== target) return { do: "fail", why: `it targets \`${pr.baseRefName}\`, not \`${target}\`` };
  if (pr.headRefOid !== head) return { do: "fail", why: `its head moved to \`${String(pr.headRefOid).slice(0, 12)}\`` };
  if (pr.isDraft) return { do: "wait", why: "it is a draft" };
  if (pr.isInMergeQueue) return pr.mergeQueueEntry?.headCommit?.oid === head ? { do: "wait", why: "in the merge queue" } : { do: "fail", why: "queued at another head" };
  const removed = queueRemoval(pr, head, ctx.since);
  if (removed) {
    const why = `removed from the merge queue${removed.reason ? ` (${removed.reason})` : ""}`;
    if (removed.removal === "conflict") return { do: "repair", why, removal: removed.removal };
    if (removed.removal === "group_failed") return { do: "fix_ci", why, removal: removed.removal };
    if (removed.removal === "timeout") return { do: "enqueue", why, removal: removed.removal };
    if (removed.removal === "dequeued") return { do: "stall", why: `${why}: a person took it out`, removal: removed.removal };
    return { do: "wait", why: `${why}: the reason isn't one ship acts on`, removal: removed.removal };
  }
  if (pr.mergeStateStatus === "DIRTY" || pr.mergeStateStatus === "BEHIND") return { do: "repair", why: pr.mergeStateStatus === "DIRTY" ? `it conflicts with \`${target}\`` : `it is behind \`${target}\`` };
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!ctx.checks && rollup?.contexts?.pageInfo?.hasNextPage) return { do: "wait", why: "more than 100 checks on its head: read them whole first" };
  const all: NamedCheck[] = ctx.checks ?? namedChecks(rollup);
  // Only the checks the rules require are judged when they are known: an optional red check doesn't hold the PR, and a
  // required one that hasn't reported yet is still running.
  const req = ctx.required;
  const judged = req ? req.map((name) => all.find((c) => c.name === name) ?? { name, pending: true }) : all;
  const red = judged.filter((c) => !(c.ok ?? c.success) && !c.pending);
  if (red.length) return { do: "fix_ci", why: `${red.length} ${req ? "required " : ""}check(s) failed on its head` };
  if (judged.some((c) => c.pending)) return { do: "wait", why: `${judged.filter((c) => c.pending).length} ${req ? "required " : ""}check(s) still running on its head` };
  if (!judged.length && !req) return { do: "wait", why: "no checks on its head yet" };
  if (skippedImageScan(pr)) return { do: "fix_ci", why: "it changes an image but its image-scan check was skipped" };
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r: Json) => r.state);
  if (ctx.findings || pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED")) return { do: "fix_review", why: ctx.findings ? "code review has open findings on its head" : "changes are requested on it" };
  // An approval is needed only where GitHub asks for a review or code review gates the repo; elsewhere the trusted hand-off is enough.
  if ((pr.reviewDecision === "REVIEW_REQUIRED" || ctx.review) && !approvedAt(pr, head)) return ctx.approve ? { do: "approve", why: "ready, and no approval on its head yet" } : { do: "wait", why: reviewWait(pr) };
  switch (pr.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE": {
      const base = baseCi(pr.baseRef?.target?.statusCheckRollup), tip = String(pr.baseRef?.target?.oid ?? "").slice(0, 12);
      const behind = pr.baseRef?.compare?.behindBy !== 0;
      if (behind && base === "pending") return { do: "wait", why: `CI is running on \`${target}\` at \`${tip}\`` };
      if (behind && base === "red") return { do: "wait", why: `\`${target}\` is red at \`${tip}\`` };
      return ctx.queue ? { do: "enqueue", why: "ready: its branch merges through the merge queue" } : { do: "merge", why: "ready" };
    }
    case "BLOCKED":
      // The App's approval is on the head and GitHub still blocks it: a code owner (or another required review) is the wait.
      return { do: "wait", why: pr.reviewDecision === "REVIEW_REQUIRED" ? reviewWait(pr) : "GitHub won't merge it yet (a branch rule)" };
    default:
      return { do: "wait", why: "GitHub is still working out whether it can merge" };
  }
}

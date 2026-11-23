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

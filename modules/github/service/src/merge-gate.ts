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

import { CODE_REVIEW_STATUS, GATE_CHECK, POLICY_CHECK, contextStatus, gateJudgedNothing, judgedOnHead, judgedSomething, latestChecks, namedChecks, newestGateSkipped, skippedImageScan } from "./aidenhq-sdk/checks.ts";
import type { ReviewGate } from "./review-gate.ts";

/** A check on a head, by name (service.ts checksAt, checks.ts namedChecks): `kind` and `rank` are what pick the newest of a name. */
export type NamedCheck = { name?: string; kind?: "run" | "status"; rank?: number; ok?: boolean; success?: boolean; pending?: boolean; skipped?: boolean; status?: string | null };
/** Code review's answer for a head (review-gate.ts). */
export type Verdict = Awaited<ReturnType<ReviewGate>>;

/**
 * The one product-merge eligibility rule (owner, 2026-11-23), used when planning (plan.ts) and again right before the merge
 * (merges.ts): the product repo, `ci-required` successful on this exact head, and code review's real pass for it (an ungated
 * repo or a wait is not one). Eligible, a product merge skips the AI reviewer.
 */
export function productMergeEligible(p: { repo: string; head: string; checks: NamedCheck[]; verdict: Verdict | undefined; productRepo: string }): boolean {
  const same = String(p.repo).toLowerCase() === String(p.productRepo ?? "").toLowerCase() && Boolean(p.productRepo);
  // Success itself: a neutral or skipped gate is no pass for a merge that skips the reviewer. The gate's newest run that judged
  // the head decides (judgedCheck): a superseded cancelled run (an edit re-ran CI) never blocks a head whose latest real
  // `ci-required` passed, and an older pass never hides a later red one. An edit's skip is no verdict either. A check run and a
  // status sharing the gate's name are two judgements; the worst counts. The `policy` run that edit made is part of the head's
  // verdict too, so a bad title it found fails here as well.
  const gate = headChecks(p.checks.filter((c) => c.name === GATE_CHECK));
  const judged = judgedCheck(p.checks, GATE_CHECK);
  const title = editedTitleCheck(p.checks);
  const ci = gate.length > 0 && judged?.success === true && !judged.pending && (!title || (title.success === true && !title.pending));
  // A pass with no mandatory review behind it (a tier that needs none) is no pass for a merge that skips the AI reviewer.
  return same && Boolean(p.head) && ci && Boolean(p.verdict && "pass" in p.verdict && p.verdict.pass === true && !p.verdict.unreviewed);
}

// GitHub GraphQL payloads (PR_QUERY's answer), read by field.
type Json = any;

/**
 * The one judgement per check name on a head, as GitHub's branch protection makes it: each name's newest run at that head, and
 * each name's newest status (a check run and a status that share a name are two judgements, so the worst of the two holds).
 * `rank` (checks.ts contextRank) decides the newest, never the rollup's node order: an edited PR starts a new run that cancels
 * the old one, and the cancelled run's check stays on the head forever.
 */
export function headChecks<T extends NamedCheck>(checks: T[]): T[] {
  return latestChecks(checks);
}

/** The label that holds a PR from every automatic merge (ship's default stop label; `aidenhq publish --hold` puts it on). */
export const HOLD_LABEL = "ship:stop";

export const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $pullRef: String!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      id number title body url state isDraft labels(first: 30) { nodes { name } } reviewDecision mergeStateStatus headRefOid headRefName baseRefOid isCrossRepository baseRefName authorAssociation
      mergedAt mergedBy { login } mergeCommit { oid message }
      files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path changeType } }
      latestOpinionatedReviews(first: 30) { nodes { fullDatabaseId state authorCanPushToRepository author { __typename login } commit { oid } } }
      reviewRequests(first: 30) { nodes { asCodeOwner requestedReviewer { __typename ... on Team { combinedSlug } ... on User { login } } } }
      isInMergeQueue mergeQueueEntry { headCommit { oid } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { databaseId name status conclusion startedAt completedAt } ... on StatusContext { context state description createdAt } } } } } } }
      baseRef { compare(headRef: $pullRef) { behindBy } target { oid ... on Commit { statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { databaseId name status conclusion startedAt completedAt } ... on StatusContext { context state createdAt } } } } } } }
    }
  }
}`;

/**
 * One page of a pull request's files past the first: `files(first: 100, after: $after)`, the cursor the first read answered
 * (allPrFiles). Only a PR whose list GitHub cut asks for it, so an ordinary PR costs no second call.
 */
export const PR_FILES_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid baseRefOid
      files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path changeType } }
    }
  }
}`;

/**
 * Every file of a pull request, from the page the PR read carried plus each page after it while `hasNextPage` says there are
 * more. `page` reads one page by its cursor and throws when it can't, so a failed read throws rather than answering from a
 * partial list. A cut page with no cursor is no answer either (asking with none would read the first page again).
 */
export async function allPrFiles<T extends { pageInfo?: Json; nodes?: Json[] }>(first: T, page: (after: string) => Promise<T>): Promise<{ pageInfo: { hasNextPage: false }; nodes: Json[] }> {
  const nodes = [...(first?.nodes ?? [])];
  let info = first?.pageInfo ?? {};
  for (let n = 0; info.hasNextPage; n++) {
    if (n >= 100) throw new Error("GitHub GraphQL: the pull request's file list did not end");
    const after = info.endCursor;
    if (!after) throw new Error("GitHub GraphQL: the pull request's file list is cut with no cursor to page from");
    const next = await page(after);
    if (!next || typeof next !== "object" || !Array.isArray(next.nodes) || !next.pageInfo) throw new Error("GitHub GraphQL: a page of the pull request's files is missing");
    nodes.push(...next.nodes);
    info = next.pageInfo;
  }
  return { pageInfo: { hasNextPage: false }, nodes };
}

const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

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
  // A list GitHub truncated proves nothing about the tip: a red check past the page would read as green. No evidence never passes.
  if (rollup?.contexts?.pageInfo?.hasNextPage) return "pending";
  // Each name's newest run at the tip, as on a head: a run an edit or a re-run superseded is not the tip's verdict. Cancelled
  // stays a result that never judged the commit, as before.
  const named = latestChecks(namedChecks(rollup));
  // A cancelled run never judged the commit, so a cancelled check (the aggregate gate among them) is no verdict: it is neither
  // red nor pending. But nothing else is excused — a gate or a job that completed red at the tip is red beside any cancellation,
  // since an unrelated cancelled run must never mask a failure. A whole run whose jobs were cancelled is superseded by the next
  // run's own checks of the same names, which is what newest-run resolution reads here.
  if (named.some((c) => !c.ok && !c.pending && c.status !== "CANCELLED")) return "red";
  return named.some((c) => c.pending) ? "pending" : "green";
}

/** The merge method: squash, then merge commit, then rebase, as the repository allows. */
export function mergeMethod(repo: Json) {
  if (repo.squashMergeAllowed) return "squash";
  if (repo.mergeCommitAllowed) return "merge";
  if (repo.rebaseMergeAllowed) return "rebase";
  return undefined;
}

/** What to do next with a PR. The merge queue's records use `merge`, `done`, `wait` and `fail`; the rest are ship's. */
export type Action = "wait" | "repair" | "fix_ci" | "fix_review" | "approve" | "enqueue" | "merge" | "done" | "stall" | "fail";
/**
 * Ship's view of an adopted PR, which only ship knows:
 * - `queue`: its branch merges through the merge queue (mergePath);
 * - `approve`: ship may post the App's approval now (its `approve` setting and code review's pass for this head: ship's call,
 *   lane D2's verdict carry-over and fresh-review rule included);
 * - `verdict`: code review's answer for the head (review-gate.ts), read once by the caller: undefined where the repo isn't gated.
 *   A gated repo merges on its pass; open important findings are a fix, anything else a wait. GitHub's own review
 *   rule (REVIEW_REQUIRED) is what asks for an approval on the head;
 * - `required`: the check names the target branch's rules require (requiredChecks): only those are judged, and none required is green;
 * - `checks`: every check on the head, every page.
 */
export type ShipContext = { queue: boolean; approve: boolean; verdict?: Verdict; /** The review ids ship's approve write made as the App on this PR (approvals.ts): only those App approvals count. */ mine?: string[]; required: string[]; checks: NamedCheck[]; /** The open PR whose head branch this PR's base is (a stack): it waits on that PR. */ stackedOn?: number; /** Members' review comments nobody has answered (member-comments.ts): open like findings. */ comments?: boolean };

/**
 * The title the head's newest `policy` run judged, always: the title is not part of the commit, so the aggregate's verdict on
 * it goes stale the moment the title changes. An edit that runs only `policy` posts the newest title check, and it must hold
 * even when the full run posts a newer `ci-required` afterwards (that aggregate judged the title it read before the edit). A
 * `policy` that skipped or was cancelled judged nothing and is no title verdict (undefined).
 */
export function editedTitleCheck(checks: NamedCheck[]): NamedCheck | undefined {
  const titles = headChecks(checks.filter((c) => c.name === POLICY_CHECK && judgedSomething(c)));
  return titles.find((c) => !(c.ok ?? c.success) && !c.pending) ?? titles.find((c) => c.pending) ?? titles[0];
}

/**
 * A required name's judgement on the head: its newest run that actually judged it, never a gate that skipped or was cancelled
 * (gateJudgedNothing). A name whose every run is like that has no judgement: undefined, which the caller waits on rather than
 * reading a superseded run's pass or a cancellation's red as this head's result.
 */
export function judgedCheck<T extends NamedCheck>(checks: T[], name: string): T | undefined {
  const same = checks.filter((c) => c.name === name);
  // The newest run of each kind that actually judged the head: a gate that skipped or was cancelled on it is dropped before the
  // newest is taken, so the next-newest real run of its kind stands in. A check run and a status sharing a name stay separate
  // judgements (headChecks), and the worst of them still counts.
  const judged = headChecks(same.filter((c) => !gateJudgedNothing(c)));
  if (judged.length) return judged.find((c) => !(c.ok ?? c.success) && !c.pending) ?? judged.find((c) => c.pending) ?? judged[0];
  // Nothing judged it but the gate: still running when any run of the name is pending, else the replacement run has to come.
  return headChecks(same).find((c) => c.pending);
}

/**
 * The one readiness rule: what to do with one PR from `data` (PR_QUERY's answer, withGate applied) and its bound `head`.
 * Without `ship` it is the merge queue's for an approved record: { do: "merge" | "done" | "wait" | "fail", why }, and before a
 * "merge" merges.ts still asks code review's gate; only our own repos (agents org, product) and listed ones reach it, so
 * the record is the review. With `ship` (an adopted PR) it never fails what a round can move: a conflict is a repair, red is a
 * fix, a missing review is a wait; it judges only the required checks, needs code review's pass where code review gates the
 * repo, and an approval on the head only where GitHub asks for one. A PR on a non-default base waits for ship, said each pass and
 * never stored: on the PR whose branch it stands on (a stack, which ship retargets once that PR merges), else as unsupported.
 */
export function decide(data: Json, head: string, ship?: ShipContext, noChecksOk = false): { do: Action; why?: string } {
  const pr = data?.repository?.pullRequest;
  if (!pr) return { do: "fail", why: "not found on GitHub" };
  if (pr.state === "MERGED") return pr.headRefOid === head ? { do: "done", why: "already merged" } : { do: "fail", why: `merged by someone else at \`${String(pr.headRefOid).slice(0, 12)}\`, not the approved head` };
  if (pr.state !== "OPEN") return { do: "fail", why: "closed" };
  const def = data.repository.defaultBranchRef?.name;
  if (!def || pr.baseRefName !== def) return ship ? { do: "wait", why: ship.stackedOn ? `waiting on #${ship.stackedOn}` : `non-default base unsupported (\`${pr.baseRefName}\`)` } : { do: "fail", why: `based on \`${pr.baseRefName}\`, not the default branch \`${def}\`: retarget it and ask for its merge again` };
  if (pr.headRefOid !== head) return { do: "fail", why: `its head moved since the merge was approved (now \`${String(pr.headRefOid).slice(0, 12)}\`): for an agent's PR the queue files its merge again at the new head once its checks are green, so there is nothing to do; any other PR needs a new merge request` };
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r: Json) => r.state);
  if (pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED")) return { do: ship ? "fix_review" : "fail", why: "changes are requested on it" };
  if (pr.isDraft) return { do: ship ? "wait" : "fail", why: "it is a draft" };
  if (pr.labels?.nodes?.some((l: Json) => l.name === HOLD_LABEL)) return { do: "wait", why: `it carries the \`${HOLD_LABEL}\` label: merged once the label is removed` };
  if (ship && pr.isInMergeQueue) return { do: "wait", why: "in the merge queue" };
  // A conflict or a branch behind comes first for ship: checks on a conflicted PR may never run until it is repaired.
  if (ship && (pr.mergeStateStatus === "DIRTY" || pr.mergeStateStatus === "BEHIND")) return { do: "repair", why: pr.mergeStateStatus === "DIRTY" ? `it conflicts with \`${def}\`` : `it is behind \`${def}\`` };
  if (ship) {
    // Only the checks the rules require: an optional red check doesn't hold the PR, and a required one not reported yet is running.
    // Each name is judged by its newest run on the head (headChecks): a name whose only runs were cancelled stays red rather than
    // looking like it is still running. A check run and a status that share a name are separate judgements, so the worst counts.
    // An edit's run plans no suite: its `ci-required` and every job's check are skips newer than the run that tested the head.
    // judgedOnHead drops those and keeps the reports that judged the head, the `policy` run the edit did make among them, so an
    // invalid title edited after a green head is still a required red (policy) here, and a real failure still fails.
    const onHead = judgedOnHead(ship.checks);
    const judged = ship.required.map((name) => ({ name, check: judgedCheck(onHead, name) }));
    const title = editedTitleCheck(ship.checks);
    if (title && !(title.ok ?? title.success) && !title.pending) return { do: "fix_ci", why: "the title edited after the head's last CI run does not pass the Conventional Commit check" };
    const red = judged.filter(({ check: c }) => c && !(c.ok ?? c.success) && !c.pending);
    if (red.length) return { do: "fix_ci", why: `${red.length} required check(s) failed on its head` };
    // A required gate whose only report on this head was skipped or cancelled judged nothing (judgedCheck's undefined): the
    // run that replaces it decides, never this head's earlier result and never a cancellation.
    const superseded = judged.filter((c) => !c.check);
    if (superseded.length) return { do: "wait", why: `the aggregate that judged its head was superseded; waiting for the run that replaces it (${superseded.map((c) => `\`${String(c.name).replace(/`/g, "")}\``).join(", ")})` };
    // An edit's `policy` run is the newest title check: still running is a wait, as any required check in flight is.
    if (title?.pending) return { do: "wait", why: "the title check the edit re-ran is still running" };
    // A required name nothing reported on this head (renamed, path-filtered) is named: GitHub won't merge until it reports.
    const missing = ship.required.filter((name) => !ship.checks.some((c) => c.name === name));
    if (missing.length && !ship.checks.some((c) => c.pending)) return { do: "wait", why: `required check(s) never reported on its head: ${missing.map((m) => `\`${m.replace(/`/g, "")}\``).join(", ")} (a person reruns or fixes the workflow)` };
    if (judged.some((c) => c.check?.pending)) return { do: "wait", why: "required checks are still running on its head" };
  } else {
    const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    if (rollup?.contexts?.pageInfo?.hasNextPage) return { do: "fail", why: "more than 100 checks on its head, so not all of them can be read" };
    // Each name is judged by its newest run at the head (headChecks), as GitHub's branch protection does: a superseded run's check
    // stays on the head forever, so counting every context would hold the PR. A name whose only runs were cancelled passes nothing
    // and does not wait either: it is red.
    const all = namedChecks(rollup);
    // An edit's run planned no suite, so its aggregate is a skip and so is every job's check beside it. judgedOnHead drops those
    // and keeps the reports that judged the head (the `policy` run the edit made included) before the newest is taken, so a skip
    // never reads as a pass and a real failure an edit superseded never reads as green.
    const named = headChecks(judgedOnHead(all));
    // A repo with no checks never reports one: the caller says nothing is coming (noChecksOk), and the rest of the gate still runs.
    if (!named.length && !noChecksOk) return { do: "wait", why: "no checks on its head yet" };
    // Check names are set by whoever can push to the repo: counted, never quoted.
    const red = named.filter((c) => !c.ok && !c.pending);
    if (red.length) return { do: "fail", why: `${red.length} check(s) failed on its head (\`gh pr checks ${pr.number}\` names them)` };
    if (named.some((c) => c.pending)) return { do: "wait", why: "checks are still running on its head" };
    // The newest aggregate judged nothing and no run replaced it: nothing here is a pass.
    if (newestGateSkipped(all) && !judgedCheck(all, GATE_CHECK)) return { do: "wait", why: "the aggregate that judged its head was superseded; waiting for the run that replaces it (`ci-required`)" };
  }
  if (skippedImageScan(pr)) return { do: ship ? "fix_ci" : "fail", why: "it changes an image but its image-scan check was skipped" };
  // Code review gates the repo: its pass is the review (code review unreachable is a wait); open important findings are the PR's to fix.
  const v = ship?.verdict;
  if (v && "findings" in v && v.findings) return { do: "fix_review", why: "code review has open findings on its head" };
  // Members' open review comments (owner, 2026-11-26) stand where findings do: the PR is fixed before it is approved or merged.
  if (ship?.comments) return { do: "fix_review", why: "members have open review comments on it" };
  if (v && "wait" in v) return { do: "wait", why: v.wait };
  // An approval on the head is needed only where GitHub's own rules ask for a review (reviewDecision is set); elsewhere the hand-off
  // (and code review) is enough. Where they do, it must be on this exact head: GitHub keeps an earlier commit's approval as APPROVED
  // when the repo doesn't dismiss stale ones, and that approval never saw this head.
  if (ship && (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "APPROVED") && !approvedAt(pr, head, ship.mine)) {
    return ship.approve ? { do: "approve", why: "ready, and no approval on its head yet" } : { do: "wait", why: pr.reviewDecision === "APPROVED" ? "its approval is on an earlier commit: someone with write access approves this head" : reviewWait(pr) };
  }
  switch (pr.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE": { // only an advisory context isn't green: every named one is, above
      // A PR that holds the tip merges on its own green checks: they prove the tree after the merge (the fix for a red base
      // lands, and the tip's own CI is no wait). One behind a red or still-running tip waits for it. The tip is in the reason,
      // so each new tip gets its own wait.
      const base = baseCi(pr.baseRef?.target?.statusCheckRollup), tip = String(pr.baseRef?.target?.oid ?? "").slice(0, 12);
      // Waived head checks proved no tree, so a PR on the tip waits for a red or running base like one behind it.
      const behind = noChecksOk || pr.baseRef?.compare?.behindBy !== 0;
      if (behind && base === "pending") return { do: "wait", why: `CI is running on \`${def}\` at \`${tip}\`` };
      if (behind && base === "red") return { do: "wait", why: `\`${def}\` is red at \`${tip}\`: merged once it is green again` };
      return ship ? { do: ship.queue ? "enqueue" : "merge", why: "ready" } : { do: "merge" };
    }
    case "DIRTY":
      return { do: "fail", why: `it conflicts with \`${def}\`: rebase it and ask for its merge again` };
    case "BEHIND":
      return { do: "fail", why: `it is behind \`${def}\`: rebase it and ask for its merge again` };
    case "BLOCKED": {
      if (!ship) return { do: "fail", why: "GitHub won't merge it (blocked by a branch rule)" };
      // With the head's approval in, a code owner (or another required review) is what GitHub still waits for.
      if (pr.reviewDecision === "REVIEW_REQUIRED") return { do: "wait", why: reviewWait(pr) };
      // On a merge-queue branch a direct merge is always blocked (the queue is the path), and everything above has passed: the
      // enqueue is the judge, and GitHub's refusal (a thread to resolve, a signature) is a hold with its reason (queue.ts). The
      // queue tests the merged tree itself, so the base's CI is no wait here.
      if (ship.queue) return { do: "enqueue", why: "ready" };
      // GitHub also reports BLOCKED while a check is still running on the head, even when every required check is green (a
      // duplicate workflow run's jobs in flight): the required guard above judges only `ship.required`, so the whole head is
      // judged here by its newest run per name, and any check still pending is a wait. Code review's advisory *status* (commit
      // status API, never a check run) is not what GitHub holds a merge for; a check run that merely shares its name is the repo's
      // own job and still holds the wait.
      const advisory = (c: NamedCheck) => c.kind === "status" && c.name === CODE_REVIEW_STATUS;
      const held = headChecks(ship.checks).filter((c) => !advisory(c));
      if (held.some((c) => c.pending)) return { do: "wait", why: "checks are still running on its head" };
      // Any other rule (conversations to resolve, signed commits, a deployment) is one ship doesn't handle: a visible stall.
      return { do: "stall", why: "blocked by a branch rule ship doesn't handle" };
    }
    default:
      return { do: "wait", why: "GitHub is still working out whether it can merge" };
  }
}

/**
 * The merge path from the branch's rules (GET /repos/{r}/rules/branches/{b}: every ruleset that applies to it): the merge queue
 * when one requires it, else the direct merge.
 */
export function mergePath(rules: unknown): "queue" | "direct" {
  return Array.isArray(rules) && rules.some((r: Json) => r?.type === "merge_queue") ? "queue" : "direct";
}

/**
 * The checks the target branch requires: the rulesets' (the rules read above) plus classic branch protection's
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
 * Whether a person's or the App's approval stands on exactly this head: each reviewer's latest opinion (a later approval, request
 * for changes or dismissal replaces an earlier one), on this commit, from someone who can push to the repo (only theirs count for
 * GitHub's required review) or one ship's approve write made as the App (`mine`: its recorded review ids, approvals.ts), never
 * another bot's or a review a box's App token posted.
 */
export const approvedAt = (pr: Json, head: string, mine: string[] = []) => (pr?.latestOpinionatedReviews?.nodes ?? []).some((r: Json) => r?.state === "APPROVED" && r.commit?.oid === head
  && (r.author?.__typename === "Bot" ? r.fullDatabaseId != null && mine.includes(String(r.fullDatabaseId)) : r.authorCanPushToRepository === true));

/** The review GitHub still asks for: the code owner team or person it requested as owner, else a plain required review. */
function reviewWait(pr: Json) {
  const owner = (pr?.reviewRequests?.nodes ?? []).find((r: Json) => r?.asCodeOwner)?.requestedReviewer;
  const who = owner?.combinedSlug ?? owner?.login;
  return who ? `waiting on code owner @${who}` : "waiting for required review";
}

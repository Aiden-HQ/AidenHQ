// The code host's merge gate: whether an approved merge record's PR merges now, from GitHub's view of it. One decision per PR
// (`decide`); merges.ts polls, merges and reports. A PR merges only when it is open on the default branch, at the head the
// record bound, approved (the record is the review in our own repos; elsewhere GitHub's review must approve too), every named
// check is green on that head, GitHub can merge it and, where required, the reviewer-eval receipt verifies (merges.ts asks
// evalgate.ts last). Anything else waits a bounded time or fails with the reason: nothing here updates, rebases, retargets,
// re-runs or forces. A moved head, a moved base (behind, conflicts) or a red check goes back to the PR's own path, which asks
// for a new merge at its new head. Missing evidence (no checks, a truncated page of checks, the base's aggregate gate
// check not yet on the head) never counts as passing.

export const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $pullRef: String!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      id number title body url state isDraft reviewDecision mergeStateStatus headRefOid headRefName isCrossRepository baseRefName
      mergedAt mergedBy { login } mergeCommit { oid }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      latestOpinionatedReviews(first: 30) { nodes { state } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state description } } } } } } }
      baseRef { compare(headRef: $pullRef) { behindBy } target { oid ... on Commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
    }
  }
}`;

/** How long a PR may wait on one thing (checks running, GitHub working out mergeability) before it is reported not merged. */
export const WAIT_MINUTES = 90;
/** How long a product merge waits on its reviewer-eval receipt (evalgate.ts). */
export const EVAL_WAIT_MINUTES = 180;

const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** The UI Reviewer's design review: advisory in the named checks, required on a UI PR in the agents org (owner, 2026-11-13). */
export const DESIGN_REVIEW = { name: "design-review", minutes: 120 };
const advisory = (n) => (n.name ?? n.context) === DESIGN_REVIEW.name;

/**
 * Files that change what people see: styles, markup and component files, the usual UI folders, the vendored design system,
 * and server-rendered page code by its name (render, styles, layout, view, page, template). Conservative: a false match
 * costs a design review, a miss ships an unreviewed page.
 */
const UI_EXT = /\.(css|scss|sass|less|html?|tsx|jsx|vue|svelte|astro|hbs|handlebars|ejs|njk|pug|erb|liquid|mustache)$/i;
const UI_DIR = /(^|\/)(web|public|templates|views|static|pages|components|layouts|design-system)\//i;
const UI_PAGE_CODE = /(^|\/)([^/]*[-_.])?(render|styles?|layouts?|views?|pages?|templates?)\.(m?[jt]s|cjs)$/i;
const isUiFile = (f) => UI_EXT.test(f) || UI_DIR.test(f) || UI_PAGE_CODE.test(f);

/** Whether the PR changes UI files. A file list cut off at the first page counts as UI; no list at all doesn't. */
export function prTouchesUi(pr) {
  const files = pr?.files?.nodes;
  if (!Array.isArray(files)) return false;
  if (pr.files.pageInfo?.hasNextPage) return true;
  return files.some((f) => isUiFile(f.path ?? ""));
}

/** The design-review check on a rollup: "success", "failure", "pending" or "missing". */
function designReview(rollup) {
  const n = (rollup?.contexts?.nodes ?? []).find(advisory);
  if (!n) return "missing";
  const v = n.__typename === "CheckRun" ? (n.status === "COMPLETED" ? n.conclusion : "PENDING") : n.state;
  return v === "SUCCESS" ? "success" : FAILING.has(v) ? "failure" : "pending";
}

/**
 * Why an open design-review task no longer needs its reviewer, from its marker ({ head }) and the PR as GitHub returns it: its
 * head moved on, the PR merged or closed, or a verdict is on that exact head already. Undefined while it is still the one live
 * review (or the PR can't be read: unknown is never a reason to close).
 */
export function supersededDesignReview(marker, pr) {
  if (!marker || !pr) return undefined;
  if (pr.state === "MERGED") return "its PR merged";
  if (pr.state === "CLOSED") return "its PR was closed";
  if (pr.headRefOid && pr.headRefOid !== marker.head) return `its PR has moved on to head \`${String(pr.headRefOid).slice(0, 12)}\``;
  const dr = designReview(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup);
  return dr === "success" || dr === "failure" ? "its verdict is on that head already" : undefined;
}

/** Whether a PR's head waits on the UI Reviewer: it changes UI files, isn't a draft, and has no design-review verdict yet. */
export const awaitsDesignReview = (pr) => Boolean(pr) && !pr.isDraft && prTouchesUi(pr) && ["missing", "pending"].includes(designReview(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup));

/** The named checks in a rollup, the design review left out: { name, ok, pending }. */
export function namedChecks(rollup) {
  const pass = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return (rollup?.contexts?.nodes ?? [])
    .filter((n) => !advisory(n) && (n.name ?? n.context))
    .map((n) => {
      const status = n.__typename === "CheckRun" ? (n.status === "COMPLETED" ? n.conclusion : "PENDING") : n.state;
      return { name: n.name ?? n.context, ok: pass.has(status), pending: ["PENDING", "EXPECTED", "QUEUED", null, undefined].includes(status) };
    });
}

/**
 * The aggregate gate check a repository's CI may end with (the product's ci.yml `ci-required`): it appears only once the jobs it
 * covers finish, so a head can look all green before it. When the base branch's rollup has it, a head without it is pending.
 */
export const GATE_CHECK = "ci-required";
const hasGate = (rollup) => (rollup?.contexts?.nodes ?? []).some((n) => (n.name ?? n.context) === GATE_CHECK);
export function withGate(data) {
  const pr = data?.repository?.pullRequest;
  if (pr?.state && pr.state !== "OPEN") return data;
  const head = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!head || !hasGate(pr?.baseRef?.target?.statusCheckRollup) || hasGate(head)) return data;
  head.contexts = { ...(head.contexts ?? {}), nodes: [...(head.contexts?.nodes ?? []), { __typename: "CheckRun", name: GATE_CHECK, status: "QUEUED", conclusion: null }] };
  return data;
}

const IMAGE_FILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;
/** `image-scan` skipped on a PR that changes an image definition (or whose files can't all be read): nothing was scanned. */
function skippedImageScan(pr) {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  if (!nodes.some((n) => n.name === "image-scan" && n.status === "COMPLETED" && n.conclusion === "SKIPPED")) return false;
  return !pr.files || pr.files.pageInfo?.hasNextPage || (pr.files.nodes ?? []).some((f) => IMAGE_FILE.test(f.path ?? ""));
}

/** The merge method: squash, then merge commit, then rebase, as the repository allows. */
export function mergeMethod(repo) {
  if (repo.squashMergeAllowed) return "squash";
  if (repo.mergeCommitAllowed) return "merge";
  if (repo.rebaseMergeAllowed) return "rebase";
  return undefined;
}

/** GitHub's review decision, or (where reviews aren't required) an approval and no change requests. */
function approved(pr) {
  if (pr.reviewDecision) return pr.reviewDecision === "APPROVED";
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => r.state);
  return states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
}

/**
 * What to do with one PR of an approved record, from `data` (PR_QUERY's answer, withGate applied) and the record's bound `head`:
 * { do: "merge" | "done" | "wait" | "fail", why, limit?, review? }. Before a "merge", merges.ts still asks the eval gate.
 * `ownRepo`: the record is the review (agents org and the product's repos); `uiReview`: a UI PR needs the design review's pass.
 */
export function decide(data, head, { ownRepo, uiReview }) {
  const pr = data?.repository?.pullRequest;
  if (!pr) return { do: "fail", why: "not found on GitHub" };
  if (pr.state === "MERGED") return pr.headRefOid === head ? { do: "done", why: "already merged" } : { do: "fail", why: `merged by someone else at \`${String(pr.headRefOid).slice(0, 12)}\`, not the approved head` };
  if (pr.state !== "OPEN") return { do: "fail", why: "closed" };
  const def = data.repository.defaultBranchRef?.name;
  if (!def || pr.baseRefName !== def) return { do: "fail", why: `based on \`${pr.baseRefName}\`, not the default branch \`${def}\`: retarget it and ask for its merge again` };
  if (pr.headRefOid !== head) return { do: "fail", why: `its head moved since the merge was approved (now \`${String(pr.headRefOid).slice(0, 12)}\`): ask for its merge again at the new head` };
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => r.state);
  if (pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED")) return { do: "fail", why: "changes are requested on it" };
  if (!ownRepo && !approved(pr)) return { do: "fail", why: "it isn't approved on GitHub" };
  if (pr.isDraft) return { do: "fail", why: "it is a draft" };
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (rollup?.contexts?.pageInfo?.hasNextPage) return { do: "fail", why: "more than 100 checks on its head, so not all of them can be read" };
  const named = namedChecks(rollup);
  if (!named.length) return { do: "wait", why: "no checks on its head yet", limit: 10 };
  // Check names are set by whoever can push to the repo: counted, never quoted.
  const red = named.filter((c) => !c.ok && !c.pending);
  if (red.length) return { do: "fail", why: `${red.length} check(s) failed on its head (\`gh pr checks ${pr.number}\` names them)` };
  if (named.some((c) => c.pending)) return { do: "wait", why: `${named.filter((c) => c.pending).length} check(s) still running on its head` };
  if (skippedImageScan(pr)) return { do: "fail", why: "it changes an image but its image-scan check was skipped" };
  if (uiReview && prTouchesUi(pr)) {
    const dr = designReview(rollup);
    if (dr === "failure") return { do: "fail", why: "the UI Reviewer's design review failed on its head" };
    if (dr !== "success") return { do: "wait", why: "waiting for the UI Reviewer's design review on its head", limit: DESIGN_REVIEW.minutes, review: true };
  }
  switch (pr.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE": // only an advisory context isn't green: every named one is, above
      return { do: "merge" };
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

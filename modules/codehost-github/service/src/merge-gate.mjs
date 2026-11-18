// The code host's merge gate (codehost-github): how an approved merge lands. One at a time, a set gap apart, with CI on the
// base branch watched after each merge; Tier 0 merges in the agents org (owner, 2026-11-12) are an independent queue
// instead: each PR merges on its own once green (advanceEach). Code decides everything: a PR is merged only when it is
// open, approved, its checks are green, GitHub says it can merge and the base branch is green. An approved draft is marked
// ready first: asking for it to be merged says it's ready. Anything else stops the queue with a comment; nothing is ever
// forced, reverted or merged as an admin. The only GitHub writes here are WRITES and READY_MUTATION below, and a stacked
// PR's head replayed by the runner (github.rebuild: a git push leased to the approved head). Which PRs are queued, in what
// order, is engineering's (modules/engineering/src/merge-queue.mjs).
//
// Merge trains (advanceTrains): two or more approved, green PRs waiting on the same repository's default branch are built
// together on a `merge-train/<n>` branch (that branch's tip plus each PR's bound head, in queue order), CI runs once on it,
// and when it is green each PR is squash-merged in order at its bound head. A red train is split in half and each half
// tried again; a PR that fails alone on top of the base is turned back to its task. A train of one is the path above.

/** How long a product merge waits on its reviewer-eval receipt (the runner's evalgate.ts) before giving up on that PR. */
export const EVAL_WAIT_MINUTES = 180;

export const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $pullRef: String!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      id number title body url state isDraft reviewDecision mergeStateStatus headRefOid headRefName isCrossRepository baseRefName
      mergedAt mergedBy { login } mergeCommit { oid }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      latestOpinionatedReviews(first: 30) { nodes { state } }
      history: commits(last: 30) { nodes { commit { oid tree { oid } parents(first: 1) { totalCount } } } }
      commits(last: 1) { nodes { commit { parents(first: 2) { nodes { oid } } signature { wasSignedByGitHub } statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { name status conclusion databaseId checkSuite { workflowRun { databaseId } } } ... on StatusContext { context state description } } } } } } }
      baseRef { compare(headRef: $pullRef) { behindBy } target { oid ... on Commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
    }
  }
}`;

export const COMMIT_QUERY = `query($owner: String!, $repo: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $repo) {
    object(oid: $oid) { ... on Commit { committedDate statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } }
  }
}`;

/** A branch: its tip, the same-repo PRs that have it as their head, and the open PRs that have it as their base. */
export const BASE_QUERY = `query($owner: String!, $repo: String!, $ref: String!, $base: String!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $ref) { target { oid } }
    heads: pullRequests(headRefName: $base, states: [OPEN, MERGED], first: 30) { pageInfo { hasNextPage } nodes { state headRefOid mergedAt isCrossRepository } }
    stacked: pullRequests(baseRefName: $base, states: OPEN, first: 1) { totalCount }
  }
}`;

/** Marks a draft ready for review: the one GraphQL write. */
export const READY_MUTATION = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;

/** The REST writes this module makes, and nothing else. */
export const WRITES = [
  { method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/merge$/ },
  { method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/update-branch$/ },
  // `aidenhq close`: the reason as a comment, then the PR closed.
  { method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/comments$/ },
  // Also retargets a stacked PR to the default branch (base) once its parent merged.
  { method: "PATCH", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/ },
  // A merged agents-org PR's head branch is deleted, so PRs stacked on it retarget and stale branches don't pile up.
  { method: "DELETE", path: /^repos\/[\w.-]+\/[\w.-]+\/git\/refs\/heads\/[\w./-]+$/ },
  // A workflow run whose red jobs all ended on an infrastructure failure: its failed jobs re-run once (infraRetry).
  { method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/rerun-failed-jobs$/ },
  // A workflow run over for 10 minutes with a check still pending (a ghost job): the whole run re-runs once (ghostRetry).
  { method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/rerun$/ },
  // The head is waiting for its design review: written where the runner files and wakes that review.
  { method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/statuses\/[0-9a-f]{7,40}$/ },
  // A merge train: its branch made at the base's tip, each PR's bound head merged into it, and the branch deleted after.
  { method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/git\/refs$/ },
  { method: "POST", path: /^repos\/[\w.-]+\/[\w.-]+\/merges$/ },
];

/**
 * A merge train's branches, the only ones the train makes, merges into and deletes: `merge-build/<n>`, where the PRs are
 * merged one by one (CI doesn't run there), and `merge-train/<n>`, made once at the finished commit, so CI runs once on it
 * with the whole train as its push.
 */
export const TRAIN_BRANCH = /^merge-(train|build)\/\d+$/;

/**
 * A write in WRITES; comments, PR edits, job re-runs and branch deletes in the agents org only (outside it the host's gh login
 * writes), plus comments, PR edits, job re-runs and merge trains on the product's repos (`productRepo`: the product repo, or
 * a list with the official modules repo; `aidenhq close` of its Dependabot PRs; the only branch it deletes there is a merge
 * train's).
 */
export function allowedWrite(method, path, agentsOrg, productRepo) {
  if (!WRITES.some((w) => w.method === method && w.path.test(path))) return false;
  if (method === "PUT" || (Boolean(agentsOrg) && path.split("/")[1].toLowerCase() === agentsOrg.toLowerCase())) return true;
  const repo = path.split("/").slice(1, 3).join("/").toLowerCase();
  if (![productRepo ?? []].flat().some((p) => p.toLowerCase() === repo)) return false;
  return method !== "DELETE" || TRAIN_BRANCH.test(path.split("/").slice(6).join("/"));
}

/**
 * A PR merges only into the repository's default branch. Returns "ok" when it targets it. A PR stacked on another's branch
 * is retargeted ("retarget") only when that branch's own PR is confirmed merged: a same-repo merged PR whose head is the
 * branch's current tip (or the branch is gone, deleted after that merge). Otherwise `{ wait }`: the parent is open, or
 * one that moved on after its PR merged. `{ fail }` when the base can never land on the default branch: no open PR of its
 * own and no merged one (its PR closed unmerged, or its branch gone), so waiting could only time the PR out.
 */
async function settleBase(github, repo, pr, defaultBranch) {
  if (!defaultBranch) throw new Error("GitHub didn't say the default branch");
  if (pr.baseRefName === defaultBranch) return "ok";
  const b = await github.baseStatus(repo, pr.baseRefName);
  const stack = (why) => ({ wait: `based on \`${pr.baseRefName}\`, not the default branch \`${defaultBranch}\`: ${why}` });
  if (b.overflow) return stack("too many PRs on that branch to check");
  if (b.open) return stack("the PR it's stacked on is still open");
  const merged = b.merged.filter((m) => !m.isCrossRepository);
  if (!merged.length) {
    const why = b.tip
      ? `based on \`${pr.baseRefName}\`, which has no open or merged PR of its own, so it can never land on \`${defaultBranch}\``
      : `based on \`${pr.baseRefName}\`, which no longer exists on this repository`;
    return { fail: `${why}: retarget it to \`${defaultBranch}\` and ask for a new merge` };
  }
  if (b.tip && !merged.some((m) => m.headRefOid === b.tip)) return stack("the branch moved on after its PR merged");
  return "retarget";
}

/** Delete a merged PR's head branch: same-repo, not the default branch, still at the merged head, and no open PR based on it. A failed delete never undoes the merge. */
async function deleteHead(github, repo, pr, defaultBranch) {
  if (pr.isCrossRepository || !pr.headRefName || pr.headRefName === defaultBranch) return;
  try {
    const b = await github.baseStatus(repo, pr.headRefName);
    if (b.tip === pr.headRefOid && !b.stacked) await github.deleteBranch(repo, pr.headRefName);
  } catch {}
}

/** Close each PR with the reason as a comment first; one line per PR, and one failing PR doesn't stop the rest. */
export async function closePrs(prs, reason, github) {
  const lines = [];
  for (const { repo, number, url } of prs) {
    try {
      await github.comment(repo, number, reason);
      await github.close(repo, number);
      lines.push(`Closed ${url}: ${reason}`);
    } catch (err) {
      lines.push(`Couldn't close ${url}: ${String(err.stderr || err.message || err).trim().slice(0, 300)}`);
    }
  }
  return lines;
}

/**
 * Advisory checks: left out of the named checks and the rollup's state. The UI Reviewer's design review (owner, 2026-11-12)
 * stays advisory everywhere except a Tier 0 merge of a PR that changes UI files (owner, 2026-11-13: roadmap-keeper#108 shipped
 * an unstyled page while its review was still pending). There eachDecision waits for it (DESIGN_REVIEW, below).
 */
const ADVISORY = new Set(["design-review"]);

/**
 * Files that change what people see: styles, markup and component files, the usual UI folders, the vendored design system,
 * and server-rendered page code by its name (render, styles, layout, view, page, template). Conservative: a false match
 * costs a design review, a miss ships an unreviewed page.
 */
const UI_EXT = /\.(css|scss|sass|less|html?|tsx|jsx|vue|svelte|astro|hbs|handlebars|ejs|njk|pug|erb|liquid|mustache)$/i;
const UI_DIR = /(^|\/)(web|public|templates|views|static|pages|components|layouts|design-system)\//i;
const UI_PAGE_CODE = /(^|\/)([^/]*[-_.])?(render|styles?|layouts?|views?|pages?|templates?)\.(m?[jt]s|cjs)$/i;
export const isUiFile = (f) => UI_EXT.test(f) || UI_DIR.test(f) || UI_PAGE_CODE.test(f);
/** A PR's changed files touch UI (an unknown file list never counts here: tiering sends that to the owner anyway). */
export const touchesUi = (files) => Array.isArray(files) && files.some(isUiFile);

/**
 * Whether the PR itself changes UI files, from the file list the merge query carries (so the queue decides, not only the
 * tiering caller). A list cut off at the first page counts as UI: a design review costs a wait, an unreviewed page ships
 * blind. No list at all (another query's shape) leaves the decision to the caller's `ui`.
 */
export function prTouchesUi(pr) {
  const files = pr?.files?.nodes;
  if (!Array.isArray(files)) return false;
  if (pr.files.pageInfo?.hasNextPage) return true;
  return files.some((f) => isUiFile(f.path ?? ""));
}

/** On a UI PR's Tier 0 merge: the design review's check, and how long after the other checks went green it may take. */
export const DESIGN_REVIEW = { name: "design-review", minutes: 120 };

/** The design-review check on a rollup: "success", "failure", "pending" or "missing", and its description when it has one. */
export function designReview(rollup) {
  const n = (rollup?.contexts?.nodes ?? []).find((x) => (x.name ?? x.context) === DESIGN_REVIEW.name);
  if (!n) return { state: "missing" };
  const v = n.__typename === "CheckRun" ? (n.status === "COMPLETED" ? n.conclusion : "PENDING") : n.state;
  const state = ["SUCCESS"].includes(v) ? "success" : FAILING.has(v) ? "failure" : "pending";
  return { state, ...(n.description ? { description: String(n.description).replace(/[\p{Cc}`]/gu, " ").slice(0, 160) } : {}) };
}
const advisory = (n) => ADVISORY.has(n.name ?? n.context);

/**
 * A "Design review: <repo>#<n>" task's source marker (`<!-- source:design-review:<repo>/<n>@<sha> -->`), as the runner
 * wrote it: { repo, number, head }, undefined for any other task. The head is the one the task asked about, which the PR
 * itself no longer knows once it has moved on.
 */
export function designReviewMarker(issue) {
  const m = /<!--\s*source:design-review:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\d+)@([0-9a-f]{7,40})\s*-->/.exec(String(issue?.description ?? ""));
  return m ? { repo: m[1], number: Number(m[2]), head: m[3] } : undefined;
}

/**
 * Why an open design-review task no longer needs its reviewer, from its marker and the PR as GitHub returns it: its head
 * moved on, the PR merged or closed, or a `design-review` verdict is on that exact head already. Undefined while the task
 * is the one live review for the PR's current head (or the PR can't be read: unknown is never a reason to close).
 */
export function supersededDesignReview(marker, pr) {
  if (!marker || !pr) return undefined;
  if (pr.state === "MERGED") return "its PR merged";
  if (pr.state === "CLOSED") return "its PR was closed";
  if (pr.headRefOid && pr.headRefOid !== marker.head) return `its PR has moved on to head \`${String(pr.headRefOid).slice(0, 12)}\``;
  const dr = designReview(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup);
  return dr.state === "success" || dr.state === "failure" ? "its verdict is on that head already" : undefined;
}

/** The rollup without its advisory checks, its state recomputed from the rest; the rollup itself when it has none. */
export function required(rollup) {
  const nodes = rollup?.contexts?.nodes ?? [];
  if (!nodes.some(advisory)) return rollup;
  const rest = { contexts: { nodes: nodes.filter((n) => !advisory(n)) } };
  const checks = namedChecks(rest);
  const state = checks.some((c) => !c.ok && !c.pending) ? "FAILURE" : checks.some((c) => c.pending) ? "PENDING" : "SUCCESS";
  return { ...rollup, ...rest, state };
}

const IMAGE_FILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;

/**
 * The `image-scan` check skipped on a PR that changes an image definition: nothing was scanned, so it isn't green (CI
 * decides what to scan; this keeps a PR from passing by dodging it). Files unread or past the first page count as changed.
 */
export function skippedImageScan(pr) {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  if (!nodes.some((n) => n.name === "image-scan" && n.status === "COMPLETED" && n.conclusion === "SKIPPED")) return false;
  return !pr.files || pr.files.pageInfo?.hasNextPage || (pr.files.nodes ?? []).some((f) => IMAGE_FILE.test(f.path ?? ""));
}

const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

const checkLabel = (n) => n.name ?? n.context;

/**
 * A red rollup split into { failed, cancelled } check nodes (advisory ones left out). A check that ended CANCELLED never
 * judged the commit — a newer push superseded its run — so it is unknown, not failed. The aggregate gate is the one check
 * whose FAILURE is derived rather than observed: its step only asks whether the jobs it lists passed, so one cancelled
 * dependency makes it fail while no check failed (ci.yml's `ci-required`). The real failure is the job behind it, so the
 * gate is named only when it is the only red check: a cancelled run then has no failed check and is not a red base.
 */
export function redChecks(rollup) {
  const nodes = (rollup?.contexts?.nodes ?? []).filter((n) => !advisory(n));
  const cancelled = nodes.filter((n) => (n.conclusion ?? n.state) === "CANCELLED");
  const red = nodes.filter((n) => FAILING.has(n.conclusion ?? n.state) && (n.conclusion ?? n.state) !== "CANCELLED");
  const failed = red.filter((n) => checkLabel(n) !== GATE_CHECK);
  // Only the gate is red: its own failure stands unless a cancelled run is what it saw, and then there is none to name.
  if (!failed.length && !cancelled.length) failed.push(...red.filter((n) => checkLabel(n) === GATE_CHECK));
  return { failed, cancelled };
}

/** A red rollup that no check failed on: it is red only because checks were cancelled, so it never judged the commit. */
export const cancelledRun = (rollup) => {
  const red = redChecks(rollup);
  return red.cancelled.length > 0 && red.failed.length === 0;
};

/** Conclusions that say a check never judged the commit: its job was cancelled, ran out of time or never started. */
// A job that hit its timeout is the code's (a hanging test) until shown otherwise: it gets fixed, never re-run (owner, 2026-11-17).
const INFRA = new Set(["CANCELLED", "STARTUP_FAILURE"]);
const INFRA_WHY = { CANCELLED: "cancelled before it finished (its runner went away)", STARTUP_FAILURE: "failed to start" };
/** The app CI's AI code review (modules/ci/template): its gate keeps one PR comment, starting with MARKER, per head. */
export const CODE_REVIEW = { name: "code-review", marker: "<!-- ci:code-review -->" };

/**
 * The code-review gate's comment says its review never finished on `head` (codegenie-gate.mjs: "Code review failed" when
 * codegenie errored or timed out, "Code review incomplete" with no coverage), and lists no blocking finding. Its check fails
 * the same way on a real reject, so this comment is the only way to tell them apart.
 */
export function codeReviewInfra(body, head) {
  const s = String(body ?? "");
  if (!s.startsWith(CODE_REVIEW.marker) || !/^[0-9a-f]{40}$/.test(head ?? "") || /blocking finding/.test(s)) return false;
  const at = ` on \`${head.slice(0, 7)}\``;
  return s.includes(`**Code review failed${at}`) || s.includes(`**Code review incomplete${at}`);
}

/**
 * The Actions job of a check run among its workflow run's jobs. For an Actions check, GitHub gives the check run and its job
 * the same id (checked 2026-11-15 on failed and re-run jobs; the breaker's `failedChecks` reads job logs by it), and the job
 * links back through `check_run_url`, so that link decides; the job's name is the fallback.
 */
export function jobFor(jobs, check) {
  const id = check?.databaseId;
  const list = jobs ?? [];
  return list.find((j) => id && String(j.check_run_url ?? "").endsWith(`/check-runs/${id}`)) ?? list.find((j) => j.name === (check?.name ?? check?.context));
}

/**
 * A check whose job never executed a step: GitHub refused to start it (billing, a spending limit) or no runner took it. Nothing
 * about the commit was judged, so its annotation is a report about the environment. `github.job(repo, check)` answers its job's
 * steps and failure annotations; a step run, an unreadable job or no annotation is not this. Returns { name, note, id, run }.
 */
async function neverStarted(github, repo, n) {
  if (n.__typename !== "CheckRun" || !n.databaseId || !["FAILURE", "ERROR"].includes(n.conclusion)) return undefined;
  let job;
  try {
    job = await github.job(repo, n);
  } catch {
    return undefined;
  }
  if (job?.steps?.length) return undefined;
  const notes = (job?.annotations ?? []).filter((a) => a.annotation_level === "failure").map((a) => String(a.message ?? "")).filter(Boolean);
  return notes.length ? { name: n.name ?? n.context ?? "a check", note: notes[0], id: n.databaseId, run: n.checkSuite?.workflowRun?.databaseId } : undefined;
}

/**
 * The red checks on the PR's head that never started: [{ name, note }] (the annotation is GitHub's text, never the runner's own
 * words), else [] — one real failure, a check past the page, or a job that ran a step. The aggregate gate check (`ci-required`)
 * is left out while another check is red: it only rolls those up, so its own redness adds nothing (in the billing case it runs
 * and fails on the job beneath it).
 */
export async function environmentFailure(github, repo, pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const red = (rollup?.contexts?.nodes ?? []).filter((n) => !advisory(n) && FAILING.has(n.conclusion ?? n.state));
  if (!red.length || rollup?.contexts?.pageInfo?.hasNextPage) return [];
  const own = red.filter((n) => (n.name ?? n.context) !== GATE_CHECK);
  const out = [];
  for (const n of own.length ? own : red) {
    const started = await neverStarted(github, repo, n);
    if (!started) return [];
    out.push(started);
  }
  return out;
}

/**
 * GitHub's own annotation when the machine running a job went away mid-run, anchored to its exact wording: a job's output
 * can print these words anywhere, so only the whole system message counts, and only with no step that failed (below).
 */
const RUNNER_LOST = /^(?:The (?:self-hosted|hosted) runner: .{1,200} lost communication with the server\.|The runner has received a shutdown signal\.)/;

/**
 * The red check runs on the PR's head, by id, that are the environment's and not the code's: cancelled or never
 * started (INFRA, neverStarted), code-review's own "didn't finish", or a job whose runner died (GitHub's annotation, and no
 * step of the job failed: a step that failed is the code's, whatever it printed). The breaker on identical failures leaves
 * them out (owner, 2026-11-15): two heads that met the same broken environment are not the same failure twice. By id, so a
 * real failure sharing a name is never dropped. The gate check (`ci-required`) is theirs too when every check it rolls up is.
 */
export async function environmentalChecks(github, repo, number, pr) {
  const red = (pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).filter((n) => !advisory(n) && FAILING.has(n.conclusion ?? n.state));
  const own = red.filter((n) => checkLabel(n) !== GATE_CHECK);
  const out = [];
  for (const n of own) {
    if (n.__typename !== "CheckRun" || !n.databaseId) continue;
    if (INFRA.has(n.conclusion) || (await neverStarted(github, repo, n))) out.push(n.databaseId);
    else if (n.conclusion === "FAILURE") {
      if (checkLabel(n) === CODE_REVIEW.name && (await github.codeReviewInfra(repo, number, pr.headRefOid))) out.push(n.databaseId);
      else {
        const job = await github.job(repo, n).catch(() => undefined);
        const lost = (job?.annotations ?? []).some((a) => a.annotation_level === "failure" && RUNNER_LOST.test(String(a.message ?? "")));
        if (lost && job.steps?.length && !job.steps.some((st) => st.conclusion === "failure")) out.push(n.databaseId);
      }
    }
  }
  if (own.length && out.length === own.length) out.push(...red.filter((n) => checkLabel(n) === GATE_CHECK && n.databaseId).map((n) => n.databaseId));
  return out;
}

/** The receipt for a merge stopped by checks that never ran: the checks and GitHub's annotation, and no code change asked for. */
export function environmentReceipt(ref, checks, head, { retried = true } = {}) {
  const clean = (s) => String(s ?? "").replace(/[\p{Cc}`"]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  const list = checks.map((c) => `\`${clean(c.name)}\``).join(", ");
  const said = [...new Set(checks.map((c) => clean(c.note)).filter(Boolean))].map((w) => `"${w}"`).join(" ");
  return [
    `**Blocked by the environment, not the code:** ${ref} is fine. ${checks.length === 1 ? "The check" : "The checks"} ${list} never started, so nothing judged head \`${String(head).slice(0, 12)}\` and the head is not at fault.`,
    said ? `GitHub's own words: ${said}.` : "",
    retried
      ? "It was re-run once at the same head and the same thing happened, so this is the environment, not the code: a rebase or a new head would change nothing."
      : "GitHub wouldn't re-run it from here, and nothing about the head is at fault: a rebase or a new head would change nothing.",
    "That has to change outside the repository; the branch needs no change. Ask for the merge again once it has.",
  ].filter(Boolean).join(" ");
}

/**
 * The receipt for the failing-checks stop: the stop's own sentence, then each non-green required check as
 * `<name> — <conclusion>` and, under a failed one, its failing step and GitHub's failure annotation (the job read the
 * environment's checks already use), so the reader can tell a red diff from a stale base without running `gh pr checks`.
 * A rollup red only because checks were cancelled names those as CANCELLED: they never judged the commit.
 */
export async function checksReceipt(github, repo, pr, why) {
  const red = redChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup);
  const checks = red.failed.length ? red.failed : red.cancelled;
  // Inside a code span a value only has to lose its backticks; free text (an annotation, a status's description) is written
  // out by whoever can push, so its Markdown is escaped and it renders as the words GitHub gave, never as a link or an image.
  const clean = (s, max = 200) => String(s ?? "").replace(/[\p{Cc}`"]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const literal = (s, max = 200) => clean(s, max).replace(/([\\*_[\]<>|#~!])/g, "\\$1");
  const lines = [];
  for (const n of checks.slice(0, 8)) {
    const conclusion = n.conclusion ?? n.state ?? "UNKNOWN";
    lines.push(`- \`${checkName(checkLabel(n))}\` — ${clean(conclusion, 40)}`);
    // A cancelled check never ran, so it has no failing step or annotation to quote.
    if (conclusion === "CANCELLED") continue;
    const job = n.__typename === "CheckRun" && github.job ? await github.job(repo, n).catch(() => undefined) : undefined;
    const step = (job?.steps ?? []).find((s) => s.conclusion === "FAILURE")?.name;
    const said = [
      step ? `step \`${clean(step, 80)}\` failed` : "",
      ...(job?.annotations ?? []).filter((a) => a.annotation_level === "failure").map((a) => literal(a.message)),
      literal(n.description),
    ];
    for (const line of [...new Set(said.filter(Boolean))].slice(0, 3)) lines.push(`  - ${line}`);
  }
  if (checks.length > 8) lines.push(`- and ${checks.length - 8} more`);
  return lines.length ? `${why}\n\n${lines.join("\n")}` : why;
}

/**
 * Red checks on the PR's head worth one automatic re-run (roadmap-keeper#111, 2026-11-13: its merge failed on a code-review
 * timeout and waited for someone to re-run it). Only when every red check is an Actions job that never judged the commit
 * (INFRA, or code-review's own "didn't finish") and none was re-run on this head already: one real failure fails the merge as
 * before. `reruns` is what was re-run ({ name: { head, id } }). Returns { rerun: [check nodes] }, { wait: "stale" } (a re-run's
 * new job isn't on GitHub yet), { wait: "running" } (other checks still run: a workflow run re-runs only once it's over), or
 * undefined: the failure stands.
 */
export async function infraRetry(github, repo, number, pr, reruns = {}) {
  const head = pr.headRefOid;
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const red = (rollup?.contexts?.nodes ?? []).filter((n) => !advisory(n) && FAILING.has(n.conclusion ?? n.state));
  if (!red.length || rollup?.contexts?.pageInfo?.hasNextPage) return undefined;
  const rerun = [];
  let stale = false;
  for (const n of red) {
    if (n.__typename !== "CheckRun" || !n.databaseId || !n.checkSuite?.workflowRun?.databaseId) return undefined;
    const was = reruns[n.name];
    if (was?.head === head) {
      // The job re-run already: still the old one is GitHub catching up; a new one red is the second failure, final.
      if (was.id !== n.databaseId) return undefined;
      stale = true;
      continue;
    }
    if (INFRA.has(n.conclusion)) rerun.push({ ...n, why: INFRA_WHY[n.conclusion] });
    else if (n.name === CODE_REVIEW.name && n.conclusion === "FAILURE" && (await github.codeReviewInfra(repo, number, head))) rerun.push({ ...n, why: "the code review never finished" });
    else return undefined;
  }
  if (stale) return { wait: "stale" };
  if (namedChecks(rollup).some((c) => c.pending)) return { wait: "running" };
  return { rerun };
}

/** How long a re-run's new job may take to show on GitHub before the failure stands. */
const RERUN_SHOWS_MINUTES = 10;
/**
 * The environment's answer to red checks that never started, ahead of the plain failure: { wait } while their jobs are re-run
 * once at this same head, or { stop, names } with the receipt once a re-run came back the same way (or GitHub refused it).
 * Undefined when the failure is the commit's own, which `retryInfra` and the PR decisions report as before. The head never
 * moves: nothing here rebases, updates or pushes.
 */
export async function environmentRetry(github, repo, number, pr, ref, checks) {
  checks = checks ?? (await environmentFailure(github, repo, pr));
  if (!checks.length) return undefined;
  const head = pr.headRefOid;
  const reruns = (await github.reruns(repo, number)) ?? {};
  const shown = checks.map((c) => ({ name: c.name, note: c.note }));
  const names = checks.map((c) => c.name);
  // A re-run already happened on this head: a new job that never started again is the second identical cause, final and said
  // once; the old job still on GitHub is it catching up.
  if (checks.some((c) => reruns[c.name]?.head === head && reruns[c.name].id !== c.id)) return { stop: environmentReceipt(ref, shown, head), names };
  if (checks.every((c) => reruns[c.name]?.head === head)) return { wait: RERUN_SHOWS_MINUTES };
  // Only GitHub's own re-run of the failed jobs: the same head, no new commit. Refused (no Actions permission, or no workflow
  // run behind the check): say so, don't retry.
  if (checks.some((c) => !c.run)) return { stop: environmentReceipt(ref, shown, head, { retried: false }), names };
  const runs = new Map();
  for (const c of checks) runs.set(c.run, [...(runs.get(c.run) ?? []), { name: c.name, id: c.id }]);
  for (const [run, list] of runs) {
    try {
      await github.rerun(repo, number, { run, checks: list, head });
    } catch {
      return { stop: environmentReceipt(ref, shown, head, { retried: false }), names };
    }
    await sayRerun(github, repo, number, head, list.map((c) => ({ name: c.name, why: `never started${checks.find((x) => x.name === c.name)?.note ? ` (GitHub: "${checks.find((x) => x.name === c.name).note}")` : ""}` })));
  }
  return { wait: RERUN_SHOWS_MINUTES };
}

/**
 * The merge's answer to red checks: { key, limit } for its wait while they are re-run once (infraRetry), each workflow run's
 * failed jobs in one call; undefined when the failure stands, also when GitHub refuses the re-run (no permission).
 */
async function retryInfra(github, repo, number, pr) {
  const r = await infraRetry(github, repo, number, pr, (await github.reruns(repo, number)) ?? {});
  if (!r) return undefined;
  if (r.wait === "running") return { key: "running" };
  if (r.wait) return { key: "rerun", limit: RERUN_SHOWS_MINUTES };
  return rerunChecks(github, repo, number, pr.headRefOid, r.rerun);
}

/** Re-runs the failed jobs of each check's workflow run (the whole run for a ghost), one call per run; undefined when refused (no permission). */
async function rerunChecks(github, repo, number, head, nodes, key = "rerun") {
  const runs = new Map();
  for (const n of nodes) {
    const run = n.checkSuite.workflowRun.databaseId;
    runs.set(run, [...(runs.get(run) ?? []), { name: n.name, id: n.databaseId, why: key === "ghost" ? `still pending ${GHOST_MINUTES}+ minutes after its workflow run ended (a ghost job)` : n.why }]);
  }
  for (const [run, checks] of runs) {
    try {
      await github.rerun(repo, number, { run, checks: checks.map(({ name, id }) => ({ name, id })), head, whole: key === "ghost" });
    } catch {
      return undefined;
    }
    await sayRerun(github, repo, number, head, checks);
  }
  return { key, limit: RERUN_SHOWS_MINUTES };
}

/**
 * Every automatic re-run says so on the PR (the no-retry rule: a red check is re-run only for an infrastructure failure, and
 * the PR says so): which checks, at which head, and the infrastructure reason. The re-run stands even if the note can't post.
 */
async function sayRerun(github, repo, number, head, checks) {
  const body = `Re-running once at \`${String(head).slice(0, 12)}\` for an infrastructure failure, not the code:\n\n${checks.map((c) => `- \`${c.name}\`: ${c.why}`).join("\n")}`;
  await github.comment(repo, number, body).catch(() => {});
}

/** Minutes a workflow run may be over before a check of it still pending is a ghost job (never settles by itself). */
const GHOST_MINUTES = 10;
/**
 * Pending checks of the head whose workflow run (`github.run`: { status, updatedAt }) has been over for GHOST_MINUTES
 * (Aiden-HQ/AidenHQ#141, roadmap-keeper#214): the run is re-run once per check per head, by a whole-run re-run (a ghost job isn't failed, so the failed-jobs re-run skips it). A ghost never
 * counts as passed; if the re-run doesn't clear it, the stuck limit reports it. Undefined when no check is one.
 */
export async function ghostRetry(github, repo, number, pr, now) {
  const head = pr.headRefOid;
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const reruns = (await github.reruns(repo, number)) ?? {};
  const ghosts = [];
  for (const n of rollup?.contexts?.pageInfo?.hasNextPage ? [] : rollup?.contexts?.nodes ?? []) {
    const run = n.checkSuite?.workflowRun?.databaseId;
    if (advisory(n) || n.__typename !== "CheckRun" || n.status === "COMPLETED" || !n.databaseId || !run || reruns[n.name]?.head === head) continue;
    const r = await github.run(repo, run).catch(() => undefined);
    if (r?.status === "completed" && now - Date.parse(r.updatedAt) > GHOST_MINUTES * 60_000) ghosts.push(n);
  }
  return ghosts.length ? rerunChecks(github, repo, number, head, ghosts, "ghost") : undefined;
}
const RERUN_WAIT = { rerun: "a check that failed for infrastructure reasons is being re-run once", ghost: "a check is pending although its workflow run is over, so the run is being re-run once", running: "checks are running (one that failed for infrastructure reasons is re-run once they're done)" };

/**
 * The named checks in a status rollup, advisory ones left out, each { name, ok, pending } (tiering and reviewer-approved merges need at least one,
 * all passed; ciState's "no checks is green" stays for the owner's own merges).
 */
export function namedChecks(rollup) {
  const pass = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return (rollup?.contexts?.nodes ?? [])
    .filter((n) => !advisory(n))
    .map((n) => ({ name: n.name ?? n.context, status: n.__typename === "CheckRun" ? (n.status === "COMPLETED" ? n.conclusion : "PENDING") : n.state }))
    .filter((c) => c.name)
    .map((c) => ({ name: c.name, status: c.status, ok: pass.has(c.status), pending: ["PENDING", "EXPECTED", null, undefined].includes(c.status), ...(c.status === "SKIPPED" ? { skipped: true } : {}) }));
}

/**
 * A check name as the receipt may print it. Whoever can push to the repo sets the name and agents read the receipt, so a name
 * is untrusted text: it prints only when it is short and plain (no brackets, backticks, angle brackets or newlines, so nothing
 * to render or fence), anything else is "an unnamed check". `gh pr checks <n>` names every check in full.
 */
const checkName = (n) => (/^[A-Za-z0-9 ._\/()-]{1,40}$/.test(n) ? n : "an unnamed check");

/**
 * The checks still running on a PR's head, named: " (still running: test, build)". A stall then says which check is stuck
 * without opening GitHub. Listed at most six, then a count.
 */
function runningChecks(rollup) {
  const names = namedChecks(rollup).filter((c) => c.pending).map((c) => checkName(c.name));
  if (!names.length) return "";
  const shown = names.slice(0, 6).join(", ");
  return ` (still running: ${shown}${names.length > 6 ? `, and ${names.length - 6} more` : ""})`;
}

/**
 * A card filed seconds after the PR opened sees no checks yet, though CI is about to start. Re-reads the tier state (`read()`) until
 * every PR whose head matches the card has a named check, or `until` ms pass, then returns what it last read.
 */
export async function awaitChecks(read, { every = 10_000, until = 90_000, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) } = {}) {
  let state = await read();
  for (let waited = 0; waited < until && state.some((s) => s.headMatches && !s.checks.length); waited += every) {
    await sleep(every);
    state = await read();
  }
  return state;
}

/**
 * The aggregate gate check a repository's CI may end with (the product's ci.yml): its jobs that depend on others appear
 * only once those finish, so a PR can look all green for a moment before them. When the base branch's own rollup has
 * the gate, a PR head without it is still pending: the gate is added to the head's rollup as queued.
 */
export const GATE_CHECK = "ci-required";
/** Whether a rollup carries the gate check. */
export const hasGate = (rollup) => (rollup?.contexts?.nodes ?? []).some((n) => (n.name ?? n.context) === GATE_CHECK);
export function withGate(data) {
  const pr = data?.repository?.pullRequest;
  if (pr?.state && pr.state !== "OPEN") return data; // a closed or merged head's rollup is final: never a queued gate added to it
  const head = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const base = pr?.baseRef?.target?.statusCheckRollup;
  if (!head || !hasGate(base) || hasGate(head)) return data;
  head.contexts = { ...(head.contexts ?? {}), nodes: [...(head.contexts?.nodes ?? []), { __typename: "CheckRun", name: GATE_CHECK, status: "QUEUED", conclusion: null }] };
  if (head.state === "SUCCESS") head.state = "PENDING";
  return data;
}

/** "green", "red" or "pending" for a status rollup, advisory checks left out. No checks at all counts as green. */
export function ciState(rollup) {
  rollup = required(rollup);
  if (!rollup) return "green";
  if (rollup.state === "SUCCESS") return "green";
  if (rollup.state === "FAILURE" || rollup.state === "ERROR") return "red";
  return "pending";
}

/** The merge method: the repository's only allowed one, else squash, then merge commit, then rebase. */
export function mergeMethod(repo) {
  if (repo.squashMergeAllowed) return "squash";
  if (repo.mergeCommitAllowed) return "merge";
  if (repo.rebaseMergeAllowed) return "rebase";
  return undefined;
}

/** Approved: GitHub's review decision, or (where reviews aren't required) an approval and no change requests. */
export function approved(pr) {
  if (pr.reviewDecision) return pr.reviewDecision === "APPROVED";
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => r.state);
  return states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
}

/**
 * What to do with the next PR, from GitHub's view of it: { do: "merge" | "ready" | "update" | "wait" | "skip" | "stop", why }.
 * `updatedHead` is the head we already asked GitHub to update (so a branch is updated once per head).
 */
export function prDecision(pr, { updatedHead, cardIsReview = false, approvedHead, strictChecks = false } = {}) {
  const ref = `#${pr.number}`;
  if (pr.state === "MERGED") return { do: "skip", why: `${ref} was already merged${pr.mergedBy?.login ? ` by ${pr.mergedBy.login}` : ""}` };
  if (pr.state === "CLOSED") return { do: "stop", why: `${ref} is closed` };
  // In the agents org nobody reviews on GitHub: the owner's tap on the merge card is the review, so it holds only for the
  // commit the card showed (or the runner's own replay of it, for a stacked PR), and never over a change request.
  if (cardIsReview) {
    if (!approvedHead || pr.headRefOid !== approvedHead) return { do: "stop", why: `${ref} changed since its merge card (now \`${String(pr.headRefOid).slice(0, 12)}\`): it needs a new card` };
    const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => r.state);
    if (pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED")) return { do: "stop", why: `${ref} has changes requested` };
  }
  if (!cardIsReview && !approved(pr)) return { do: "stop", why: `${ref} isn't approved${pr.reviewDecision ? ` (GitHub: ${pr.reviewDecision.toLowerCase().replace(/_/g, " ")})` : ""}` };
  if (pr.isDraft) return { do: "ready", why: `${ref} is an approved draft` };
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const ci = ciState(checks);
  if (ci === "red") return { do: "stop", why: `${ref} has failing checks (\`gh pr checks ${pr.number}\` names them)`, red: true };
  switch (pr.mergeStateStatus) {
    case "DIRTY":
      return { do: "stop", why: `${ref} has conflicts with \`${pr.baseRefName}\`` };
    case "BEHIND":
      return pr.headRefOid === updatedHead ? { do: "wait", why: `${ref} is being updated with \`${pr.baseRefName}\`` } : { do: "update", why: `${ref} is behind \`${pr.baseRefName}\`` };
    case "UNSTABLE":
      if (ci === "pending") return { do: "wait", why: `${ref}'s checks are running${runningChecks(checks)}`, key: "checks" };
      // GitHub counts an advisory check that isn't green; with every other check green, that's no reason to wait.
      if (required(checks) === checks) return { do: "stop", why: `${ref} has failing checks`, red: true };
      break;
    case "BLOCKED":
      return ci === "pending" ? { do: "wait", why: `${ref}'s checks are running${runningChecks(checks)}`, key: "checks" } : { do: "stop", why: `GitHub won't merge ${ref} yet (blocked by a branch rule)` };
    case "CLEAN":
    case "HAS_HOOKS":
      break;
    default: // UNKNOWN: GitHub is still working it out
      return { do: "wait", why: `GitHub is still checking whether ${ref} can merge` };
  }
  if (ci === "pending") return { do: "wait", why: `${ref}'s checks are running${runningChecks(checks)}`, key: "checks" };
  if (skippedImageScan(pr)) return { do: "stop", why: `${ref} changes an image but its image-scan check was skipped` };
  // A merge the AI reviewer approved: no checks is not green; every named check must have passed on this head.
  if (strictChecks) {
    const named = namedChecks(checks);
    // CI starts a little after a push (a card's merge is stepped seconds after it): no checks yet waits, ten minutes at most.
    if (!named.length) return { do: "wait", why: `${ref} has no checks yet, and a merge without the owner's tap needs green checks`, limit: 10 };
    if (named.some((c) => c.pending)) return { do: "wait", why: `${ref}'s checks are running${runningChecks(checks)}`, key: "checks" };
    if (named.some((c) => !c.ok)) return { do: "stop", why: `${ref}: ${named.filter((c) => !c.ok).length} named check(s) not green (\`gh pr checks ${pr.number}\` names them)`, red: true };
  }
  const base = ciState(pr.baseRef?.target?.statusCheckRollup);
  if (base === "red") {
    // The PR that fixes a red base must be able to land: its own green checks (above) count when it already contains the
    // base's tip, so they prove the tree after the merge. Behind: update it first. Unknown: stop.
    const behind = pr.baseRef?.compare?.behindBy;
    if (behind === 0) return { do: "merge" };
    if (behind > 0) return pr.headRefOid === updatedHead ? { do: "wait", why: `${ref} is being updated with \`${pr.baseRefName}\`` } : { do: "update", why: `\`${pr.baseRefName}\` is red and ${ref} is behind it` };
    return { do: "stop", why: `\`${pr.baseRefName}\` is red before merging ${ref} (its failing checks are on GitHub)` };
  }
  if (base === "pending") return { do: "wait", why: `CI is running on \`${pr.baseRefName}\`${runningChecks(pr.baseRef.target.statusCheckRollup)}`, key: "base-checks" };
  return { do: "merge" };
}

const minutes = (ms) => Math.round(ms / 60_000);
/** UTC, e.g. "14:05 UTC": the host's own zone is the server's, not the reader's, and the comments' timestamps are UTC. */
const clock = (iso) => `${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

/**
 * Move a running queue on by one poll. `github` does the I/O: pr(repo, number), commit(repo, oid),
 * merge(repo, number, { sha, method }) → merge commit oid, markReady(prNodeId, repo), updateBranch(repo, number, head).
 * Mutates and returns the queue; `say` collects comments for the task, `done` is set when it ends.
 * `train(repo)`: PRs of that repo that would merge now are marked `ready` instead, the run of them at the head of the queue
 * (advanceTrains decides whether they go as a train); a PR riding a train waits for it.
 */
export async function advance(queue, { github, now = new Date(), timeoutMinutes = 90, settleMinutes = 5, cardIsReview = () => false, train }) {
  const say = [];
  if (queue.state !== "running") return { queue, say };
  if (queue.independent) return advanceEach(queue, { github, now, timeoutMinutes });
  const t = now.getTime();
  const total = queue.prs.length;
  const stop = (why) => {
    queue.state = "stopped";
    queue.stoppedAt = now.toISOString();
    queue.reason = why;
    return { queue, say: [...say, stoppedComment(queue)], done: "stopped" };
  };
  const waiting = (key, why, limit = timeoutMinutes) => {
    queue.wait ??= { key, since: now.toISOString() };
    if (queue.wait.key !== key) queue.wait = { key, since: now.toISOString() };
    queue.waiting = why;
    if (t - Date.parse(queue.wait.since) > limit * 60_000) return stop(`stuck for ${limit} minutes: ${why}`);
    return { queue, say };
  };
  // One PR's own wait: past its bound that PR is "not merged", naming the check, and the queue goes on to the next one
  // rather than holding every later PR behind a head that will not finish.
  const waitOn = (next, pr, key, why, limit = timeoutMinutes) => {
    if (queue.wait?.key !== key) queue.wait = { key, since: now.toISOString() };
    queue.waiting = why;
    if (t - Date.parse(queue.wait.since) <= limit * 60_000) return { queue, say };
    Object.assign(next, { status: "failed", note: `stuck for ${limit} minutes: ${why}`, headRef: pr?.headRefName });
    delete queue.wait;
    say.push(`**Not merged:** ${next.url}: stuck for ${limit} minutes: ${why}. Re-run its checks at the same head, then ask for it again.`);
    return "next";
  };

  // 1. The last merge: its CI on the base branch must finish green.
  const last = queue.prs.filter((p) => p.status === "merged" && p.sha).at(-1);
  if (last && !last.ciAt) {
    let head = last.sha;
    let rollup = (await github.commit(last.repo, head))?.statusCheckRollup;
    let ci = ciState(rollup);
    let cancelled = ci === "red" && cancelledRun(rollup);
    // A newer push to the base supersedes the merge commit's run and cancels it: the merge commit has no result, but
    // the base's current tip includes it, so judge that instead of calling the base red.
    if (cancelled) {
      const tip = (await github.baseStatus(last.repo, last.base)).tip;
      if (tip && tip !== head) {
        head = tip;
        rollup = (await github.commit(last.repo, head))?.statusCheckRollup;
        ci = ciState(rollup);
        cancelled = ci === "red" && cancelledRun(rollup);
      }
    }
    // A base whose CI ends with the gate check (`gate`, read at the merge) has settled once that check passed on the commit:
    // it runs after every job it covers. Without one, checks show up a little after the merge, so no checks yet is only
    // green after a short settle.
    const settled = last.gate ? namedChecks(rollup).some((c) => c.name === GATE_CHECK && c.ok) : t - Date.parse(last.mergedAt) >= settleMinutes * 60_000;
    // Red means a check failed. A cancelled run never judged the commit (a newer push superseded it, or someone cancelled
    // it), so it is reported as cancelled, never as a red base: the gate failing only because its dependencies were
    // cancelled is not a check failure either.
    if (cancelled) return stop(`CI was cancelled on \`${last.base}\` after merging #${last.number}: the run on \`${head.slice(0, 12)}\` was cancelled, so it never tested that commit and says nothing about \`${last.base}\``);
    if (ci === "red") {
      const failed = redChecks(rollup).failed.map((n) => checkName(checkLabel(n)));
      return stop(`CI failed on \`${last.base}\` after merging #${last.number}: ${failed.join(", ")} failed (its failing checks are on GitHub)`);
    }
    // A tip we moved to has no grace: without a check of its own it is still starting up.
    if (ci === "pending" || !settled || (head !== last.sha && !namedChecks(rollup).length)) {
      return waiting(`ci:${head}`, `CI is running on \`${last.base}\` after #${last.number}${runningChecks(rollup)}`);
    }
    last.ciAt = now.toISOString();
    last.checks = rollup?.contexts?.nodes?.length ?? 0;
    const merged = queue.prs.filter((p) => p.status === "merged").length;
    const next = queue.prs.find((p) => p.status === "pending");
    const nextAt = new Date(Math.max(Date.parse(last.mergedAt) + queue.gapMinutes * 60_000, t)).toISOString();
    say.push(
      `Merged ${last.url} (${merged} of ${total}) and \`${last.base}\` is green${last.checks ? ` (${last.checks} checks)` : ""}.${next ? ` Next: #${next.number}${queue.gapMinutes && Date.parse(nextAt) > t ? ` after ${clock(nextAt)}` : ""}.` : ""}`,
    );
  }

  // 2. The gap since the last merge.
  if (last && queue.prs.some((p) => p.status === "pending") && t < Date.parse(last.mergedAt) + queue.gapMinutes * 60_000) {
    queue.waiting = `the ${queue.gapMinutes}-minute gap after #${last.number}`;
    delete queue.wait;
    return { queue, say };
  }

  // A PR on a merge train: the train merges it (advanceTrains), after the PRs ahead of it.
  const riding = queue.prs.find((p) => p.status === "pending" && p.train);
  if (riding) {
    queue.waiting = `merge train \`merge-train/${riding.train}\` (#${riding.number})`;
    delete queue.wait;
    return { queue, say };
  }

  // 3. The next PR: merge it when everything is green, skip it if someone else merged it. With trains on, each PR that would
  // merge now is marked ready, and the first one that wouldn't ends the run without acting (it is decided once those land).
  const readied = [];
  for (const next of queue.prs.filter((p) => p.status === "pending")) {
    delete next.ready;
    if (readied.length >= TRAIN_MAX) break;
    const data = await github.pr(next.repo, next.number);
    const pr = data?.repository?.pullRequest;
    if (!pr) return stop(`couldn't find ${next.url} on GitHub`);
    const defaultBranch = data.repository.defaultBranchRef?.name;
    // Stacked on a head this queue gave up on: its commits would land on an unmerged parent, so it waits for a later
    // request instead of spending its own bound on the open parent and holding the PRs after it. A parent that merged is
    // replayed onto the default branch below, not skipped.
    const dropped = queue.prs.find((p) => p.status === "failed" && p.headRef && p.repo.toLowerCase() === next.repo.toLowerCase() && p.headRef === pr.baseRefName);
    if (dropped) {
      Object.assign(next, { status: "failed", note: `stacked on #${dropped.number}, which did not merge`, headRef: pr.headRefName });
      say.push(`#${next.number} skipped: stacked on #${dropped.number}, which did not merge.`);
      continue;
    }
    const review = pr.state === "OPEN" && cardIsReview(next.repo) && Boolean(next.head);
    // Moved only by this queue's own update (GitHub's merge of the base into exactly the approved head) with the change's
    // content unchanged (`github.samePatch`, against the card's key): out of the queue and asked for again on the new head,
    // in code, so its card is filed anew with no turn of the task's Engineer. Anything else that moved it stops below.
    if (review && pr.headRefOid !== next.head && next.updatedHead === next.head && pr.commits?.nodes?.[0]?.commit?.parents?.nodes?.[0]?.oid === next.head && (await github.samePatch?.(next.repo, next.number, next.patch, pr.headRefOid))) {
      Object.assign(next, { status: "retiered", note: `asked again at \`${String(pr.headRefOid).slice(0, 12)}\`` });
      delete queue.wait;
      say.push(`${next.url}: updating it with \`${pr.baseRefName}\` moved its head to \`${String(pr.headRefOid).slice(0, 12)}\` and left its change as it was, so its merge is asked for again on that head, in code.`);
      if (!queue.prs.some((p) => p.status === "pending")) Object.assign(queue, { state: "handed", finishedAt: now.toISOString(), waiting: undefined });
      return { queue, say, retier: [{ repo: next.repo, number: next.number, url: next.url }] };
    }
    const base = await settleBase(github, next.repo, pr, defaultBranch);
    // A base that can never land on the default branch fails this PR now, not after the queue's bound: a ready PR ahead of
    // it doesn't postpone the verdict to a later poll.
    if (base.fail) {
      Object.assign(next, { status: "failed", note: base.fail, headRef: pr.headRefName });
      say.push(`**Not merged:** ${next.url}: ${base.fail}.`);
      continue;
    }
    if (readied.length && base !== "ok") break;
    if (base === "retarget") {
      // Stacked on a PR this same approved queue merged (or found merged): the runner replays this PR's own approved commits
      // (those after the parent's head) onto the default branch in its own clone, pushes them as its head and retargets it.
      // Its checks then have to pass on that head. A parent outside the queue, a parent that merged at a head its card didn't
      // approve, a conflict or a moved head needs a new card. The replay starts after the parent's approved head.
      const parent = queue.prs.find((p) => ["merged", "skipped"].includes(p.status) && p.repo.toLowerCase() === next.repo.toLowerCase() && p.headRef === pr.baseRefName);
      const by = `#${next.number} is stacked on a merged branch`;
      if (!review || !parent || !github.rebuild || pr.headRefOid !== next.head) return stop(`${by}: retarget it to \`${defaultBranch}\` and ask for a new merge`);
      if (!parent.head || parent.headOid !== parent.head) return stop(`${by}, and #${parent.number} merged at a head its card didn't approve: ask for a new merge`);
      // Replayed once: a retarget that failed after the push is retried on the next poll without replaying again.
      if (!next.rebound) {
        try {
          // The card's own head stays as `approved`: a PR stacked on this one replays from it, not from the replay (A → B → C).
          Object.assign(next, { approved: next.head, head: await github.rebuild(next.repo, pr, parent.approved ?? parent.head, defaultBranch), rebound: true });
        } catch (err) {
          return stop(`${by}, and its approved commits couldn't be replayed onto \`${defaultBranch}\` (${String(err.stderr || err.message || err).trim().split("\n").pop().slice(0, 200)}): it needs a rebase and a new merge`);
        }
      }
      await github.retarget(next.repo, next.number, defaultBranch);
      const head = next.head;
      say.push(`Retargeted ${next.url} to \`${defaultBranch}\`: the branch it was stacked on merged with #${parent.number}, so its approved commits were replayed onto \`${defaultBranch}\` as \`${head.slice(0, 12)}\`.`);
      return waiting(`pr:${next.number}:retarget`, `#${next.number} was just retargeted to \`${defaultBranch}\``);
    }
    if (base !== "ok") {
      const r = waitOn(next, pr, `pr:${next.number}:base:${base.wait}`, `#${next.number} ${base.wait}`);
      if (r !== "next") return r;
      continue;
    }
    // A head the runner replayed merges only with named checks, all green on it.
    const d = prDecision(pr, { updatedHead: next.updatedHead, cardIsReview: cardIsReview(next.repo), approvedHead: next.head, strictChecks: Boolean(queue.strict || next.rebound) });
    if (d.do === "skip") {
      Object.assign(next, { status: "skipped", note: d.why, headRef: pr.headRefName, headOid: pr.headRefOid });
      say.push(`Skipped ${next.url}: ${d.why}.`);
      continue;
    }
    if (readied.length && d.do !== "merge") break;
    // A red check that never started is the environment's, not the commit's: re-run it at this same head once, and the second
    // time it stops with GitHub's annotation. Nothing here moves the head.
    const env = d.do === "stop" && d.red ? await environmentRetry(github, next.repo, next.number, pr, `#${next.number}`) : undefined;
    if (env?.stop) return stop(env.stop);
    if (env) {
      const r = waitOn(next, pr, `pr:${next.number}:${pr.headRefOid}:infra`, `#${next.number}: a check that never started is being re-run once at the same head`, env.wait);
      if (r !== "next") return r;
      continue;
    }
    const retry = d.do === "stop" && d.red ? await retryInfra(github, next.repo, next.number, pr) : undefined;
    if (retry) {
      const r = waitOn(next, pr, `pr:${next.number}:${pr.headRefOid}:${retry.key}`, `#${next.number}: ${RERUN_WAIT[retry.key]}`, retry.limit);
      if (r !== "next") return r;
      continue;
    }
    if (d.do === "stop") return stop(d.red ? await checksReceipt(github, next.repo, pr, d.why) : d.why);
    if (d.do === "wait") {
      const ghost = d.key === "checks" ? await ghostRetry(github, next.repo, next.number, pr, t) : undefined;
      if (ghost) {
        const r = waitOn(next, pr, `pr:${next.number}:${pr.headRefOid}:ghost`, `#${next.number}: ${RERUN_WAIT.ghost}`, ghost.limit);
        if (r !== "next") return r;
        continue;
      }
      const r = waitOn(next, pr, `pr:${next.number}:${pr.headRefOid}:${d.key ?? d.why}`, d.why, d.limit);
      if (r !== "next") return r;
      continue;
    }
    if (d.do === "ready") {
      if (next.readied) return stop(`#${next.number} is still a draft after I marked it ready`);
      await github.markReady(pr.id, next.repo);
      next.readied = true;
      const r = waitOn(next, pr, `pr:${next.number}:ready`, `#${next.number} was just marked ready for review`);
      if (r !== "next") return r;
      continue;
    }
    if (d.do === "update") {
      await github.updateBranch(next.repo, next.number, pr.headRefOid);
      next.updatedHead = pr.headRefOid;
      const r = waitOn(next, pr, `pr:${next.number}:update`, d.why);
      if (r !== "next") return r;
      continue;
    }
    // A PR that changes the AI reviewer's own code merges only on a 100% reviewer-eval receipt for this head (evalgate.ts).
    const gate = await github.evalGate(next.repo, pr);
    if (readied.length && (gate?.stop || gate?.wait)) break;
    if (gate?.stop) return { ...stop(`${next.url}: ${gate.stop}`), turned: [{ repo: next.repo, number: next.number, url: next.url, head: pr.headRefOid, key: "eval" }] };
    if (gate?.wait) {
      const r = waitOn(next, pr, `pr:${next.number}:${pr.headRefOid}:eval`, gate.wait, EVAL_WAIT_MINUTES);
      if (r !== "next") return r;
      continue;
    }
    const method = mergeMethod(data.repository);
    if (readied.length && !method) break;
    if (!method) return stop(`\`${next.repo}\` allows no merge method I can use`);
    // A same-repo PR on the default branch, never replayed: it may ride a train. Its head, the base's tip and whether the base
    // has the aggregate gate check are what the train binds.
    if (train?.(next.repo) && !next.noTrain && !next.rebound && !pr.isCrossRepository && pr.baseRefName === defaultBranch && pr.baseRef?.target?.oid) {
      const hasGate = (pr.baseRef.target.statusCheckRollup?.contexts?.nodes ?? []).some((n) => checkLabel(n) === GATE_CHECK);
      next.ready = { at: now.toISOString(), head: pr.headRefOid, base: pr.baseRefName, tip: pr.baseRef.target.oid, gate: hasGate };
      readied.push(next);
      continue;
    }
    if (readied.length) break;
    try {
      next.sha = await github.merge(next.repo, next.number, { sha: pr.headRefOid, method });
    } catch (err) {
      return stop(`GitHub refused to merge #${next.number}: ${String(err.stderr || err.message || err).trim().split("\n").pop().slice(0, 300)}`);
    }
    Object.assign(next, { status: "merged", mergedAt: now.toISOString(), base: pr.baseRefName, method, headRef: pr.headRefName, headOid: pr.headRefOid, gate: hasGate(pr.baseRef?.target?.statusCheckRollup) });
    if (cardIsReview(next.repo)) await deleteHead(github, next.repo, pr, data.repository.defaultBranchRef.name);
    delete queue.wait;
    queue.waiting = `CI on \`${pr.baseRefName}\` after #${next.number}`;
    return { queue, say };
  }

  if (readied.length) {
    queue.waiting = `${readied.map((p) => `#${p.number}`).join(", ")} ready to merge`;
    delete queue.wait;
    return { queue, say, ready: readied };
  }

  // 4. Nothing left. A PR that stalled is reported by name; it doesn't keep the ones after it from merging. One asked for
  // again in code (retiered) ends the queue unfinished: the merge it was handed to finishes the task.
  if (queue.prs.some((p) => p.status === "retiered")) {
    Object.assign(queue, { state: "handed", finishedAt: now.toISOString(), waiting: undefined });
    return { queue, say };
  }
  const failed = queue.prs.filter((p) => p.status === "failed").length;
  const merged = queue.prs.filter((p) => p.status === "merged").length;
  queue.state = failed ? "stopped" : "done";
  if (failed) queue.reason = queue.prs.find((p) => p.status === "failed").note;
  queue.finishedAt = now.toISOString();
  delete queue.waiting;
  return {
    queue,
    say: [...say, summary(queue, failed ? `**Merges finished:** ${merged} merged, ${failed} not (see above).` : `**Done:** every PR is merged and CI is green, ${minutes(t - Date.parse(queue.startedAt))} minutes in all.`)],
    done: queue.state,
  };
}

/** The most PRs on one merge train. */
export const TRAIN_MAX = 5;
/** How long a train's commit may go without a check before the repository counts as running no CI on train branches. */
const TRAIN_NO_CI_MINUTES = 10;

/** A train commit's CI: "green", "red", "pending" or "none" (no named check yet). `gate`: the base ends with GATE_CHECK, so green waits for it. */
function trainCi(rollup, gate) {
  const named = namedChecks(rollup);
  if (!named.length) return "none";
  if (named.some((c) => !c.ok && !c.pending)) return "red";
  if (named.some((c) => c.pending) || (gate && !named.some((c) => c.name === GATE_CHECK))) return "pending";
  return "green";
}

/**
 * One minute's poll of every running card queue, with merge trains: each queue is advanced with `train` on, so the PRs that
 * would merge now come back ready. Per repository, while a train runs it is moved on (its CI, then its merges, or a split);
 * else two or more ready PRs on the same base tip start one (up to TRAIN_MAX, oldest queue first), and a lone ready PR is
 * advanced again without trains: today's path. `entries` are [{ key, queue }]; `trains` ({ seq, live: { <repo>: train } }) is
 * the caller's to keep between polls, and is mutated. Returns a Map of key → that queue's step (advance's shape, or
 * { error } when its own advance threw). `github` adds createRef(repo, branch, sha), mergeInto(repo, branch, head, message)
 * → the new tip, or undefined on a conflict, and deleteBranch(repo, branch).
 */
export async function advanceTrains(entries, trains, { github, now = new Date(), timeoutMinutes = 90, settleMinutes = 5, cardIsReview = () => false, train }) {
  trains.seq ??= 0;
  trains.live ??= {};
  const steps = new Map();
  const opts = { github, now, timeoutMinutes, settleMinutes, cardIsReview };
  const run = async (e, o) => {
    const before = steps.get(e.key);
    let step;
    try {
      step = await advance(e.queue, o);
    } catch (error) {
      step = { error };
    }
    steps.set(e.key, before && !before.error ? { ...step, say: [...before.say, ...(step.say ?? [])] } : step);
  };
  const said = (key, line) => steps.get(key)?.say?.push(line);
  const t = now.getTime();
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const find = (m) => {
    // A queue whose own advance threw this poll is saved as it was read, so nothing the train does may touch it.
    const e = entries.find((x) => x.key === m.key && x.queue.state === "running" && !steps.get(x.key)?.error);
    return e && { e, p: e.queue.prs.find((p) => p.status === "pending" && same(p.repo, m.repo) && p.number === m.number) };
  };
  const live = Object.values(trains.live);
  // A PR that says it rides a train that no longer runs (the runner's state was cut short): free again.
  for (const { queue } of entries) for (const p of queue.prs) if (p.train && !live.some((x) => x.n === p.train && x.groups.flat().some((m) => m.number === p.number && same(m.repo, p.repo)))) delete p.train;

  for (const e of entries) await run(e, { ...opts, train });

  // A train's members off the train, each told why on its task; `noTrain`: the repository's CI didn't judge the train, so
  // they go one at a time from now on.
  const dissolve = async (T, why, { noTrain = false } = {}) => {
    for (const m of T.groups.flat()) {
      const f = find(m);
      if (!f?.p) continue;
      delete f.p.train;
      delete f.p.ready;
      if (noTrain) f.p.noTrain = true;
      said(m.key, `${m.url} left merge train \`merge-train/${T.n}\`: ${why}.${noTrain ? " It merges on its own." : ""}`);
    }
    await drop(T);
    delete trains.live[T.repo.toLowerCase()];
  };
  const drop = async (T) => {
    if (!T.n) return;
    for (const b of [`merge-build/${T.n}`, `merge-train/${T.n}`]) await github.deleteBranch(T.repo, b).catch(() => {});
  };
  // The train's first group built: a new branch at the base's tip with each member's bound head merged into it, in order.
  // A conflict between them is a red train. Only a whole build gets a sha to read CI on: one cut short is built again.
  const build = async (T) => {
    Object.assign(T, { n: ++trains.seq, phase: "build" });
    delete T.sha;
    const branch = `merge-build/${T.n}`;
    const tip = (await github.baseStatus(T.repo, T.base)).tip;
    if (!tip) throw new Error(`couldn't read the tip of \`${T.base}\``);
    for (const m of T.groups.flat()) {
      const f = find(m);
      if (f?.p) f.p.train = T.n;
    }
    await github.createRef(T.repo, branch, tip);
    T.tip = tip;
    const group = T.groups[0];
    let sha = tip;
    for (const m of group) {
      sha = await github.mergeInto(T.repo, branch, m.head, `Merge #${m.number} at ${m.head.slice(0, 12)} (merge train)`);
      if (!sha) return { conflict: m };
    }
    await github.createRef(T.repo, `merge-train/${T.n}`, sha);
    await github.deleteBranch(T.repo, branch).catch(() => {});
    Object.assign(T, { sha, phase: "ci", since: now.toISOString() });
    for (const m of group) said(m.key, `${m.url} is on merge train \`merge-train/${T.n}\`: \`${T.base}\` with ${group.map((x) => `#${x.number}`).join(", ")} merged on top, so CI runs once for all of them.`);
    return {};
  };
  // The first group failed (red CI or a conflict): a lone PR is turned back to its task; a bigger group is split in half.
  const failGroup = async (T, why) => {
    const group = T.groups.shift();
    await drop(T);
    if (group.length === 1) {
      const [m] = group;
      const f = find(m);
      if (f?.p) {
        delete f.p.train;
        Object.assign(f.p, { status: "failed", note: `fails on top of \`${T.base}\` (merge train \`merge-train/${T.n}\`)` });
        said(m.key, `**Not merged:** ${m.url}: ${why}. Its own head is green, so the failure is in how it combines with \`${T.base}\` at \`${T.tip.slice(0, 12)}\`${T.merged?.length ? ` and ${T.merged.map((n) => `#${n}`).join(", ")} merged just before it` : ""}. Fix it on its branch, then ask for the merge again.`);
        const step = steps.get(m.key);
        if (step && !step.error) step.turned = [...(step.turned ?? []), { repo: m.repo, number: m.number, url: m.url, head: m.head, key: "train" }];
      }
    } else {
      const half = Math.ceil(group.length / 2);
      T.groups.unshift(group.slice(0, half), group.slice(half));
      for (const m of group) said(m.key, `Merge train \`merge-train/${T.n}\` failed (${why}), so it is split in half and each half tried again.`);
    }
    return next(T);
  };
  // The next group, or the train is over.
  const next = async (T) => {
    if (!T.groups.length) {
      delete trains.live[T.repo.toLowerCase()];
      return;
    }
    const b = await build(T);
    if (b.conflict) return failGroup(T, `it conflicts with the PRs merged ahead of it on the train`);
  };

  for (const T of Object.values(trains.live)) {
    try {
      // Every member still waits in a running queue, or the train is off.
      if (T.groups.flat().some((m) => !find(m)?.p)) {
        await dissolve(T, "a PR on it left its merge queue");
        continue;
      }
      // A build cut short by GitHub: its branch goes, and the group is built again on a new one.
      if (T.phase === "build") {
        await drop(T);
        await next(T);
        continue;
      }
      if (T.phase === "ci") {
        const ci = trainCi((await github.commit(T.repo, T.sha))?.statusCheckRollup, T.gate);
        const age = t - Date.parse(T.since);
        if (ci === "none" && age > TRAIN_NO_CI_MINUTES * 60_000) await dissolve(T, `no CI ran on it in ${TRAIN_NO_CI_MINUTES} minutes`, { noTrain: true });
        else if (ci === "pending" && age > timeoutMinutes * 60_000) await dissolve(T, `its CI ran for over ${timeoutMinutes} minutes`, { noTrain: true });
        else if (ci === "red") await failGroup(T, `CI failed on \`merge-train/${T.n}\` at \`${T.sha.slice(0, 12)}\` (its failing checks are on that commit)`);
        else if (ci === "green") Object.assign(T, { phase: "merge", expect: T.tip, greenAt: now.toISOString() });
      }
      if (T.phase !== "merge") continue;
      // Green: each member squash-merged in order at its bound head. The base must still be the tree CI tested (the train's
      // tip, then each merge this train made), the PR still pass every check it passed alone, with the base's CI taken from
      // the train's run; anything else takes the train apart and the queues decide again.
      const rollup = (await github.commit(T.repo, T.sha))?.statusCheckRollup;
      const group = T.groups[0];
      let stopped = false;
      for (const m of group) {
        const { e, p } = find(m);
        const data = await github.pr(m.repo, m.number);
        const pr = data?.repository?.pullRequest;
        if (!pr || pr.headRefOid !== m.head) {
          await dissolve(T, pr ? `${m.url} moved to \`${String(pr.headRefOid).slice(0, 12)}\` after the train was built` : `${m.url} couldn't be read`);
          stopped = true;
          break;
        }
        if (pr.baseRef?.target?.oid !== T.expect) {
          await dissolve(T, `\`${T.base}\` moved under it (now \`${String(pr.baseRef?.target?.oid).slice(0, 12)}\`), so CI didn't test what would land`);
          stopped = true;
          break;
        }
        const asTested = { ...pr, baseRef: { ...pr.baseRef, target: { ...pr.baseRef.target, statusCheckRollup: rollup } } };
        const d = prDecision(asTested, { updatedHead: p.updatedHead, cardIsReview: cardIsReview(m.repo), approvedHead: p.head, strictChecks: Boolean(e.queue.strict) });
        if (d.do === "wait" && t - Date.parse(T.greenAt) <= timeoutMinutes * 60_000) {
          stopped = true; // GitHub still working out whether it can merge after the last one: next poll
          break;
        }
        const gate = d.do === "merge" ? await github.evalGate(m.repo, pr) : undefined;
        const method = mergeMethod(data.repository);
        if (d.do !== "merge" || gate?.stop || gate?.wait || !method) {
          await dissolve(T, d.do !== "merge" ? d.why : gate?.stop ?? gate?.wait ?? `\`${m.repo}\` allows no merge method I can use`);
          stopped = true;
          break;
        }
        let sha;
        try {
          sha = await github.merge(m.repo, m.number, { sha: m.head, method });
        } catch (err) {
          await dissolve(T, `GitHub refused to merge ${m.url}: ${githubSays(err)}`);
          stopped = true;
          break;
        }
        Object.assign(p, { sha, status: "merged", mergedAt: now.toISOString(), base: pr.baseRefName, method, headRef: pr.headRefName, headOid: pr.headRefOid, gate: Boolean(T.gate) });
        delete p.train;
        if (cardIsReview(m.repo)) await deleteHead(github, m.repo, pr, data.repository.defaultBranchRef?.name);
        e.queue.waiting = `CI on \`${pr.baseRefName}\` after #${m.number}`;
        delete e.queue.wait;
        said(m.key, `Merged ${m.url} from merge train \`merge-train/${T.n}\` (CI was green on \`${T.base}\` with ${group.map((x) => `#${x.number}`).join(", ")}).`);
        T.expect = sha;
        T.merged = [...(T.merged ?? []), m.number];
        m.done = true;
      }
      T.groups[0] = group.filter((m) => !m.done);
      if (stopped) continue;
      if (!T.groups[0].length) {
        T.groups.shift();
        await drop(T);
        await next(T);
      }
    } catch (err) {
      // GitHub on a bad minute: the train tries again next poll, and comes apart after ten in a row.
      T.errors = (T.errors ?? 0) + 1;
      if (T.errors >= 10) await dissolve(T, `GitHub kept failing: ${githubSays(err)}`, { noTrain: true }).catch(() => {});
    }
  }

  // New trains, and lone ready PRs on today's path. Nothing new starts on a repository whose train is still running.
  const ready = new Map();
  const stamp = now.toISOString();
  const byAge = [...entries].sort((a, b) => Date.parse(a.queue.startedAt ?? 0) - Date.parse(b.queue.startedAt ?? 0));
  for (const e of byAge) {
    if (steps.get(e.key)?.error) continue;
    for (const p of e.queue.prs) {
      if (p.status !== "pending" || p.ready?.at !== stamp) continue;
      const k = p.repo.toLowerCase();
      ready.set(k, [...(ready.get(k) ?? []), { e, p }]);
    }
  }
  for (const [k, list] of ready) {
    if (trains.live[k]) continue;
    const tip = list[0].p.ready.tip;
    const members = list.filter((x) => x.p.ready.tip === tip && x.p.ready.base === list[0].p.ready.base).slice(0, TRAIN_MAX);
    if (members.length < 2) {
      await run(list[0].e, opts);
      continue;
    }
    const T = { repo: list[0].p.repo, base: list[0].p.ready.base, gate: list[0].p.ready.gate, groups: [members.map(({ e, p }) => ({ key: e.key, repo: p.repo, number: p.number, url: p.url, head: p.ready.head }))] };
    trains.live[k] = T;
    try {
      await next(T);
    } catch (err) {
      await dissolve(T, `it couldn't be built (${githubSays(err)})`, { noTrain: true }).catch(() => {});
    }
  }
  for (const { queue } of entries) for (const p of queue.prs) delete p.ready;
  return steps;
}

/**
 * The runner's poll of its card queues (`entries`: [{ key, queue }], the others left out), with the trains kept in `store`
 * (get/set, key "merges:trains") between polls: advanceTrains's Map of steps.
 */
export async function advanceCards(entries, store, opts) {
  const cards = entries.filter((e) => e.queue?.state === "running" && !e.queue.held && !e.queue.independent);
  if (!cards.length) return new Map();
  const trains = JSON.parse(store.get("merges:trains") || "{}");
  const steps = await advanceTrains(cards, trains, opts);
  store.set("merges:trains", JSON.stringify(trains));
  return steps;
}

/** A step from advanceCards: the step, or its queue's own error thrown, as advance would have. */
export function unwrap(step) {
  if (step.error) throw step.error;
  return step;
}

/**
 * The merge queue's branch writes over the runner's `write(repo, path, fields, method)`: a merged head's branch deleted, and a
 * merge train's branches made and merged into (TRAIN_BRANCH only). mergeInto answers the new tip, or undefined on a conflict.
 */
export const branchWrites = (write) => ({
  async deleteBranch(repo, branch) {
    await write(repo, `repos/${repo}/git/refs/heads/${branch}`, {}, "DELETE");
  },
  async createRef(repo, branch, sha) {
    if (!TRAIN_BRANCH.test(branch)) throw new Error(`not a merge train branch: ${branch}`);
    await write(repo, `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }, "POST");
  },
  async mergeInto(repo, branch, head, message) {
    if (!TRAIN_BRANCH.test(branch)) throw new Error(`not a merge train branch: ${branch}`);
    try {
      return (await write(repo, `repos/${repo}/merges`, { base: branch, head, commit_message: message }, "POST")).sha;
    } catch (err) {
      if (/HTTP 409|Merge conflict/i.test(githubSays(err))) return undefined;
      throw err;
    }
  },
});

/**
 * What to do with one PR of an independent queue (Tier 0 in the agents org, owner 2026-11-12), from GitHub's view of it and
 * the queue's entry `p` ({ head, updatedHead, readied }): { do: "merge" | "ready" | "update" | "rebind" | "wait" | "skip" | "fail", why, limit? }.
 * Only the PR itself counts: its named checks green on the bound head and GitHub able to merge it. No base-branch check.
 */
export function eachDecision(pr, p) {
  if (pr.state === "MERGED") return { do: "skip", why: "already merged" };
  if (pr.state === "CLOSED") return { do: "fail", why: "closed" };
  if (pr.headRefOid !== p.head) {
    // After an update, the new head goes back through tiering (a head the runner didn't push is the reviewer's): a commit
    // GitHub signed could also be a conflict resolved in its web editor, so its parents alone don't prove its content.
    if (p.updatedHead === p.head) return { do: "retier" };
    // A new push re-requests the merge with its head; anything else times out.
    return { do: "wait", why: "its head moved since the merge was requested" };
  }
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => r.state);
  if (pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED")) return { do: "fail", why: "changes requested" };
  if (pr.isDraft) return p.readied ? { do: "fail", why: "still a draft after I marked it ready" } : { do: "ready" };
  // A conflict (CI often doesn't even run then), or behind under an up-to-date rule: updated once, then its checks again.
  if (pr.mergeStateStatus === "DIRTY") {
    if (p.updatedHead === pr.headRefOid) return { do: "wait", why: `being updated with \`${pr.baseRefName}\`` };
    return p.updatedHead ? { do: "fail", why: `conflicts with \`${pr.baseRefName}\`` } : { do: "update" };
  }
  if (pr.mergeStateStatus === "BEHIND") return p.updatedHead === pr.headRefOid ? { do: "wait", why: `being updated with \`${pr.baseRefName}\`` } : { do: "update" };
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  // Fail closed: checks past the first page are unseen.
  if (rollup?.contexts?.pageInfo?.hasNextPage) return { do: "fail", why: "more than 100 checks on its head" };
  const named = namedChecks(rollup);
  if (!named.length) return { do: "wait", why: "no checks on its head yet", limit: 10 };
  const red = named.filter((c) => !c.ok && !c.pending);
  // Check names and descriptions are set by whoever can push to the repo: never in the runner's own words (count only).
  if (red.length) return { do: "fail", why: `${red.length} named check(s) failed on its head (\`gh pr checks ${pr.number}\` names them)`, red: true };
  if (named.some((c) => c.pending)) return { do: "wait", why: `checks are running${runningChecks(rollup)}`, key: "checks" };
  if (skippedImageScan(pr)) return { do: "fail", why: "it changes an image but its image-scan check was skipped" };
  const ci = ciState(rollup);
  if (ci === "red") return { do: "fail", why: "GitHub reports failing checks", red: true };
  if (ci !== "green") return { do: "wait", why: `checks are running${runningChecks(rollup)}`, key: "checks" };
  // A UI PR merges at Tier 0 only once the UI Reviewer's design review passed on this head: `p.ui` when tiering decided it,
  // else the PR's own files here, so a queue without the flag can't skip the gate. Missing counts as pending (the reviewer
  // is woken for it); still none 2 hours after the checks went green: the reviewer is asked once more, and after that the
  // PR is parked with a note (`again`), never a silent merge, never the owner's card (owner, 2026-11-14) and never an
  // endless wait.
  if (p.ui ?? prTouchesUi(pr)) {
    const dr = designReview(rollup);
    if (dr.state === "failure") return { do: "fail", why: "the UI Reviewer's design review failed on its head (its findings are on the PR and its review task)" };
    if (dr.state !== "success") return { do: "wait", why: "waiting for the UI Reviewer's design review", limit: DESIGN_REVIEW.minutes, again: true };
  }
  if (pr.mergeStateStatus === "BLOCKED") return { do: "fail", why: "GitHub won't merge it (blocked by a branch rule)" };
  // UNSTABLE: some context isn't green. Fine only when every such context is advisory (design-review).
  if (pr.mergeStateStatus === "UNSTABLE") return required(rollup) !== rollup ? { do: "merge" } : { do: "fail", why: "GitHub reports a check that isn't green" };
  if (["CLEAN", "HAS_HOOKS"].includes(pr.mergeStateStatus)) return { do: "merge" };
  return { do: "wait", why: "GitHub is still checking whether it can merge" };
}

/** GitHub's last words on a refused write. */
const githubSays = (err) => String(err.stderr || err.message || err).trim().split("\n").pop().slice(0, 300);

/**
 * One poll of an independent queue: every pending PR on its own, merged as soon as eachDecision says so. A PR that can't
 * merge is reported once and left; the rest go on. Comments for the poll come back as one `say` line each.
 */
async function advanceEach(queue, { github, now, timeoutMinutes }) {
  const say = [];
  const retier = [];
  const wake = [];
  const turned = []; // PRs the queue refused: the caller wakes the Engineer with the reason (those in `fixes` get their own wake)
  const fixes = []; // PRs not merged because their checks failed on this head: the caller wakes the task's Engineer
  const t = now.getTime();
  for (const p of queue.prs.filter((x) => x.status === "pending")) {
    const fail = (why) => {
      Object.assign(p, { status: "failed", note: why });
      delete p.wait;
      say.push(`**Not merged:** ${p.url}: ${why}.`);
      turned.push({ repo: p.repo, number: p.number, url: p.url, head: p.head, key: "queue" });
    };
    // again: past the limit the design reviewer is asked once more for the same head (the caller files its task again), and
    // the wait starts over; past it a second time the PR is parked (not merged, with a note to ask again).
    const wait = (key, why, limit = timeoutMinutes, again = false) => {
      if (p.wait?.key !== key) p.wait = { key, since: now.toISOString() };
      if (t - Date.parse(p.wait.since) <= limit * 60_000) return;
      if (!again) return fail(`stuck for ${limit} minutes: ${why}`);
      if (p.reviewAskedAgain === p.head) return fail(`parked: no design review on its head after asking the UI Reviewer twice (${(2 * limit) / 60} hours). Ask for the merge again once it has reviewed it`);
      p.reviewAskedAgain = p.head;
      p.wait = { key, since: now.toISOString() };
      wake.push({ repo: p.repo, number: p.number, url: p.url, head: p.head, again: true });
    };
    try {
      const data = await github.pr(p.repo, p.number);
      let pr = data?.repository?.pullRequest;
      if (!pr) {
        fail("not found on GitHub");
        continue;
      }
      const defaultBranch = data.repository.defaultBranchRef?.name;
      if (pr.state === "OPEN" && pr.headRefOid === p.head) {
        const base = await settleBase(github, p.repo, pr, defaultBranch);
        if (base.fail) {
          fail(base.fail);
          continue;
        }
        if (base === "retarget") {
          // Its diff against the default branch is new: out of this queue and back to the caller to be tiered again.
          await github.retarget(p.repo, p.number, defaultBranch);
          queue.prs.splice(queue.prs.indexOf(p), 1);
          retier.push({ repo: p.repo, number: p.number, url: p.url });
          continue;
        }
        if (base !== "ok") {
          wait(`${pr.headRefOid}:${base.wait}`, base.wait);
          continue;
        }
      }
      let d = eachDecision(pr, p);
      if (d.do === "rebind") {
        p.head = pr.headRefOid; // GitHub's update of the bound head: its checks have to pass on it now
        d = eachDecision(pr, p);
      }
      // The design reviewer is asked once per head, as soon as a UI head has no verdict: its review needs no green checks (it
      // looks at its own screenshots), so it runs beside CI rather than after it (the caller files its task and wakes it).
      const verdict = designReview(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup).state;
      if (["wait", "update"].includes(d.do) && !pr.isDraft && pr.headRefOid === p.head && p.reviewAsked !== pr.headRefOid && (p.ui ?? prTouchesUi(pr)) && verdict !== "success" && verdict !== "failure") {
        p.reviewAsked = pr.headRefOid;
        wake.push({ repo: p.repo, number: p.number, url: p.url, head: pr.headRefOid });
      }
      if (d.do === "retier") {
        // Not the runner's head nor GitHub's update of it: out of this queue, back to the caller to be tiered again.
        queue.prs.splice(queue.prs.indexOf(p), 1);
        retier.push({ repo: p.repo, number: p.number, url: p.url });
      } else if (d.do === "skip") Object.assign(p, { status: "skipped", note: d.why });
      else if (d.do === "fail") {
        // A check that never started is the environment's: re-run it at this head once, then report GitHub's annotation instead
        // of a check failure, with nothing for the Engineer to change (no fix wake, no rebase, no new head).
        const env = d.red ? await environmentRetry(github, p.repo, p.number, pr, p.url) : undefined;
        if (env?.stop) {
          Object.assign(p, { status: "failed", note: `blocked by the environment: ${env.names.join(", ")} never started` });
          delete p.wait;
          say.push(env.stop);
        } else if (env) {
          wait(`${pr.headRefOid}:infra`, "a check that never started is being re-run once at the same head", env.wait);
        } else {
          const retry = d.red ? await retryInfra(github, p.repo, p.number, pr) : undefined;
          if (retry) wait(`${pr.headRefOid}:${retry.key}`, RERUN_WAIT[retry.key], retry.limit);
          else {
            fail(d.why);
            // `environment`: the red check runs (ids) the breaker leaves out (environmentalChecks).
            if (d.red) fixes.push({ repo: p.repo, number: p.number, url: p.url, head: pr.headRefOid, why: d.why, environment: await environmentalChecks(github, p.repo, p.number, pr) });
          }
        }
      } else if (d.do === "wait") {
        const ghost = d.key === "checks" ? await ghostRetry(github, p.repo, p.number, pr, t) : undefined;
        if (ghost) wait(`${pr.headRefOid}:ghost`, RERUN_WAIT.ghost, ghost.limit);
        else wait(`${pr.headRefOid}:${d.key ?? d.why}`, d.why, d.limit, d.again);
      }
      else if (d.do === "ready") {
        await github.markReady(pr.id, p.repo);
        p.readied = true;
      } else if (d.do === "update") {
        try {
          await github.updateBranch(p.repo, p.number, pr.headRefOid);
          p.updatedHead = pr.headRefOid;
        } catch (err) {
          fail(`conflicts with \`${pr.baseRefName}\` that an update can't resolve (${githubSays(err)})`);
        }
      } else {
        const method = mergeMethod(data.repository);
        if (!method) {
          fail(`\`${p.repo}\` allows no merge method I can use`);
          continue;
        }
        // A PR that changes the AI reviewer's own code merges only on a 100% reviewer-eval receipt for this head (evalgate.ts).
        const gate = await github.evalGate(p.repo, pr);
        if (gate?.stop) {
          fail(gate.stop);
          turned.at(-1).key = "eval";
          continue;
        }
        if (gate?.wait) {
          wait(`${pr.headRefOid}:eval`, gate.wait, EVAL_WAIT_MINUTES);
          continue;
        }
        try {
          p.sha = await github.merge(p.repo, p.number, { sha: pr.headRefOid, method });
        } catch (err) {
          // Another merge to the same base a moment ago: GitHub asks to try again, which the next poll does.
          if (/try the merge again|base branch was modified/i.test(githubSays(err))) wait(`${pr.headRefOid}:retry`, "GitHub asked to try the merge again");
          else fail(`GitHub refused the merge: ${githubSays(err)}`);
          continue;
        }
        Object.assign(p, { status: "merged", mergedAt: now.toISOString(), base: pr.baseRefName, method });
        await deleteHead(github, p.repo, pr, defaultBranch);
        delete p.wait;
        say.push(`Merged ${p.url}.`);
      }
    } catch (err) {
      // GitHub on a bad minute: this PR tries again next poll, for up to half an hour.
      wait("error", `GitHub kept failing: ${githubSays(err)}`, 30);
    }
  }
  const out = say.length ? [say.join("\n")] : [];
  if (queue.prs.some((x) => x.status === "pending")) return { queue, say: out, retier, wake, fixes, turned };
  const merged = queue.prs.filter((x) => x.status === "merged").length;
  const failed = queue.prs.filter((x) => x.status === "failed" || x.status === "escalated").length;
  Object.assign(queue, { state: failed ? "stopped" : "done", finishedAt: now.toISOString(), ...(failed ? { reason: `${failed} not merged` } : {}) });
  const headline = failed ? `**Merges finished:** ${merged} merged, ${failed} not.` : `**Done:** ${merged} merged, ${minutes(t - Date.parse(queue.startedAt))} minutes in all.`;
  return { queue, say: [...out, summary(queue, headline)], done: queue.state, retier, wake, fixes, turned };
}

/** The table of the queue's PRs. */
export function summary(queue, headline) {
  const STATUS = { merged: "✅ merged", skipped: "↷ skipped", pending: "waiting", failed: "✗ not merged", escalated: "→ the owner's card", retiered: "↻ asked again" };
  const rows = queue.prs.map((p) => `| ${p.url} | ${STATUS[p.status] ?? p.status}${p.mergedAt ? ` at ${clock(p.mergedAt)}` : ""}${p.note ? ` (${p.note})` : ""} |`);
  // A running queue names what it is waiting on, so a stall is diagnosable without opening GitHub.
  const waiting = queue.state === "running" && queue.waiting ? [`Waiting on: ${queue.waiting}.`, ""] : [];
  return [headline, "", ...waiting, "| PR | |", "|---|---|", ...rows].join("\n");
}

function stoppedComment(queue) {
  const next = queue.prs.find((p) => p.status === "pending");
  // A receipt that lists checks (checksReceipt) is several lines: the full stop closes the stop's own sentence, which
  // stays one line, and the carry-on sentence follows the list as a paragraph of its own.
  const reason = String(queue.reason ?? "");
  const head = reason.split("\n")[0];
  const listed = reason.length > head.length;
  return summary(
    queue,
    `**Stopped the merges:** ${head}.${reason.slice(head.length)}${next ? `${listed ? "\n\n" : " "}Once it's sorted, tell me to carry on and I'll continue from #${next.number}.` : ""}`,
  );
}

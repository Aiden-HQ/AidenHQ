// The product repo's open PRs, read by the runner every few minutes in one query (owner, 2026-11-13): a new Dependabot PR
// becomes the Platform Engineer's task once its checks have finished, and an agent's open PR that conflicts with the
// default branch (or went red while behind it) wakes its task once per default-branch commit. Pure: the runner does the I/O.
// None of this writes to GitHub or decides a tier: it only wakes the Platform Engineer, whose writes are carded as always.
import { ciState, namedChecks } from "./merges.mjs";

const ROLLUP = "statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } }";
export const OPEN_PRS_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name target { oid ... on Commit { ${ROLLUP} } } }
    pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number url isDraft mergeable isCrossRepository headRefName headRefOid author { __typename login } commits(last: 1) { nodes { commit { ${ROLLUP} } } } }
    }
  }
}`;

const rollupOf = (pr) => pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;

/** Opened by Dependabot from a branch of the repo (GraphQL says `dependabot`, the CLI `app/dependabot`, REST `dependabot[bot]`). */
export const isDependabot = (pr) => pr.author?.__typename === "Bot" && /^(app\/)?dependabot(\[bot\])?$/.test(pr.author?.login ?? "") && pr.isCrossRepository === false;

/** A Dependabot PR whose named checks have all finished (none still running): its task is due now, not on arrival. */
export function dependabotDue(pr) {
  if (!isDependabot(pr)) return false;
  const checks = namedChecks(rollupOf(pr));
  return checks.length > 0 && !checks.some((c) => c.pending);
}

/**
 * Why an agent's open PR wants a rebase onto the default branch: "conflict" (GitHub says CONFLICTING), "red" (a named
 * check failed on its head while the default branch is green: perhaps only because the base moved; the caller also checks
 * that the PR is behind), or undefined. GitHub still computing mergeability (UNKNOWN) is undefined: the next read decides.
 */
export function rebaseReason(pr, mainRollup) {
  if (pr.mergeable === "CONFLICTING") return "conflict";
  if (pr.mergeable !== "MERGEABLE") return undefined;
  const red = namedChecks(rollupOf(pr)).filter((c) => !c.ok && !c.pending);
  return red.length && ciState(mainRollup) === "green" ? "red" : undefined;
}

/** The failed checks' names on a PR's head, for the wake-up text. */
export const redChecks = (pr) => namedChecks(rollupOf(pr)).filter((c) => !c.ok && !c.pending).map((c) => c.name);

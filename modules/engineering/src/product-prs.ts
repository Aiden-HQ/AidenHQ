// The product repo's open PRs, read by the runner every few minutes in one query (owner, 2026-11-13): a new Dependabot PR
// becomes the Platform Engineer's task once its checks have finished, and an agent's open PR that conflicts with the
// default branch (or went red while behind it) wakes its task once per default-branch commit. Pure: the runner does the I/O.
// None of this writes to GitHub or decides a tier: it only wakes the Platform Engineer, whose writes are carded as always.
import { GATE_CHECK, ciState, namedChecks } from "../../codehost-github/src/merge-gate.mjs";

const ROLLUP = "statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { name status conclusion databaseId checkSuite { workflowRun { databaseId } } } ... on StatusContext { context state } } } }";
export const OPEN_PRS_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name target { oid ... on Commit { ${ROLLUP} } } }
    pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number url isDraft mergeable isCrossRepository headRefName headRefOid author { __typename login } commits(last: 1) { nodes { commit { ${ROLLUP} } } } }
    }
  }
}`;

/** A PR (or the default branch rollup) as GitHub GraphQL returns it; read loosely. */
const rollupOf = (pr: any) => pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;

/** Opened by Dependabot from a branch of the repo (GraphQL says `dependabot`, the CLI `app/dependabot`, REST `dependabot[bot]`). */
export const isDependabot = (pr: any) => pr.author?.__typename === "Bot" && /^(app\/)?dependabot(\[bot\])?$/.test(pr.author?.login ?? "") && pr.isCrossRepository === false;

/** A Dependabot PR whose named checks have all finished (none still running): its task is due now, not on arrival. */
export function dependabotDue(pr: any) {
  if (!isDependabot(pr)) return false;
  const checks = namedChecks(rollupOf(pr));
  return checks.length > 0 && !checks.some((c: any) => c.pending);
}

/**
 * Why an agent's open PR wants a rebase onto the default branch: "conflict" (GitHub says CONFLICTING), "red" (a named
 * check failed on its head while the default branch is green: perhaps only because the base moved; the caller also checks
 * that the PR is behind), or undefined. GitHub still computing mergeability (UNKNOWN) is undefined: the next read decides.
 */
export function rebaseReason(pr: any, mainRollup: any) {
  if (pr.mergeable === "CONFLICTING") return "conflict";
  if (pr.mergeable !== "MERGEABLE") return undefined;
  const red = namedChecks(rollupOf(pr)).filter((c: any) => !c.ok && !c.pending);
  return red.length && ciState(mainRollup) === "green" ? "red" : undefined;
}

/** The failed checks' names on a PR's head, for the wake-up text. */
export const redChecks = (pr: any) => namedChecks(rollupOf(pr)).filter((c: any) => !c.ok && !c.pending).map((c: any) => c.name);

/**
 * What an agent's open PR asks of the runner, from GitHub's view of it and `environment` (the red checks that never started, as
 * merges.environmentFailure reads them): { do: "environment", checks } — re-run those at this same head, then report GitHub's
 * annotation, never a rebase; { do: "rebase", why: "conflict" | "red" }; or undefined. It is the environment's only when every
 * red check is one that never started: one real failure beside them is the commit's, and asks for a rebase as before.
 */
export function prAttention(pr: any, mainRollup: any, environment: { name: string }[] = []) {
  const why = rebaseReason(pr, mainRollup);
  if (why === "conflict") return { do: "rebase", why };
  const names = new Set(environment.map((c: any) => c.name));
  const red = redChecks(pr).filter((name: string) => name !== GATE_CHECK);
  if (red.length && names.size && red.every((name: string) => names.has(name))) return { do: "environment", checks: environment };
  return why ? { do: "rebase", why } : undefined;
}

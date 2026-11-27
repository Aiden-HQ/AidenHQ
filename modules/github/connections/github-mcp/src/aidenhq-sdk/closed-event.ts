// How GitHub records what closed an issue: the newest ClosedEvent's actor and `closer` (the merged pull request whose closing
// keyword did it, or a commit) and the newest ReopenedEvent's time (a close after it is the current one). One selection, for github-mcp's github_issue_read.
//
// First-party modules hold byte-identical copies (scripts/sync-shared.ts: edit this one and run it).

export const CLOSED_EVENT_SELECTION = `reopenedEvents: timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } } closedEvents: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { __typename login } closer { __typename ... on PullRequest { number url state mergedAt mergeCommit { oid } repository { nameWithOwner } } ... on Commit { oid url } } } } }`;

type Closer = { __typename?: string; number?: number; url?: string; state?: string; mergedAt?: string | null; mergeCommit?: { oid?: string } | null; repository?: { nameWithOwner?: string }; oid?: string };

/** The latest close's actor and its closer, as a tool shows them; undefined for an issue no close event is known for. */
export function closedBy(node: { closedEvents?: { nodes?: { actor?: { login?: string } | null; closer?: Closer | null }[] } } | null | undefined) {
  const e = node?.closedEvents?.nodes?.[0];
  if (!e) return undefined;
  const c = e.closer;
  return {
    actor: e.actor?.login,
    ...(c?.__typename === "PullRequest" ? { pull_request: { repo: c.repository?.nameWithOwner, number: c.number, merged: c.state === "MERGED", merge_commit_sha: c.mergeCommit?.oid } } : {}),
    ...(c?.__typename === "Commit" ? { commit: c.oid } : {}),
  };
}

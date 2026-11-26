// What members have asked of an adopted PR that nobody has answered yet (owner, 2026-11-26: "ship should fix all comments from
// members, not just our reviews"): ship's round fixes them like open findings. One GraphQL read per decision, for one PR.
//   - A review thread is open when it is unresolved, its first comment is a member's (nits and code review's own account included),
//     and it is not answered: the thread has a reply and the last one is AidenHQ-signed (the fixer's `fixed in <sha>` or `declined`).
//   - A conversation comment is open when a member (not the PR's author, not a bot, not a slash command, not AidenHQ-signed) wrote it
//     after the hand-off and no AidenHQ-signed comment (other than ship's report) came after it.
// A member is flow.ts isMember (GitHub's identity: the owner, an OWNER, MEMBER or COLLABORATOR association, or write permission).
// The AidenHQ footer is only how our own text is recognised (an answer), never what makes a comment trusted.

import { hasFooter } from "./aidenhq-sdk/attribution.ts";

export const MEMBER_COMMENTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      author { login }
      reviewThreads(last: 100) { nodes { id isResolved path line comments(first: 1) { nodes { author { __typename login } authorAssociation } } last: comments(last: 1) { totalCount nodes { fullDatabaseId body } } } }
      comments(last: 50) { nodes { fullDatabaseId createdAt body author { __typename login } authorAssociation } }
    }
  }
}`;

/** One open item: a thread (`thread:<id>:<last comment>`) or a conversation comment (`comment:<id>`). The id changes with a new reply. */
export type OpenItem = { id: string; kind: "thread" | "comment"; author: string; path?: string; line?: number };

type Json = any;
/** Ship's report comment: signed like any AidenHQ text, but posted at hand-off, so it answers nothing. */
const REPORT_MARK = "<!-- aidenhq-ship -->";

/** The open items in `pr` (MEMBER_COMMENTS_QUERY's pullRequest), after `since` (the hand-off's ISO time) for conversation comments. */
export async function openMemberComments(pr: Json, o: { since: string; isMember: (login: string, association: string) => Promise<boolean> }): Promise<OpenItem[]> {
  const items: OpenItem[] = [];
  for (const t of pr?.reviewThreads?.nodes ?? []) {
    const first = t.comments?.nodes?.[0], last = t.last?.nodes?.[0];
    if (t.isResolved || !first || !last || first.author?.__typename !== "User" || !first.author.login) continue;
    // Answered: a reply (not the opening comment itself, which code review signs too) is the last word and it is ours.
    if (Number(t.last?.totalCount) > 1 && hasFooter(String(last.body ?? ""))) continue;
    if (!(await o.isMember(first.author.login, String(first.authorAssociation ?? "")))) continue;
    items.push({ id: `thread:${t.id}:${last.fullDatabaseId}`, kind: "thread", author: first.author.login, ...(t.path ? { path: String(t.path) } : {}), ...(t.line ? { line: Number(t.line) } : {}) });
  }
  const comments = (pr?.comments?.nodes ?? []) as Json[];
  const signed = comments.filter((c) => hasFooter(String(c.body ?? "")) && !String(c.body ?? "").includes(REPORT_MARK)).map((c) => String(c.createdAt));
  for (const c of comments) {
    const who = c.author?.login ? String(c.author.login) : "";
    const body = String(c.body ?? "");
    if (!who || c.author.__typename !== "User" || who === pr?.author?.login || String(c.createdAt) <= o.since) continue;
    if (body.trimStart().startsWith("/") || hasFooter(body) || body.includes(REPORT_MARK)) continue;
    if (signed.some((at) => at > String(c.createdAt))) continue;
    if (!(await o.isMember(who, String(c.authorAssociation ?? "")))) continue;
    items.push({ id: `comment:${c.fullDatabaseId}`, kind: "comment", author: who });
  }
  return items;
}

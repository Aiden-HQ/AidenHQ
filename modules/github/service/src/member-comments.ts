// What members have asked of an adopted PR that nobody has answered yet (owner, 2026-11-26: "ship should fix all comments from
// members, not just our reviews"): ship's round fixes them like open findings. One PR's comments are read per decision.
//   - A review thread is open when it is unresolved, its first comment is a member's (nits and code review's own account included),
//     and it is not answered: the thread has a reply and the last one is a member's AidenHQ-signed one (the fixer's `fixed in <sha>`
//     or `declined`).
//   - A conversation comment is open when a member (not the PR's author where ship says so, not a bot, not a slash command, not
//     AidenHQ-signed) wrote it after the hand-off and no member's AidenHQ-signed comment (other than ship's report) that cites its id came after it.
// A member is flow.ts isMember (GitHub's identity: the owner, an OWNER, MEMBER or COLLABORATOR association, or write permission).
// The AidenHQ footer is only how our own text is recognised (an answer), and only a member's counts, never what makes a comment trusted.

import { hasFooter } from "./aidenhq-sdk/attribution.ts";

const WHO = "author { __typename login } authorAssociation";
export const MEMBER_COMMENTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $beforeThreads: String, $beforeComments: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(last: 100, before: $beforeThreads) { pageInfo { hasPreviousPage startCursor } nodes { id isResolved path line comments(first: 1) { nodes { ${WHO} } } last: comments(last: 1) { totalCount nodes { fullDatabaseId body ${WHO} } } } }
      comments(last: 50, before: $beforeComments) { pageInfo { hasPreviousPage startCursor } nodes { fullDatabaseId createdAt body ${WHO} } }
    }
  }
}`;

/** One open item: a thread (`thread:<id>:<last comment>`) or a conversation comment (`comment:<id>`). The id changes with a new reply. */
export type OpenItem = { id: string; kind: "thread" | "comment"; author: string; path?: string; line?: number };

type Json = any;
/** Ship's report comment: signed like any AidenHQ text, but posted at hand-off, so it answers nothing. */
const REPORT_MARK = "<!-- aidenhq-ship -->";
const MAX_PAGES = 10;

/**
 * Every review thread and every conversation comment back to `since`, newest pages first (a read that can't reach them all throws:
 * a PR is never judged clear on part of its comments). `page(beforeThreads, beforeComments)` is MEMBER_COMMENTS_QUERY's pullRequest.
 */
export async function readMemberComments(page: (beforeThreads: string | null, beforeComments: string | null) => Promise<Json>, since: string): Promise<Json> {
  const first = await page(null, null);
  const threads: Json[] = [...(first.reviewThreads?.nodes ?? [])], comments: Json[] = [...(first.comments?.nodes ?? [])];
  let t = first.reviewThreads?.pageInfo, c = first.comments?.pageInfo;
  for (let i = 0; i < MAX_PAGES && ((t?.hasPreviousPage && t.startCursor) || (c?.hasPreviousPage && c.startCursor && String(comments[0]?.createdAt) > since)); i++) {
    const more = await page(t?.hasPreviousPage ? t.startCursor : null, c?.hasPreviousPage && String(comments[0]?.createdAt) > since ? c.startCursor : null);
    if (t?.hasPreviousPage) { threads.unshift(...(more.reviewThreads?.nodes ?? [])); t = more.reviewThreads?.pageInfo; }
    if (c?.hasPreviousPage && String(comments[0]?.createdAt) > since) { comments.unshift(...(more.comments?.nodes ?? [])); c = more.comments?.pageInfo; }
  }
  if (t?.hasPreviousPage || (c?.hasPreviousPage && String(comments[0]?.createdAt) > since)) throw new Error("the PR has more comments than can be read");
  return { reviewThreads: { nodes: threads }, comments: { nodes: comments } };
}

/** The open items in `pr` (readMemberComments' answer); `author` is the PR author whose own conversation comments ask nothing, if any. */
export async function openMemberComments(pr: Json, o: { since: string; author?: string; isMember: (login: string, association: string) => Promise<boolean> }): Promise<OpenItem[]> {
  const member = (a: Json, assoc: unknown) => a?.__typename === "User" && !!a.login && o.isMember(String(a.login), String(assoc ?? ""));
  const items: OpenItem[] = [];
  for (const t of pr?.reviewThreads?.nodes ?? []) {
    const first = t.comments?.nodes?.[0], last = t.last?.nodes?.[0];
    if (t.isResolved || !first || !last) continue;
    // Answered: a reply (not the opening comment itself, which code review signs too) is the last word, and it is a member's and ours.
    if (Number(t.last?.totalCount) > 1 && hasFooter(String(last.body ?? "")) && (await member(last.author, last.authorAssociation))) continue;
    if (!(await member(first.author, first.authorAssociation))) continue;
    items.push({ id: `thread:${t.id}:${last.fullDatabaseId}`, kind: "thread", author: String(first.author.login), ...(t.path ? { path: String(t.path) } : {}), ...(t.line ? { line: Number(t.line) } : {}) });
  }
  const comments = (pr?.comments?.nodes ?? []) as Json[];
  // A member's signed comment answers the comments whose ids it cites (one reply may answer a batch), never the ones it doesn't.
  const answers: { at: string; body: string }[] = [];
  for (const c of comments) if (hasFooter(String(c.body ?? "")) && !String(c.body ?? "").includes(REPORT_MARK) && (await member(c.author, c.authorAssociation))) answers.push({ at: String(c.createdAt), body: String(c.body) });
  for (const c of comments) {
    const body = String(c.body ?? "");
    if (String(c.createdAt) <= o.since || c.author?.login === o.author) continue;
    if (body.trimStart().startsWith("/") || hasFooter(body) || body.includes(REPORT_MARK)) continue;
    if (answers.some((a) => a.at > String(c.createdAt) && new RegExp(`(^|\\D)${c.fullDatabaseId}:`).test(a.body))) continue;
    if (!(await member(c.author, c.authorAssociation))) continue;
    items.push({ id: `comment:${c.fullDatabaseId}`, kind: "comment", author: String(c.author.login) });
  }
  return items;
}

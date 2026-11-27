// What members have asked of an adopted PR that nobody has answered yet (owner, 2026-11-26: "ship should fix all comments from
// members, not just our reviews"): ship's round fixes them like open findings. One PR's comments are read per decision.
//   - A review thread is open when it is unresolved, its first comment is a member's (nits and code review's own account included),
//     and it is not answered: the thread has a reply and the last one is a member's AidenHQ-signed one (the fixer's `fixed in <sha>`
//     or `declined`).
//   - A conversation comment is open when a member (not the PR's author where ship says so, not a bot, not a slash command, not
//     AidenHQ-signed) wrote it after the hand-off and no member's AidenHQ-signed comment (other than ship's report) that cites its id came after it.
// A member is flow.ts isMember (GitHub's identity: the owner, an OWNER, MEMBER or COLLABORATOR association, or write permission),
// never one of the repo's automation accounts (ship's `ignore_authors`): their comments neither ask, answer nor reopen anything.
// The AidenHQ footer is only how our own text is recognised (an answer), and only a member's counts, never what makes a comment trusted.

import { hasFooter } from "./aidenhq-sdk/attribution.ts";

const WHO = "author { __typename login } authorAssociation";
export const MEMBER_COMMENTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $beforeThreads: String, $beforeComments: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(last: 100, before: $beforeThreads) { pageInfo { hasPreviousPage startCursor } nodes { id isResolved path line comments(first: 1) { nodes { fullDatabaseId ${WHO} } } last: comments(last: 10) { nodes { fullDatabaseId body ${WHO} } } } }
      comments(last: 50, before: $beforeComments) { pageInfo { hasPreviousPage startCursor } nodes { fullDatabaseId createdAt body ${WHO} } }
    }
  }
}`;

/** What ship asks about (its adoption's `commentsFor`): comments since the hand-off, the PR author whose own comments ask nothing,
 * and the accounts that never ask. */
export type CommentsAsk = { since: string; author?: string; ignore?: string[] };
/** A CommentsAsk from a request body, or undefined (fields of the wrong type are dropped). */
export function commentsAsk(v: unknown): CommentsAsk | undefined {
  const c = (v && typeof v === "object" ? v : {}) as { since?: unknown; author?: unknown; ignore?: unknown };
  if (typeof c.since !== "string") return undefined;
  const ignore = Array.isArray(c.ignore) ? c.ignore.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
  return { since: c.since, ...(typeof c.author === "string" ? { author: c.author } : {}), ...(ignore.length ? { ignore } : {}) };
}

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

/** The open items in `pr` (readMemberComments' answer); `author` is the PR author whose own conversation comments ask nothing, if any,
 * and `ignore` the accounts that are never members here. */
export async function openMemberComments(pr: Json, o: CommentsAsk & { isMember: (login: string, association: string) => Promise<boolean> }): Promise<OpenItem[]> {
  const ignored = new Set((o.ignore ?? []).map((l) => l.toLowerCase()));
  const member = (a: Json, assoc: unknown) => a?.__typename === "User" && !!a.login && !ignored.has(String(a.login).toLowerCase()) && o.isMember(String(a.login), String(assoc ?? ""));
  const items: OpenItem[] = [];
  for (const t of pr?.reviewThreads?.nodes ?? []) {
    const first = t.comments?.nodes?.[0];
    if (t.isResolved || !first) continue;
    // The latest reply a member wrote decides (an outsider's reply neither answers nor reopens a thread). Answered: it is a reply, not
    // the opening comment itself (which code review signs too), and it is ours.
    const replies = [...(t.last?.nodes ?? [])].reverse();
    let latest = first;
    for (const r of replies) if (await member(r.author, r.authorAssociation)) { latest = r; break; }
    if (latest.fullDatabaseId !== first.fullDatabaseId && hasFooter(String(latest.body ?? ""))) continue;
    if (!(await member(first.author, first.authorAssociation))) continue;
    items.push({ id: `thread:${t.id}:${latest.fullDatabaseId}`, kind: "thread", author: String(first.author.login), ...(t.path ? { path: String(t.path) } : {}), ...(t.line ? { line: Number(t.line) } : {}) });
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

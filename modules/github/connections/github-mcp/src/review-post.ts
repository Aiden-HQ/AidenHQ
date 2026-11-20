// Code review's posting (docs/design/code-review.md "Posting"), run for a kernel write record the AI reviewer approved: the
// code-review module's executor calls `preview` (what the card shows) and `execute` (what is posted) through github-mcp's
// /internal/review routes. It posts as the owner (the one sign-in), each text signed with the AidenHQ footer. A review is only
// ever a COMMENT (advice: no approval, no change request), the status is never a failure, and a thread is resolved only when
// Aiden posted it: its first comment is in AidenHQ's records (the kernel's /v1/objects) and carries our finding marker. Every
// request goes through github.ts's `guard`.
import { withFooter } from "./aidenhq-sdk/attribution.js";
import type { GitHubAccess } from "./client.js";
import { GitHub, GitHubRefused, objectRef, type Ref } from "./github.js";
import {
  FINDING_MARK, ACK_MARK, NoticeArgsSchema, PostArgsSchema, RUN_MARK, STATUS_CONTEXT, counts, renderNotice, renderReview, reviewStatus, rightLines,
  type Finding, type NoticeArgs, type PostArgs,
} from "./review-render.js";

/** The card's details are cut at this many characters by the kernel: a review that can't be shown whole is refused. */
const CARD_MAX = 79_000;

/** Who posts: the owner's login (the one sign-in). */
export type Who = { login: string };
/** The name the review's texts are signed with. */
const AGENT = "Aiden";
export interface Thread {
  id: string;
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  /** The finding id Aiden's marker names in the first comment, or null (a person's thread). */
  finding: string | null;
  /** The first comment is in AidenHQ's records and carries a finding marker: Aiden's own thread. */
  ours: boolean;
  author: string;
  url: string;
  /** Replies, oldest first, as data (untrusted text). */
  replies: { author: string; body: string }[];
}
type RawThread = { id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null; comments: { nodes: { databaseId: number; url: string; body: string; author: { login: string } | null }[] } };
type GhPr = { state: string; draft?: boolean; head: { sha: string }; base: { sha: string } };

/** The explicit target must be the review's own: a review of another repo, pull request or commit is refused. */
function target(a: PostArgs): PostArgs {
  const r = a.review;
  if (r.repo.toLowerCase() !== a.repo.toLowerCase() || r.pr !== a.pr || r.head !== a.head) throw new GitHubRefused(`the review is of ${r.repo}#${r.pr} at ${r.head.slice(0, 12)}, not ${a.repo}#${a.pr} at ${a.head.slice(0, 12)}`);
  return a;
}
const norm = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");
const split = (repo: string): Ref => { const [owner, name] = repo.split("/"); return { owner: owner!, repo: name!, number: 0 }; };
const api = (r: Ref) => `/repos/${r.owner}/${r.repo}`;

export class ReviewPoster {
  /** `ours`: whether a GitHub object (`github:<repo>#<n>/comment/<id>`) is in AidenHQ's records. */
  constructor(private readonly gh: GitHub, private readonly access: Pick<GitHubAccess, "identity">, private readonly ours: (ref: string) => Promise<boolean>) {}

  /** Who posts: the owner (a typed need when GitHub isn't connected). */
  async identity(): Promise<Who> {
    return { login: (await this.access.identity()).login };
  }

  /** A pull request's review threads: ours (in our records, first comment has a finding marker) and anyone's, replies included. */
  async threads(ref: Ref): Promise<Thread[]> {
    const out: Thread[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const d: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawThread[] } } | null } | null } = await this.gh.graphql("reviewThreads", { owner: ref.owner, name: ref.repo, number: ref.number, after });
      const t = d.repository?.pullRequest?.reviewThreads;
      if (!t) throw new GitHubRefused(`couldn't read ${ref.owner}/${ref.repo}#${ref.number}'s review threads`);
      for (const n of t.nodes) {
        const [first, ...rest] = n.comments.nodes;
        if (!first) continue;
        const finding = FINDING_MARK.exec(first.body)?.[1] ?? null;
        const author = first.author?.login ?? "";
        out.push({
          id: n.id, resolved: n.isResolved, outdated: n.isOutdated, path: n.path, line: n.line, finding, ours: finding !== null && (await this.ours(`${objectRef(ref)}/comment/${first.databaseId}`)), author, url: first.url,
          replies: rest.map((c) => ({ author: c.author?.login ?? "", body: c.body.slice(0, 800) })),
        });
      }
      if (!t.pageInfo.hasNextPage) break;
      after = t.pageInfo.endCursor;
    }
    return out;
  }

  /** Resolves the listed threads that are Aiden's own and still open; the others are reported, never touched. */
  async resolve(ref: Ref, wanted: { thread_ids?: string[]; finding_ids?: string[] }): Promise<{ resolved: string[]; skipped: { thread: string; why: string }[] }> {
    const all = await this.threads(ref);
    const resolved: string[] = [];
    const skipped: { thread: string; why: string }[] = [];
    const picks = new Map<string, string>();
    for (const id of wanted.thread_ids ?? []) picks.set(id, all.some((t) => t.id === id) ? "" : "no such thread on this pull request");
    for (const f of wanted.finding_ids ?? []) { const t = all.find((x) => x.finding === f && x.ours && !x.resolved) ?? all.find((x) => x.finding === f); if (t) picks.set(t.id, ""); else skipped.push({ thread: f, why: "no thread for that finding" }); }
    for (const [id, missing] of picks) {
      const t = all.find((x) => x.id === id);
      if (!t) skipped.push({ thread: id, why: missing });
      else if (!t.ours) skipped.push({ thread: id, why: "not Aiden's thread (a person's thread, or not in AidenHQ's records)" });
      else if (t.resolved) skipped.push({ thread: id, why: "already resolved" });
      else { await this.gh.graphql("resolveThread", { thread: id }); resolved.push(id); }
    }
    return { resolved, skipped };
  }

  /** Where inline comments may land: each changed file's right-side lines (files without a patch can't take one). */
  private async diffLines(ref: Ref, who: Who): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>();
    for (let page = 1; page <= 30; page++) {
      const files = await this.gh.request<{ filename: string; patch?: string }[]>("GET", `${api(ref)}/pulls/${ref.number}/files`, { query: { per_page: 100, page } });
      for (const f of files) if (f.patch) out.set(f.filename, rightLines(f.patch));
      if (files.length < 100) break;
    }
    return out;
  }

  private async pull(ref: Ref, who: Who): Promise<GhPr> {
    const pr = await this.gh.request<GhPr>("GET", `${api(ref)}/pulls/${ref.number}`, {});
    if (pr.state !== "open") throw new GitHubRefused(`${ref.owner}/${ref.repo}#${ref.number} isn't open`);
    return pr;
  }

  /**
   * The acknowledgement comment, edited in place (found by its marker among the owner's comments AidenHQ's records hold), or
   * made: its link and its ref for the records.
   */
  private async ack(ref: Ref, who: Who, text: string): Promise<{ url: string; object: string }> {
    const signed = withFooter(text, AGENT);
    for (let page = 1; page <= 10; page++) {
      const cs = await this.gh.request<{ id: number; html_url: string; body?: string; user?: { login: string } }[]>("GET", `${api(ref)}/issues/${ref.number}/comments`, { query: { per_page: 100, page } });
      for (const c of cs) {
        if (!c.body?.includes(ACK_MARK) || norm(c.user?.login ?? "") !== norm(who.login) || !(await this.ours(`${objectRef(ref)}/comment/${c.id}`))) continue;
        await this.gh.request("PATCH", `${api(ref)}/issues/comments/${c.id}`, { body: { body: signed } });
        return { url: c.html_url, object: `${objectRef(ref)}/comment/${c.id}` };
      }
      if (cs.length < 100) break;
    }
    const made = await this.gh.request<{ id: number; html_url: string }>("POST", `${api(ref)}/issues/${ref.number}/comments`, { body: { body: signed } });
    return { url: made.html_url, object: `${objectRef(ref)}/comment/${made.id}` };
  }

  private async status(ref: Ref, who: Who, sha: string, s: { state: string; description: string }, url?: string): Promise<void> {
    await this.gh.request("POST", `${api(ref)}/statuses/${sha}`, { body: { state: s.state, context: STATUS_CONTEXT, description: s.description.slice(0, 140), ...(url ? { target_url: url } : {}) } });
  }

  /** What the card shows and the record binds to, from the args alone (no GitHub call: the plan must come out the same each time). */
  preview(kind: "post" | "notice", args: unknown): { facts: Record<string, string>; targets: Record<string, unknown> } {
    if (kind === "notice") {
      const n = NoticeArgsSchema.parse(args);
      const t = renderNotice(n);
      return {
        facts: {
          target: `${n.repo}#${n.pr} @ ${n.head.slice(0, 7)}`,
          sentence: `Update Aiden's review notice on ${n.repo}#${n.pr}: ${n.phase}${n.reason ? ` (${n.reason})` : ""}.`,
          changes: `Edits Aiden's one acknowledgement comment on the pull request${t.status ? ` and sets the commit status ${STATUS_CONTEXT} to ${t.status.state}` : ""}, as the owner, signed by AidenHQ. The words are fixed; no model text.`,
          details: `${t.text}${t.status ? `\n\nStatus ${STATUS_CONTEXT}: ${t.status.state}: ${t.status.description}` : ""}`,
        },
        targets: { [`${n.repo}#${n.pr}`]: { repo: n.repo, ref: `pull/${n.pr}`, commit: n.head, base_sha: null } },
      };
    }
    const a = target(PostArgsSchema.parse(args));
    const r = a.review;
    const { summary, comments } = renderReview(r, a.run);
    const c = counts(r.findings);
    const details = [
      `Review summary (event COMMENT, at commit ${r.head}):`, "", summary, "",
      ...comments.flatMap((m) => [`--- inline comment on ${m.path}:${m.line} ---`, "", m.body, ""]),
      `Commit status ${STATUS_CONTEXT}: ${reviewStatus(r).state}: ${reviewStatus(r).description}`, "",
      `Acknowledgement comment: ${renderNotice({ repo: r.repo, pr: r.pr, head: r.head, phase: "done", reviewer: r.reviewer, ...c, cost_usd: r.cost_usd, run: a.run }).text}`,
      ...(a.resolve.length ? ["", `Resolves Aiden's own threads for findings: ${a.resolve.join(", ")} (only those it posted, and only if no longer reported).`] : []),
    ].join("\n");
    if (details.length > CARD_MAX) throw new GitHubRefused(`the review is ${details.length} characters, too large for the AI reviewer to read whole (${CARD_MAX}); the reviewer must report fewer findings`);
    return {
      facts: {
        target: `${r.repo}#${r.pr} @ ${r.head.slice(0, 7)}`,
        sentence: `Post Aiden's review of ${r.repo}#${r.pr} (reviewer ${r.reviewer}: ${c.important} important, ${c.nit} nit, ${c.pre_existing} pre-existing).`,
        changes: `A GitHub review with ${comments.length} inline comment${comments.length === 1 ? "" : "s"} (as many as land on changed lines; the rest are listed in its summary), the commit status ${STATUS_CONTEXT} and the pull request's acknowledgement comment, as the owner, signed by AidenHQ.${a.resolve.length ? ` It resolves ${a.resolve.length} of its own earlier thread(s).` : ""} Advice only: a comment review, never an approval or a block.`,
        details,
      },
      targets: { [`${r.repo}#${r.pr}`]: { repo: r.repo, ref: `pull/${r.pr}`, commit: r.head, base_sha: r.base } },
    };
  }

  /** Posts what `preview` showed. Throws (a failed outcome) when the pull request isn't open or its head moved. */
  async execute(kind: "post" | "notice", args: unknown): Promise<{ ok: boolean; text: string; objects: string[] }> {
    return kind === "post" ? this.post(target(PostArgsSchema.parse(args))) : this.notice(NoticeArgsSchema.parse(args));
  }

  private async notice(n: NoticeArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const ref = { ...split(n.repo), number: n.pr };
    const who = await this.identity();
    const pr = await this.pull(ref, who);
    const t = renderNotice(n);
    const ack = await this.ack(ref, who, t.text);
    // A status belongs to the head it was asked for: a moved head has its own review coming.
    const statusSet = Boolean(t.status) && pr.head.sha === n.head;
    if (t.status && statusSet) await this.status(ref, who, n.head, t.status);
    return { ok: true, text: JSON.stringify({ identity: "owner", login: who.login, ack: ack.url, status: statusSet ? t.status!.state : null }), objects: [ack.object] };
  }

  private async post(a: PostArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const r = a.review;
    const ref = { ...split(r.repo), number: r.pr };
    const who = await this.identity();
    const pr = await this.pull(ref, who);
    if (pr.head.sha !== r.head) throw new GitHubRefused(`${r.repo}#${r.pr}'s head moved to ${pr.head.sha.slice(0, 12)} since this review of ${r.head.slice(0, 12)}: review the new head`);
    const threads = await this.threads(ref);
    const earlier = new Set(threads.filter((t) => t.ours && t.finding).map((t) => t.finding!));
    const lines = await this.diffLines(ref, who);
    const placeable = (f: Finding) => { const l = lines.get(f.path); const to = f.end_line && f.end_line > f.line ? f.end_line : f.line; if (!l) return false; for (let i = f.line; i <= to; i++) if (!l.has(i)) return false; return true; };
    const inline = new Set(r.findings.filter((f) => placeable(f)).map((f) => f.id));
    const { summary, comments } = renderReview(r, a.run, { inline, earlier });
    // A retry after a crash finds its own review by the run's marker instead of posting a second one.
    let review: { id: number; html_url: string } | undefined;
    for (let page = 1; page <= 10 && !review; page++) {
      const rs = await this.gh.request<{ id: number; html_url: string; body?: string; user?: { login: string } }[]>("GET", `${api(ref)}/pulls/${ref.number}/reviews`, { query: { per_page: 100, page } });
      review = rs.find((x) => x.body?.includes(RUN_MARK(a.run)) && norm(x.user?.login ?? "") === norm(who.login));
      if (rs.length < 100) break;
    }
    review ??= await this.gh.request<{ id: number; html_url: string }>("POST", `${api(ref)}/pulls/${ref.number}/reviews`, {
      body: { event: "COMMENT", commit_id: r.head, body: withFooter(summary, AGENT), ...(comments.length ? { comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", ...(c.start_line ? { start_line: c.start_line } : {}), body: c.body })) } : {}) },
    });
    // Its inline comments, by id, for AidenHQ's records: a later run resolves only threads it finds there.
    const inlineIds = (await this.gh.request<{ id: number }[]>("GET", `${api(ref)}/pulls/${ref.number}/reviews/${review.id}/comments`, { query: { per_page: 100 } })).map((c) => `${objectRef(ref)}/comment/${c.id}`);
    // A missing finding isn't proof of a fix: the state service names the ids its recheck confirmed, and only Aiden's own
    // open threads for findings the review no longer reports are resolved.
    const present = new Set(r.findings.map((f) => f.id));
    const done = await this.resolve(ref, { finding_ids: a.resolve.filter((id) => !present.has(id)) });
    await this.status(ref, who, r.head, reviewStatus(r), review.html_url);
    const c = counts(r.findings);
    const ack = await this.ack(ref, who, `${renderNotice({ repo: r.repo, pr: r.pr, head: r.head, phase: "done", reviewer: r.reviewer, ...c, cost_usd: r.cost_usd, run: a.run }).text}\n[The review](${review.html_url})`);
    return { ok: true, text: JSON.stringify({ identity: "owner", login: who.login, review: review.html_url, inline: comments.length, listed: r.findings.filter((f) => !earlier.has(f.id) && !comments.some((c) => c.id === f.id)).length, earlier: earlier.size, resolved: done.resolved.length, skipped: done.skipped, ack: ack.url, status: STATUS_CONTEXT }), objects: [...inlineIds, ack.object] };
  }
}

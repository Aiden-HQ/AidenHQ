// Code review's posting (docs/design/code-review.md "Posting"), run for a kernel write record the AI reviewer approved: the
// code-review module's executor calls `preview` (what the card shows) and `execute` (what is posted) through github-mcp's
// /internal/review routes. It posts as the owner (the one sign-in), each text signed with the AidenHQ footer. A review is only
// ever a COMMENT (no GitHub approval or change request: on a gated repo the merge queue asks code review's verdict itself); the
// commit status `aidenhq/review` only mirrors that verdict. A thread is Aiden's own when its first comment carries our finding
// marker and is by the posting identity: model text can't write a marker (review-render.ts escapes `<`), and nobody but the
// owner's sign-in posts as it. Every request goes through github.ts's `guard`.
import type { z } from "zod";
import { withFooter } from "./aidenhq-sdk/attribution.js";
import type { GitHubAccess } from "./client.js";
import { GitHub, GitHubRefused, objectRef, type Ref } from "./github.js";
import {
  FINDING_MARK, ACK_MARK, RULING_MARK, comboText, NoticeArgsSchema, PostArgsSchema, RulingArgsSchema, RUN_MARK, STATUS_CONTEXT, StatusArgsSchema, anchors, counts, renderNotice,
  renderReview, renderRuling, renderStatus, rightLines, type NoticeArgs, type PostArgs, type StatusArgs,
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
  /** The first comment's id (a ruling replies to it). */
  comment: number;
  /** The first comment carries a finding marker and is by the posting identity: Aiden's own thread. */
  ours: boolean;
  author: string;
  url: string;
  /** Replies, oldest first, as data (untrusted text); `ruling`: Aiden's own answer to a dispute (its marker, posted as the owner). */
  replies: { id: number; author: string; body: string; ruling: boolean }[];
}
type RawThread = { id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null; comments: { nodes: { databaseId: number; url: string; body: string; author: { login: string } | null }[] } };
type GhPr = { state: string; merged?: boolean; draft?: boolean; head: { sha: string }; base: { sha: string } };
type Kind = "post" | "notice" | "ruling" | "status";

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
  constructor(private readonly gh: GitHub, private readonly access: Pick<GitHubAccess, "identity">) {}

  /** Who posts: the owner (a typed need when GitHub isn't connected). */
  async identity(): Promise<Who> {
    return { login: (await this.access.identity()).login };
  }

  /** A pull request's review threads: ours (the first comment has a finding marker and is the posting identity's) and anyone's, replies included. */
  async threads(ref: Ref): Promise<Thread[]> {
    const me = norm((await this.identity()).login);
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
          id: n.id, comment: first.databaseId, resolved: n.isResolved, outdated: n.isOutdated, path: n.path, line: n.line, finding, ours: finding !== null && norm(author) === me, author, url: first.url,
          replies: rest.map((c) => ({ id: c.databaseId, author: c.author?.login ?? "", body: c.body.slice(0, 2000), ruling: c.body.includes(RULING_MARK) && norm(c.author?.login ?? "") === norm(author) })),
        });
      }
      if (!t.pageInfo.hasNextPage) break;
      after = t.pageInfo.endCursor;
    }
    return out;
  }

  /** Resolves the listed threads that are Aiden's own and still open; the others are reported, never touched. */
  async resolve(ref: Ref, wanted: { thread_ids?: string[]; finding_ids?: string[] }, mine: (t: Thread) => boolean = (t) => t.ours): Promise<{ resolved: string[]; skipped: { thread: string; why: string }[] }> {
    const all = (await this.threads(ref)).map((t) => ({ ...t, ours: mine(t) }));
    const resolved: string[] = [];
    const skipped: { thread: string; why: string }[] = [];
    const picks = new Map<string, string>();
    for (const id of wanted.thread_ids ?? []) picks.set(id, all.some((t) => t.id === id) ? "" : "no such thread on this pull request");
    for (const f of wanted.finding_ids ?? []) { const t = all.find((x) => x.finding === f && x.ours && !x.resolved) ?? all.find((x) => x.finding === f); if (t) picks.set(t.id, ""); else skipped.push({ thread: f, why: "no thread for that finding" }); }
    for (const [id, missing] of picks) {
      const t = all.find((x) => x.id === id);
      if (!t) skipped.push({ thread: id, why: missing });
      else if (!t.ours) skipped.push({ thread: id, why: "not Aiden's thread (a person's)" });
      else if (t.resolved) skipped.push({ thread: id, why: "already resolved" });
      else { await this.gh.graphql("resolveThread", { thread: id }); resolved.push(id); }
    }
    return { resolved, skipped };
  }

  /** Where comments may land on the reviewed commit's diff (its merge base to it, whatever the PR's head is now): each changed
   * file's right-side lines; a file with no patch (binary, too large) has none and takes a file comment. */
  private async diffLines(ref: Ref, base: string, head: string): Promise<Map<string, Set<number>>> {
    const c = await this.gh.request<{ files?: { filename: string; patch?: string }[] }>("GET", `${api(ref)}/compare/${base}...${head}`, { query: { per_page: 1 } });
    return new Map((c.files ?? []).map((f) => [f.filename, f.patch ? rightLines(f.patch) : new Set<number>()]));
  }

  private async pull(ref: Ref, who: Who): Promise<GhPr> {
    const pr = await this.gh.request<GhPr>("GET", `${api(ref)}/pulls/${ref.number}`, {});
    // A merged PR still takes its review (GitHub accepts one); a closed one doesn't.
    if (pr.state !== "open" && !pr.merged) throw new GitHubRefused(`${ref.owner}/${ref.repo}#${ref.number} isn't open or merged`);
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
        if (!c.body?.includes(ACK_MARK) || norm(c.user?.login ?? "") !== norm(who.login)) continue;
        await this.gh.request("PATCH", `${api(ref)}/issues/comments/${c.id}`, { body: { body: signed } });
        return { url: c.html_url, object: `${objectRef(ref)}/comment/${c.id}` };
      }
      if (cs.length < 100) break;
    }
    const made = await this.gh.request<{ id: number; html_url: string }>("POST", `${api(ref)}/issues/${ref.number}/comments`, { body: { body: signed } });
    return { url: made.html_url, object: `${objectRef(ref)}/comment/${made.id}` };
  }

  /** What the card shows and the record binds to, from the args alone (no GitHub call: the plan must come out the same each time). */
  preview(kind: Kind, args: unknown): { facts: Record<string, string>; targets: Record<string, unknown> } {
    if (kind === "status") {
      const a = StatusArgsSchema.parse(args);
      const s = renderStatus(a);
      return {
        facts: {
          target: `${a.repo}#${a.pr} @ ${a.head.slice(0, 7)}`,
          sentence: `Set the commit status ${STATUS_CONTEXT} on ${a.repo}#${a.pr} to ${s.state}.`,
          changes: `One commit status on ${a.head.slice(0, 12)}, as the owner: code review's merge verdict mirrored, in fixed words.`,
          details: `${s.state}: ${s.description}`,
        },
        targets: { [`${a.repo}#${a.pr}`]: { repo: a.repo, ref: `pull/${a.pr}`, commit: a.head, base_sha: null } },
      };
    }
    if (kind === "ruling") {
      const a = RulingArgsSchema.parse(args);
      return {
        facts: {
          target: `${a.repo}#${a.pr} @ ${a.head.slice(0, 7)}`,
          sentence: `Reply on Aiden's finding ${a.finding} on ${a.repo}#${a.pr}: the dispute is ${a.verdict}.`,
          changes: `One reply on the finding's review thread, as the owner, signed by AidenHQ${a.verdict === "dismissed" ? ", and the thread resolved (Aiden's own only)" : ""}. The reason is the judge's text, made plain.`,
          details: renderRuling(a),
        },
        targets: { [`${a.repo}#${a.pr}`]: { repo: a.repo, ref: `pull/${a.pr}`, commit: a.head, base_sha: null } },
      };
    }
    if (kind === "notice") {
      const n = NoticeArgsSchema.parse(args);
      return {
        facts: {
          target: `${n.repo}#${n.pr} @ ${n.head.slice(0, 7)}`,
          sentence: `Update Aiden's review notice on ${n.repo}#${n.pr}: ${n.phase}${n.reason ? ` (${n.reason})` : ""}.`,
          changes: "Edits Aiden's one acknowledgement comment on the pull request, as the owner, signed by AidenHQ. The words are fixed; no model text.",
          details: renderNotice(n),
        },
        targets: { [`${n.repo}#${n.pr}`]: { repo: n.repo, ref: `pull/${n.pr}`, commit: n.head, base_sha: null } },
      };
    }
    const a = target(PostArgsSchema.parse(args));
    const r = a.review;
    const { summary, comments } = renderReview(r, a.run, { gated: a.gated, card: true });
    const c = counts(r.findings);
    const details = [
      // The fixed command words are named, not shown (`card`): `aiden review` lines read like instructions to the reviewer, which
      // then refused whole reviews as prompt injection (2 of 40 posts, 2026-11-21).
      `Review summary (event COMMENT, at commit ${r.head}):`, "", summary, "",
      ...comments.flatMap((m) => [`--- inline comment on ${m.path}:${m.line} ---`, "", m.body, ""]),
      "(A comment whose line isn't on the diff goes on the nearest diff line of its file, or on the file, saying where it is.)", "",
      `Acknowledgement comment: ${renderNotice({ repo: r.repo, pr: r.pr, head: r.head, phase: "done", engine: r.engine, model: r.model, effort: r.effort, ...c, cost_usd: r.cost_usd, run: a.run })}`,
      ...(a.resolve.length ? ["", `Resolves Aiden's own threads for findings: ${a.resolve.join(", ")} (only those it posted, and only if no longer reported).`] : []),
    ].join("\n");
    if (details.length > CARD_MAX) throw new GitHubRefused(`the review is ${details.length} characters, too large for the AI reviewer to read whole (${CARD_MAX}); the reviewer must report fewer findings`);
    return {
      facts: {
        target: `${r.repo}#${r.pr} @ ${r.head.slice(0, 7)}`,
        sentence: `Post Aiden's review of ${r.repo}#${r.pr} (${comboText(r)}: ${c.important} important, ${c.nit} nit, ${c.pre_existing} pre-existing).`,
        changes: `A GitHub review with ${comments.length} inline comment${comments.length === 1 ? "" : "s"} (one thread per finding, on its line, the nearest diff line or its file) and the pull request's acknowledgement comment, as the owner, signed by AidenHQ.${a.resolve.length ? ` It resolves ${a.resolve.length} of its own earlier thread(s).` : ""} A comment review, never a GitHub approval or change request.`,
        details,
      },
      targets: { [`${r.repo}#${r.pr}`]: { repo: r.repo, ref: `pull/${r.pr}`, commit: r.head, base_sha: r.base } },
    };
  }

  /** Posts what `preview` showed. Throws (a failed outcome) when the pull request is closed unmerged. */
  async execute(kind: Kind, args: unknown): Promise<{ ok: boolean; text: string; objects: string[] }> {
    if (kind === "ruling") return this.ruling(RulingArgsSchema.parse(args));
    if (kind === "status") return this.status(StatusArgsSchema.parse(args));
    return kind === "post" ? this.post(target(PostArgsSchema.parse(args))) : this.notice(NoticeArgsSchema.parse(args));
  }

  /** The ruling, once per run (found again by its run id): a reply on the finding's thread; a dismissal resolves the thread. */
  private async ruling(a: z.infer<typeof RulingArgsSchema>): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const ref = { ...split(a.repo), number: a.pr };
    const who = await this.identity();
    const t = (await this.threads(ref)).find((x) => x.comment === a.comment && x.finding === a.finding && x.ours);
    if (!t) throw new GitHubRefused(`no thread of Aiden's for finding ${a.finding} on ${a.repo}#${a.pr}`);
    const body = renderRuling(a);
    const had = t.replies.find((r) => r.ruling && r.body.includes(`run \`${a.run}\``));
    const made = had ? { id: had.id } : await this.gh.request<{ id: number }>("POST", `${api(ref)}/pulls/${a.pr}/comments/${a.comment}/replies`, { body: { body: withFooter(body, AGENT) } });
    if (a.verdict === "dismissed" && !t.resolved) await this.gh.graphql("resolveThread", { thread: t.id });
    return { ok: true, text: JSON.stringify({ identity: "owner", login: who.login, verdict: a.verdict, resolved: a.verdict === "dismissed" }), objects: [`${objectRef(ref)}/comment/${made.id}`] };
  }

  private async notice(n: NoticeArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const ref = { ...split(n.repo), number: n.pr };
    const who = await this.identity();
    await this.pull(ref, who);
    const ack = await this.ack(ref, who, renderNotice(n));
    return { ok: true, text: JSON.stringify({ identity: "owner", login: who.login, ack: ack.url }), objects: [ack.object] };
  }

  /** The commit status `aidenhq/review` on the head: code review's verdict mirrored (the service writes only on a change). */
  private async status(a: StatusArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const ref = { ...split(a.repo), number: a.pr };
    const who = await this.identity();
    const s = renderStatus(a);
    await this.gh.request("POST", `${api(ref)}/statuses/${a.head}`, { body: { state: s.state, context: STATUS_CONTEXT, description: s.description, target_url: `https://github.com/${a.repo}/pull/${a.pr}` } });
    return { ok: true, text: JSON.stringify({ identity: "owner", login: who.login, state: s.state }), objects: [] };
  }

  /**
   * The review of the commit it reviewed, even when the PR has moved on since (its comments then show as outdated where the
   * lines changed). Every finding gets one thread: its lines, the nearest diff line of its file, or a file comment. Once posted,
   * the summary is updated so each finding's row links to its thread. A retry finds what it posted by the run's and the
   * findings' markers, so nothing is posted twice.
   */
  private async post(a: PostArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const r = a.review;
    const ref = { ...split(r.repo), number: r.pr };
    const who = await this.identity();
    const pr = await this.pull(ref, who);
    const threads = await this.threads(ref);
    const earlier = new Map(threads.filter((t) => t.ours && t.finding).map((t) => [t.finding!, t.url]));
    const place = anchors(r.findings, await this.diffLines(ref, r.base, r.head));
    const first = renderReview(r, a.run, { place, earlier, gated: a.gated });
    let review: { id: number; html_url: string } | undefined;
    for (let page = 1; page <= 10 && !review; page++) {
      const rs = await this.gh.request<{ id: number; html_url: string; body?: string; user?: { login: string } }[]>("GET", `${api(ref)}/pulls/${ref.number}/reviews`, { query: { per_page: 100, page } });
      review = rs.find((x) => x.body?.includes(RUN_MARK(a.run)) && norm(x.user?.login ?? "") === norm(who.login));
      if (rs.length < 100) break;
    }
    const onLines = first.comments.filter((c) => !c.file);
    review ??= await this.gh.request<{ id: number; html_url: string }>("POST", `${api(ref)}/pulls/${ref.number}/reviews`, {
      body: { event: "COMMENT", commit_id: r.head, body: withFooter(first.summary, AGENT), ...(onLines.length ? { comments: onLines.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", ...(c.start_line ? { start_line: c.start_line } : {}), body: c.body })) } : {}) },
    });
    // Its inline comments (each thread's first comment) by finding, for the links and AidenHQ's records.
    const mine = await this.gh.request<{ id: number; html_url: string; body?: string }[]>("GET", `${api(ref)}/pulls/${ref.number}/reviews/${review.id}/comments`, { query: { per_page: 100 } });
    const made = mine.map((c) => ({ id: c.id, url: c.html_url, finding: FINDING_MARK.exec(c.body ?? "")?.[1] }));
    // A finding on a file without diff lines takes a file comment (its own thread, outside the review).
    for (const c of first.comments.filter((x) => x.file)) {
      const f = await this.gh.request<{ id: number; html_url: string }>("POST", `${api(ref)}/pulls/${ref.number}/comments`, { body: { commit_id: r.head, path: c.path, subject_type: "file", body: withFooter(c.body, AGENT) } });
      made.push({ id: f.id, url: f.html_url, finding: c.id });
    }
    const links = new Map(made.filter((m) => m.finding).map((m) => [m.finding!, m.url]));
    await this.gh.request("PUT", `${api(ref)}/pulls/${ref.number}/reviews/${review.id}`, { body: { body: withFooter(renderReview(r, a.run, { place, earlier, links, gated: a.gated }).summary, AGENT) } });
    // A missing finding isn't proof of a fix: the state service names the ids its recheck confirmed, and only the threads it
    // recorded as its own posts (`own`, its database) for findings the review no longer reports are resolved. The resolves and the
    // acknowledgement speak for the PR's current head: a review of an older one leaves them to the newer head's review.
    const current = pr.head.sha === r.head;
    const present = new Set(r.findings.map((f) => f.id));
    const own = new Set(a.own);
    const done = current ? await this.resolve(ref, { finding_ids: a.resolve.filter((id) => !present.has(id)) }, (t) => own.has(t.comment)) : { resolved: [], skipped: [] };
    const c = counts(r.findings);
    const ack = current ? await this.ack(ref, who, `${renderNotice({ repo: r.repo, pr: r.pr, head: r.head, phase: "done", engine: r.engine, model: r.model, effort: r.effort, ...c, cost_usd: r.cost_usd, run: a.run })}\n[The review](${review.html_url})`) : undefined;
    return { ok: true, text: JSON.stringify({ identity: "owner", login: who.login, review: review.html_url, inline: made.length, listed: first.listed.length, earlier: earlier.size, resolved: done.resolved.length, skipped: done.skipped, ...(ack ? { ack: ack.url } : {}), comments: made.map((m) => m.id) }), objects: [...made.map((m) => `${objectRef(ref)}/comment/${m.id}`), ...(ack ? [ack.object] : [])] };
  }
}

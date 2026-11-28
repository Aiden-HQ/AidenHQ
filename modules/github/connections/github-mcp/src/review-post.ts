// Code review's posting (docs/design/code-review.md "Posting"), run for a kernel write record the AI reviewer approved: the
// code-review module's executor calls `preview` (what the card shows) and `execute` (what is posted) through github-mcp's
// /internal/review routes. Each write goes as the actor client.ts's actorFor picks for its op on the PR's base repo
// (docs/design/github-identity.md): the instance's GitHub App where it is installed with the op's permissions, else the owner. Each text is signed with the AidenHQ footer. A review is only ever a COMMENT (no GitHub approval or change request: on
// a gated repo the merge queue asks code review's verdict itself); the commit status `aidenhq/review` only mirrors that verdict.
// A thread is Aiden's own when its first comment carries our finding marker and is by the owner or the App (its live login, read
// from GitHub): model text can't
// write a marker (review-render.ts escapes `<`). Every request goes through github.ts's `guard`.
import type { z } from "zod";
import { withFooter } from "./aidenhq-sdk/attribution.js";
import type { GitHubAccess, Op } from "./client.js";
import type { GitHubApp } from "./github-app.js";
import { GitHub, GitHubRefused, RESOLVE_MAX, objectRef, reviewCommentId, type Ref } from "./github.js";
import {
  ACK_HEAD, FINDING_MARK, SCALES, comboText, NoticeArgsSchema, PostArgsSchema, ReplyArgsSchema, RUN_MARK, STATUS_CONTEXT, StatusArgsSchema, anchors, counts, renderNotice,
  plain, renderReview, renderStatus, rightLines, type NoticeArgs, type Placed, type PostArgs, type ReplyArgs, type StatusArgs,
} from "./review-render.js";

/** The card's details are cut at this many characters by the kernel: a review that can't be shown whole is refused. */
const CARD_MAX = 79_000;

/** Who posts: the owner's login, or the App's bot (GitHub names it `<slug>[bot]` on REST and `<slug>` on GraphQL). */
export type Who = { login: string; bot: boolean; identity: "owner" | "app" };
/** One write attempt's client (bound to its actor) and who that is. */
export type Writer = { gh: GitHub; who: Who };
/** An author as GitHub names it: REST `user` (`type` User or Bot) or GraphQL `author` (`__typename`). */
type Author = { login?: string; type?: string; __typename?: string } | null | undefined;
/** Whether `a` is `who`: the same login and the same kind (a person can't pass for a bot of that name, or the reverse). */
const isWho = (who: Who, a: Author) => Boolean(a?.login) && norm(a!.login!) === norm(who.login) && ((a!.type ?? a!.__typename) === "Bot") === who.bot;
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
  /** The first comment's id (what the code-review service records as its own thread). */
  comment: number;
  /** The first comment carries a finding marker and is by the owner or AidenHQ's GitHub App: Aiden's own thread. */
  ours: boolean;
  author: string;
  /** The first comment's text, cut (data: a stranger's, or another reviewer's). */
  body: string;
  /** The first comment's author is a bot (an App). */
  bot: boolean;
  /** Whether the identity that read the threads may resolve this one. */
  can_resolve: boolean;
  url: string;
  /** The run whose file comment this is (its run marker), or null. */
  run: string | null;
  /** Replies, oldest first, as data (untrusted text). */
  replies: { id: number; author: string; body: string }[];
}
/** A review comment, with its 64-bit id in `fullDatabaseId` (a JSON string; `databaseId` is 32-bit and deprecated). */
type RawComment = { fullDatabaseId?: string | null; url: string; body: string; author: { __typename: string; login: string } | null };
type RawThread = { id: string; isResolved: boolean; isOutdated: boolean; viewerCanResolve: boolean; path: string; line: number | null; comments: { nodes: RawComment[] } };
type GhPr = { state: string; merged?: boolean; draft?: boolean; head: { sha: string }; base: { sha: string } };
type Kind = "post" | "notice" | "status" | "reply";

/**
 * The AI reviewer's card for a post: the rendered review and every comment, at the largest text scale that fits CARD_MAX (every
 * finding and its thread stay; their texts shrink, at the least to titles). The post renders at the same scale, so what is posted
 * is what was approved.
 */
function card(a: PostArgs): { details: string; comments: Placed[]; scale: number } {
  const r = a.review;
  let out = { details: "", comments: [] as Placed[], scale: 0 };
  for (const scale of SCALES) {
    const { summary, comments } = renderReview(r, a.run, { gated: a.gated, card: true, scale, tier: a.tier, tier_why: a.tier_why, first: a.first });
    const details = [
      // The fixed command words are named, not shown (`card`): `aiden review` lines read like instructions to the reviewer, which
      // then refused whole reviews as prompt injection (2 of 40 posts, 2026-11-21).
      `Review summary (event COMMENT, at commit ${r.head}):`, "", summary, "",
      ...comments.flatMap((m) => [`--- inline comment on ${m.path}:${m.line} ---`, "", m.body, ""]),
      "(A comment whose line isn't on the diff goes on the nearest diff line of its file, or on the file, saying where it is.)",
      ...(a.resolve.length ? ["", `Resolves Aiden's own threads for findings: ${a.resolve.join(", ")} (only those it posted, and only if no longer reported).`] : []),
    ].join("\n");
    out = { details, comments, scale };
    if (details.length <= CARD_MAX) break;
  }
  return out;
}

/** The explicit target must be the review's own: a review of another repo, pull request or commit is refused. */
function target(a: PostArgs): PostArgs {
  const r = a.review;
  if (r.repo.toLowerCase() !== a.repo.toLowerCase() || r.pr !== a.pr || r.head !== a.head) throw new GitHubRefused(`the review is of ${r.repo}#${r.pr} at ${r.head.slice(0, 12)}, not ${a.repo}#${a.pr} at ${a.head.slice(0, 12)}`);
  return a;
}
const RUN_RE = /<!-- aidenhq-review-run: ([A-Za-z0-9_.-]{1,64}) -->/;
const norm = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");
const split = (repo: string): Ref => { const [owner, name] = repo.split("/"); return { owner: owner!, repo: name!, number: 0 }; };
const api = (r: Ref) => `/repos/${r.owner}/${r.repo}`;

/** Two notice texts that differ at most in the head their footer names (`<sub>abc1234 · …`). */
const sameWords = (a: string | undefined, b: string) => a !== undefined && a.replace(/<sub>[0-9a-f]{7,40}/, "<sub>") === b.replace(/<sub>[0-9a-f]{7,40}/, "<sub>");

export class ReviewPoster {
  /** Each pull request's acknowledgement writes, one after another. */
  private readonly ackTail = new Map<string, Promise<unknown>>();
  /** An acknowledgement the writer replaced (the owner's, before the App), by `<pr>:<old id>`: the new comment's id. */
  private readonly replaced = new Map<string, number>();
  constructor(
    private readonly gh: GitHub,
    private readonly access: Pick<GitHubAccess, "identity" | "actorFor" | "connected">,
    private readonly onFailure?: (err: unknown) => void,
    /** The instance's optional GitHub App (github-app.ts): who its bot is, for the threads it started. */
    private readonly app?: Pick<GitHubApp, "identity">,
  ) {}

  /** The owner (a typed need when GitHub isn't connected). */
  private async owner(): Promise<Who> {
    return { login: (await this.access.identity()).login, bot: false, identity: "owner" };
  }

  /** One write attempt on `repo` (the PR's base repo) for `op`: its actor (actorFor) bound to a client, and who that is. */
  private async attempt(repo: string, op: Op): Promise<Writer> {
    const actor = await this.access.actorFor({ repo }, op);
    const { login } = await actor.identity();
    return { gh: this.gh.with(actor), who: { login: norm(login), bot: actor.kind === "app", identity: actor.kind } };
  }

  /** Who may own a thread: the owner (while signed in), and the App's bot while an App is set up (also threads it started before a switch). */
  private async ourIdentities(): Promise<Who[]> {
    const bot = await this.app?.identity();
    // The owner's login only names threads the owner posted: a sign-in that lapsed must not stop the App posting its own.
    const owner = this.access.connected() ? await this.owner() : undefined;
    return [...(owner ? [owner] : []), ...(bot ? [{ login: norm(bot.login), bot: true, identity: "app" as const }] : [])];
  }

  /**
   * A pull request's review threads: ours (the first comment has a finding marker and is by the owner or the App) and anyone's,
   * replies included. Read as the owner, or as `gh` (the writer: `can_resolve` is then its own).
   */
  async threads(ref: Ref, gh: GitHub = this.gh): Promise<Thread[]> {
    const us = await this.ourIdentities();
    const out: Thread[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const d: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawThread[] } } | null } | null } = await gh.graphql("reviewThreads", { owner: ref.owner, name: ref.repo, number: ref.number, after });
      const t = d.repository?.pullRequest?.reviewThreads;
      if (!t) throw new GitHubRefused(`couldn't read ${ref.owner}/${ref.repo}#${ref.number}'s review threads`);
      for (const n of t.nodes) {
        const [first, ...rest] = n.comments.nodes;
        // A thread's first comment is what a reply names and what the service records as its own: without a usable id, skip it
        // (and its replies, whose thread it can't identify) rather than fail the whole read.
        const comment = first ? reviewCommentId(first) : null;
        if (!first || comment === null) continue;
        const finding = FINDING_MARK.exec(first.body)?.[1] ?? null;
        const author = first.author?.login ?? "";
        out.push({
          id: n.id, comment, run: RUN_RE.exec(first.body)?.[1] ?? null, resolved: n.isResolved, outdated: n.isOutdated, path: n.path, line: n.line, finding,
          ours: finding !== null && us.some((w) => isWho(w, first.author)), author, body: first.body.slice(0, 600), bot: first.author?.__typename === "Bot", can_resolve: n.viewerCanResolve, url: first.url,
          replies: rest.flatMap((c) => { const id = reviewCommentId(c); return id === null ? [] : [{ id, author: c.author?.login ?? "", body: c.body.slice(0, 2000) }]; }),
        });
      }
      if (!t.pageInfo.hasNextPage) break;
      after = t.pageInfo.endCursor;
    }
    return out;
  }

  /**
   * Resolves the listed threads that are Aiden's own (`mine`: the service's record) and still open, as the writer; the others are
   * reported, never touched. A thread the writer may not resolve (the App, on a thread the owner started) is skipped with that reason.
   */
  async resolve(ref: Ref, wanted: { thread_ids?: string[]; finding_ids?: string[] }, mine: (t: Thread) => boolean, w: Writer): Promise<{ resolved: string[]; skipped: { thread: string; why: string }[] }> {
    const all = (await this.threads(ref, w.gh)).map((t) => ({ ...t, ours: mine(t) }));
    const open: string[] = [];
    const skipped: { thread: string; why: string }[] = [];
    const picks = new Map<string, string>();
    for (const id of wanted.thread_ids ?? []) picks.set(id, all.some((t) => t.id === id) ? "" : "no such thread on this pull request");
    for (const f of wanted.finding_ids ?? []) { const t = all.find((x) => x.finding === f && x.ours && !x.resolved) ?? all.find((x) => x.finding === f); if (t) picks.set(t.id, ""); else skipped.push({ thread: f, why: "no thread for that finding" }); }
    for (const [id, missing] of picks) {
      const t = all.find((x) => x.id === id);
      if (!t) skipped.push({ thread: id, why: missing });
      else if (!t.ours) skipped.push({ thread: id, why: "not a thread code review recorded as its own" });
      else if (t.resolved) skipped.push({ thread: id, why: "already resolved" });
      else if (!t.can_resolve) skipped.push({ thread: id, why: `GitHub doesn't let ${w.who.identity === "app" ? "AidenHQ's GitHub App" : "the owner"} resolve it` });
      else open.push(id);
    }
    // One request for all of them; only the ones GitHub resolved are reported.
    const resolved = open.length ? await w.gh.resolveThreads(open.slice(0, RESOLVE_MAX)) : [];
    for (const id of open) if (!resolved.includes(id)) skipped.push({ thread: id, why: "GitHub didn't resolve it" });
    return { resolved, skipped };
  }

  /** Where comments may land on the reviewed commit's diff (its merge base to it, whatever the PR's head is now): each changed
   * file's right-side lines; a file with no patch (binary, too large) has none and takes a file comment. */
  private async diffLines(ref: Ref, gh: GitHub, base: string, head: string, current: boolean): Promise<Map<string, Set<number>>> {
    // The PR's own files (up to 3,000, paged) while it is still at the reviewed commit; after it moved, the compare of the reviewed
    // commit (GitHub lists at most its first 300 files: a finding past them is listed in the summary, without a thread).
    const files: { filename: string; patch?: string }[] = [];
    // The PR's files are read as the writer; the compare is a Contents read, which a review's writer needn't hold, so it goes as
    // the client picks (the App where it may, else the owner).
    if (current) {
      for (let page = 1; page <= 30; page++) {
        const fs = await gh.request<{ filename: string; patch?: string }[]>("GET", `${api(ref)}/pulls/${ref.number}/files`, { query: { per_page: 100, page } });
        files.push(...fs);
        if (fs.length < 100) break;
      }
    } else files.push(...((await this.gh.request<{ files?: { filename: string; patch?: string }[] }>("GET", `${api(ref)}/compare/${base}...${head}`, { query: { per_page: 1 } })).files ?? []));
    return new Map(files.map((f) => [f.filename, f.patch ? rightLines(f.patch) : new Set<number>()]));
  }

  private async pull(ref: Ref, gh: GitHub = this.gh): Promise<GhPr> {
    const pr = await gh.request<GhPr>("GET", `${api(ref)}/pulls/${ref.number}`, {});
    // A merged PR still takes its review (GitHub accepts one); a closed one doesn't.
    if (pr.state !== "open" && !pr.merged) throw new GitHubRefused(`${ref.owner}/${ref.repo}#${ref.number} isn't open or merged`);
    return pr;
  }

  /**
   * The acknowledgement comment: the one the code-review service recorded from an earlier outcome (`id`, its database), edited
   * in place by its own author; with no id recorded (a create whose answer was lost) the pull request's comments are read for the
   * one that is a notice of this writer's, so an uncertain create is reconciled with the comment it made instead of a second one
   * being created; else (none yet, deleted, or the other identity's from before the App) a new one.
   */
  private async ack(ref: Ref, text: string, w: Writer, recorded?: number): Promise<{ id: number; url: string; object: string }> {
    // One at a time per pull request: two notices filed before the first new ack's id is recorded both carry the owner's old one,
    // and the second must edit the comment the first made, not make another.
    const k = objectRef(ref);
    const run = (this.ackTail.get(k) ?? Promise.resolve()).then(async () => {
      const id = recorded ? (this.replaced.get(`${k}:${recorded}`) ?? recorded) : undefined;
      const made = await this.ackOnce(ref, text, w, id);
      if (recorded && made.id !== recorded) this.replaced.set(`${k}:${recorded}`, made.id);
      return made;
    });
    this.ackTail.set(k, run.catch(() => {}));
    return run;
  }

  private async ackOnce(ref: Ref, text: string, w: Writer, id?: number): Promise<{ id: number; url: string; object: string }> {
    const signed = withFooter(text, AGENT);
    // With no id recorded, the comment an uncertain create made is found by its notice header (see `ackComment`): one
    // acknowledgement comment per pull request per writer, edited in place, never a second one.
    id ??= await this.ackComment(ref, w);
    if (id) {
      // Read it first: a notice whose words are already there writes nothing, the head in its footer aside (a push that leaves the
      // status as it was, e.g. past the push review cap, edits nothing).
      const have = await this.gh.request<{ html_url: string; body?: string; user?: Author }>("GET", `${api(ref)}/issues/comments/${id}`, {}).catch((e: Error) => { if (/\b404\b/.test(e.message)) return undefined; throw e; });
      if (have && isWho(w.who, have.user)) {
        const ok = sameWords(have.body, signed) ? have : await w.gh.request<{ html_url: string }>("PATCH", `${api(ref)}/issues/comments/${id}`, { body: { body: signed } }).catch((e: Error) => { if (/\b404\b/.test(e.message)) return undefined; throw e; });
        if (ok) return { id, url: ok.html_url, object: `${objectRef(ref)}/comment/${id}` };
      }
    }
    const made = await w.gh.request<{ id: number; html_url: string }>("POST", `${api(ref)}/issues/${ref.number}/comments`, { body: { body: signed } });
    return { id: made.id, url: made.html_url, object: `${objectRef(ref)}/comment/${made.id}` };
  }

  /** The pull request's acknowledgement comment, for a notice whose comment id isn't known: a create whose answer was lost is
   * found here rather than made again. Only a comment that *is* a notice counts — the generated header (`ACK_HEAD`: the marker
   * and the bold status on its own first line, which `renderNotice` always writes) by this writer. The marker alone is not enough:
   * a person using the same login can quote a notice's raw Markdown in an ordinary comment, and that comment must never be taken
   * for one code review may edit. Undefined when there is none (or it can't be read). */
  private async ackComment(ref: Ref, w: Writer): Promise<number | undefined> {
    let last: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const cs = await this.gh.request<{ id: number; body?: string; user?: Author }[]>("GET", `${api(ref)}/issues/${ref.number}/comments`, { query: { per_page: 100, page } }).catch(() => undefined);
      if (!cs) return last;
      for (const c of cs) if (isWho(w.who, c.user) && ACK_HEAD.test(c.body ?? "")) last = c.id;
      if (cs.length < 100) break;
    }
    return last;
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
          changes: `One commit status on ${a.head.slice(0, 12)}, as AidenHQ's GitHub App where it is installed with the permission, else as the owner: code review's merge verdict mirrored, in fixed words.`,
          details: `${s.state}: ${s.description}`,
        },
        targets: { [`${a.repo}#${a.pr}`]: { repo: a.repo, ref: `pull/${a.pr}`, commit: a.head, base_sha: null } },
      };
    }
    if (kind === "reply") {
      const a = ReplyArgsSchema.parse(args);
      return {
        facts: {
          target: `${a.repo}#${a.pr} @ ${a.head.slice(0, 7)}`,
          sentence: `Reply on a code review finding's thread on ${a.repo}#${a.pr}.`,
          changes: "One reply on Aiden's own review thread, as AidenHQ's GitHub App where it is installed with the permission (else the owner), signed by AidenHQ: the agent's answer to the finding (fixed, disputed, by design or won't fix, and why).",
          details: a.body,
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
          changes: "Edits Aiden's one acknowledgement comment on the pull request, as AidenHQ's GitHub App where it is installed with the permission, else as the owner, signed by AidenHQ. The words are fixed; no model text.",
          details: renderNotice(n),
        },
        targets: { [`${n.repo}#${n.pr}`]: { repo: n.repo, ref: `pull/${n.pr}`, commit: n.head, base_sha: null } },
      };
    }
    const a = target(PostArgsSchema.parse(args));
    const r = a.review;
    const { details, comments } = card(a);
    const c = counts(r.findings);
    if (details.length > CARD_MAX) throw new GitHubRefused(`the review is ${details.length} characters, too large for the AI reviewer to read whole (${CARD_MAX}) even with each finding's title alone`);
    return {
      facts: {
        target: `${r.repo}#${r.pr} @ ${r.head.slice(0, 7)}`,
        sentence: `Post Aiden's review of ${r.repo}#${r.pr} (${comboText(r)}: ${c.important} important, ${c.nit} nit, ${c.pre_existing} pre-existing).`,
        changes: `A GitHub review with ${comments.length} inline comment${comments.length === 1 ? "" : "s"} (one thread per important finding, on its line, the nearest diff line or its file; nits and pre-existing findings stay on the board, counted in the summary), as AidenHQ's GitHub App where it is installed with the permission, else as the owner, signed by AidenHQ.${a.resolve.length ? ` It resolves ${a.resolve.length} of its own earlier thread(s).` : ""} A comment review, never a GitHub approval or change request.`,
        details,
      },
      // The head alone: a review is of one commit, so its base moving (another merge landed) never makes it stale. Other
      // kinds keep binding the base, where what they act on is what they push or merge.
      targets: { [`${r.repo}#${r.pr}`]: { repo: r.repo, ref: `pull/${r.pr}`, commit: r.head } },
    };
  }

  /** Posts what `preview` showed. Throws (a failed outcome) when the pull request is closed unmerged. */
  async execute(kind: Kind, args: unknown): Promise<{ ok: boolean; text: string; objects: string[] }> {
    if (kind === "status") return this.status(StatusArgsSchema.parse(args));
    if (kind === "reply") return this.reply(ReplyArgsSchema.parse(args));
    return kind === "post" ? this.post(target(PostArgsSchema.parse(args))) : this.notice(NoticeArgsSchema.parse(args));
  }

  /** The reply goes only on a thread that is Aiden's own (its first comment carries our marker, by the posting identity), as code review's writer. */
  private async reply(a: ReplyArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const ref = { ...split(a.repo), number: a.pr };
    const w = await this.attempt(a.repo, "pr");
    await this.pull(ref);
    if (!(await this.threads(ref)).some((t) => t.comment === a.comment && t.ours)) throw new GitHubRefused(`comment ${a.comment} isn't the first comment of one of Aiden's own review threads on ${a.repo}#${a.pr}`);
    const r = await w.gh.request<{ id: number; html_url: string }>("POST", `${api(ref)}/pulls/${ref.number}/comments/${a.comment}/replies`, { body: { body: withFooter(`<!-- aidenhq-mirror -->\n${plain(a.body, 2000)}`, AGENT) } });
    return { ok: true, text: JSON.stringify({ identity: w.who.identity, login: w.who.login, reply: r.html_url }), objects: [`${objectRef(ref)}/comment/${r.id}`] };
  }

  private async notice(n: NoticeArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const ref = { ...split(n.repo), number: n.pr };
    const w = await this.attempt(n.repo, "issue");
    await this.pull(ref);
    const ack = await this.ack(ref, renderNotice(n), w, n.ack);
    return { ok: true, text: JSON.stringify({ identity: w.who.identity, login: w.who.login, ack: ack.url, ack_id: ack.id }), objects: [ack.object] };
  }

  /** The commit status `aidenhq/review` on the head: code review's verdict mirrored (the service writes only on a change). */
  private async status(a: StatusArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const ref = { ...split(a.repo), number: a.pr };
    const w = await this.attempt(a.repo, "status");
    const s = renderStatus(a);
    // The latest status of this context on the commit: the same state and words write nothing.
    const now = await this.gh.request<{ statuses?: { context: string; state: string; description: string | null; target_url?: string | null; creator?: Author }[] }>("GET", `${api(ref)}/commits/${a.head}/status`, { query: { per_page: 100 } });
    const had = now.statuses?.find((x) => x.context === STATUS_CONTEXT);
    // The writer's own, word for word: one the other identity set (the owner's, before the App) is set again by the writer.
    if (had?.state === s.state && isWho(w.who, had.creator) && had.description === s.description && had.target_url === `https://github.com/${a.repo}/pull/${a.pr}`) return { ok: true, text: JSON.stringify({ identity: w.who.identity, login: w.who.login, state: s.state, unchanged: true }), objects: [] };
    await w.gh.request("POST", `${api(ref)}/statuses/${a.head}`, { body: { state: s.state, context: STATUS_CONTEXT, description: s.description, target_url: `https://github.com/${a.repo}/pull/${a.pr}` } });
    return { ok: true, text: JSON.stringify({ identity: w.who.identity, login: w.who.login, state: s.state }), objects: [] };
  }

  /**
   * The review of the commit it reviewed, even when the PR has moved on since (its comments then show as outdated where the
   * lines changed). Every finding gets one thread: its lines, the nearest diff line of its file, or a file comment. Once posted,
   * the summary is updated so each finding's row links to its thread. A retry finds what it posted by the run's and the
   * findings' markers, so nothing is posted twice (markers only dedupe: the comment ids it reports, the service's record of its
   * own threads, are only those GitHub answered this attempt with). Once the review exists, the rest is done as far as it goes:
   * a file comment GitHub refuses leaves its finding in the summary, and the outcome still reports what was made. The
   * acknowledgement is the service's notice, never this post.
   */
  private async post(a: PostArgs): Promise<{ ok: boolean; text: string; objects: string[] }> {
    const r = a.review;
    const ref = { ...split(r.repo), number: r.pr };
    const w = await this.attempt(r.repo, "pr");
    const who = w.who;
    const pr = await this.pull(ref, w.gh);
    // This run's review, looked up before anything else it needs: a create whose answer was lost (a timeout, a gateway that
    // dropped the reply) may already have made it, and a retry that first read the threads and the diff could exhaust its attempts
    // there and report "not posted" about a review readers can see. Its id settles that question straight away.
    let review: { id: number; html_url: string; body?: string } | undefined;
    for (let page = 1; page <= 10 && !review; page++) {
      const rs = await w.gh.request<{ id: number; html_url: string; body?: string; user?: Author }[]>("GET", `${api(ref)}/pulls/${ref.number}/reviews`, { query: { per_page: 100, page } });
      // The writer's own (a review the owner posted before the App was installed is left as it is: the App posts its own).
      review = rs.find((x) => x.body?.includes(RUN_MARK(a.run)) && isWho(who, x.user));
      if (rs.length < 100) break;
    }
    const problems: string[] = [];
    const tryTo = async <T>(what: string, f: () => Promise<T>) => f().catch((e: Error) => void (this.onFailure?.(e), problems.push(`${what}: ${String(e.message).slice(0, 150)}`)));
    // A review that is already on the pull request makes what follows best-effort: its threads and diff are read for its remaining
    // comments, and a read that fails leaves those in the summary instead of reporting the review as not posted.
    let threads: Awaited<ReturnType<ReviewPoster["threads"]>> = [];
    if (review) threads = (await tryTo("reading the review's threads", () => this.threads(ref, w.gh))) ?? [];
    else threads = await this.threads(ref, w.gh);
    // Threads already open for a finding: the service's recorded ones, and this run's own from an earlier attempt (its run marker).
    const own = new Set(a.own);
    const earlier = new Map(threads.filter((t) => t.finding && (own.has(t.comment) || (t.run === a.run && isWho(who, { login: t.author, type: t.bot ? "Bot" : "User" })))).map((t) => [t.finding!, t.url]));
    // Only findings whose comment the AI reviewer's card showed get one (the card renders the same choice, without GitHub's view).
    const { comments: carded, scale } = card(a);
    const shown = new Set(carded.map((c) => c.id));
    const anchored = anchors(r.findings, review ? ((await tryTo("reading the diff", () => this.diffLines(ref, w.gh, r.base, r.head, pr.head.sha === r.head))) ?? new Map()) : await this.diffLines(ref, w.gh, r.base, r.head, pr.head.sha === r.head));
    const place = new Map([...anchored].filter(([id]) => shown.has(id)));
    const first = renderReview(r, a.run, { place, earlier, gated: a.gated, scale, tier: a.tier, tier_why: a.tier_why, first: a.first });
    const onLines = first.comments.filter((c) => !c.file);
    if (!review) {
      // A create that failed may still have made the review (a timeout, a gateway that lost the reply): read the PR's reviews
      // again before calling the post failed, so a review that is on the pull request is never reported as not posted and never
      // posted twice. A read that fails too is left to the caller's retry, which finds the review by its run's marker.
      review = await w.gh.request<{ id: number; html_url: string; body?: string }>("POST", `${api(ref)}/pulls/${ref.number}/reviews`, {
        body: { event: "COMMENT", commit_id: r.head, body: withFooter(first.summary, AGENT), ...(onLines.length ? { comments: onLines.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", ...(c.start_line ? { start_line: c.start_line } : {}), body: c.body })) } : {}) },
      }).catch(async (e: Error) => {
        for (let page = 1; page <= 10; page++) {
          const rs = await w.gh.request<{ id: number; html_url: string; body?: string; user?: Author }[]>("GET", `${api(ref)}/pulls/${ref.number}/reviews`, { query: { per_page: 100, page } }).catch(() => []);
          const found = rs.find((x) => x.body?.includes(RUN_MARK(a.run)) && isWho(who, x.user));
          if (found) return found;
          if (rs.length < 100) break;
        }
        throw e;
      });
    }
    // The review is on the pull request from here on: a later step failing (reading its comments, its summary links, its
    // threads) must not report the review as not posted, nor drop the comments it did make from AidenHQ's records. Each step is
    // tried on its own and what it made is kept; the ones that didn't finish are named in the outcome.
    const made: { id: number; url: string; finding?: string }[] = [];
    // Its inline comments (each thread's first comment) by finding, for the links and AidenHQ's records. The review is on the
    // pull request already: a read of its comments that fails is asked again here (the write is not repeated), because those ids
    // are the only record of which threads are Aiden's own. A read that keeps failing falls back to the review's threads, which
    // name the same comments by their run's marker: the ids are recorded either way, and no second review is ever made.
    await tryTo("reading the review's comments", async () => {
      // Every page read before a failure is kept (this attempt's, an earlier attempt's, or the fallback's): those ids are the
      // only record of which threads are Aiden's own, and a page that did arrive must never be lost because a later one didn't.
      const seen = new Map<number, { id: number; url: string; finding?: string }>();
      const keep = (c: { id: number; html_url?: string; url?: string; body?: string }, finding?: string | null) =>
        seen.set(c.id, { id: c.id, url: c.html_url ?? c.url ?? "", ...(finding ?? FINDING_MARK.exec(c.body ?? "")?.[1] ? { finding: finding ?? FINDING_MARK.exec(c.body ?? "")![1] } : {}) });
      for (let attempt = 1; ; attempt++) {
        try {
          for (let page = 1; page <= 10; page++) {
            const cs = await w.gh.request<{ id: number; html_url: string; body?: string }[]>("GET", `${api(ref)}/pulls/${ref.number}/reviews/${review!.id}/comments`, { query: { per_page: 100, page } });
            for (const c of cs) keep(c);
            if (cs.length < 100) break;
          }
          made.push(...seen.values());
          return;
        } catch (e) {
          if (attempt >= 3) {
            // Its comments can't be listed by the review: its threads still name them (each first comment, its run's marker), so
            // the ids are recovered from there, merged by id with every page that was read, rather than left for a caller's retry
            // that would only find them the same way.
            const mine = (await this.threads(ref, w.gh).catch(() => [])).filter((t) => t.run === a.run && isWho(who, { login: t.author, type: t.bot ? "Bot" : "User" }));
            for (const t of mine) if (!seen.has(t.comment)) seen.set(t.comment, { id: t.comment, url: t.url, ...(t.finding ? { finding: t.finding } : {}) });
            if (!seen.size) throw e;
            made.push(...seen.values());
            return;
          }
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
    });
    // A finding on a file without diff lines takes a file comment (its own thread, outside the review).
    const unthreaded = new Set<string>();
    for (const c of first.comments.filter((x) => x.file)) {
      const f = await tryTo(`file comment on ${c.path}`, () => w.gh.request<{ id: number; html_url: string }>("POST", `${api(ref)}/pulls/${ref.number}/comments`, { body: { commit_id: r.head, path: c.path, subject_type: "file", body: withFooter(`${RUN_MARK(a.run)}\n${c.body}`, AGENT) } }));
      if (f) made.push({ id: f.id, url: f.html_url, finding: c.id });
      else unthreaded.add(c.id);
    }
    const links = new Map(made.filter((m) => m.finding).map((m) => [m.finding!, m.url]));
    const placed = new Map([...place].filter(([id]) => !unthreaded.has(id)));
    // The review's own body already says all there is when no finding got a thread link: the PUT is only for a body that changes.
    const linked = withFooter(renderReview(r, a.run, { place: placed, earlier, links, gated: a.gated, scale, tier: a.tier, tier_why: a.tier_why, first: a.first }).summary, AGENT);
    if (linked !== review.body) await tryTo("summary links", () => w.gh.request("PUT", `${api(ref)}/pulls/${ref.number}/reviews/${review!.id}`, { body: { body: linked } }));
    // A missing finding isn't proof of a fix: the state service names the ids its recheck confirmed, and only the threads it
    // recorded as its own posts (`own`, its database) for findings the review no longer reports are resolved, and only for the
    // PR's current head (a review of an older one leaves them to the newer head's review).
    const present = new Set(r.findings.map((f) => f.id));
    const done = pr.head.sha === r.head ? (await tryTo("resolving threads", () => this.resolve(ref, { finding_ids: a.resolve.filter((id) => !present.has(id)) }, (t) => own.has(t.comment), w))) ?? { resolved: [], skipped: [] } : { resolved: [], skipped: [] };
    return { ok: true, text: JSON.stringify({ identity: who.identity, login: who.login, review: review.html_url, comments: made.map((m) => m.id), inline: made.length, listed: first.listed.length + unthreaded.size, earlier: earlier.size, resolved: done.resolved.length, ...(done.skipped.length ? { unresolved: done.skipped.slice(0, 10) } : {}), ...(problems.length ? { problems: problems.slice(0, 5) } : {}) }), objects: made.map((m) => `${objectRef(ref)}/comment/${m.id}`) };
  }
}

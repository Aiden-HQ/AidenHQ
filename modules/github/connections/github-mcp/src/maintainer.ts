// The Maintainer's GitHub tools, as the owner, on the repos the instance lists in `maintainer_repos` and no other: open
// issues carrying a repo's label, their label events with a trust verdict, the repo tree and one file, and the three writes
// (comment, label, state). A label is trusted only when a collaborator whose role is one of that repo's `trusted` roles added
// it (the owner's login is an admin, so its labels count); the issue's text or author never decide trust.
import { createHash, randomUUID } from "node:crypto";
import { GitHubRefused } from "./github.js";
import { GitHubNeed, writeBudgetDeadline, writeBudgetSpent } from "./client.js";
import { publicText } from "./scrub.js";
import { withFooter } from "./aidenhq-sdk/attribution.js";
import type { GitHubAccess } from "./client.js";
import { BUILD_LABEL, FEATURE_LABEL, type MaintainedRepo } from "./aidenhq-sdk/maintained-repos.js";

const PAGE_CAP = 10;
const ISSUE_CAP = 200;
// A collaborator's role is re-read at most this often: a revoked role stops trusting new labels within a minute, and a
// burst of label events on one issue costs one read.
const PERMISSION_TTL_MS = 60_000;
const TREE_CAP = 5000;
const TREE_DEPTH = 20;
const FILE_CAP = 256 * 1024;
// The open PRs one pr_list reads in full (each human PR costs a handful of reads): the rest wait for a later look.
const PR_CAP = 100;

// A close's note must cite a PR in a form the grader's parser reads (owner/name#number or its full /pull/ URL): a bare
// "PR #12" reads as no citation at all, so the issue looks closed without one. The word PR standing on its own is the
// bare form wherever it sits — "PR #12", "PR#12", "the PR #12", "abc/PR #12", "see acme/product/PR #12" — unless the
// token is part of the owner/name#N citation itself. The span decides, not what precedes the token, because that is
// what the parser does: a repo whose name ends in PR ("acme/foo-PR#12") is one citation, while a real link beside a
// "PR #700" leaves that token uncited.
const PR_TOKEN = /(?<!\w)PR\s*#\s*\d+\b/gi;
// The parser's owner/name#N form, mirrored from modules/grading/service/src/grader/text.ts (findPrs): github-mcp is its
// own build context and doesn't import the grading module.
const OWNER_NAME_PR = /(?<![\w./:-])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/g;

/** Why a close's `note` is refused, or undefined when it cites what it must. */
export function noteProblem(note: string, state: "open" | "closed", reason?: "completed" | "not_planned"): string | undefined {
  if (state !== "closed") return undefined;
  const cited = [...note.matchAll(OWNER_NAME_PR)].map((m) => ({ from: m.index ?? 0, to: (m.index ?? 0) + m[0].length }));
  for (const m of note.matchAll(PR_TOKEN)) {
    const from = m.index ?? 0;
    // Inside an owner/name#N citation the token is that citation's own name; anywhere else it is the bare form.
    if (!cited.some((c) => from >= c.from && from + m[0].length <= c.to))
      return "cite the PR as owner/name#number or its full /pull/ URL; a bare 'PR #N' is not read as a citation";
  }
  return undefined;
}

export interface LabelEvent {
  label: string;
  action: "labeled" | "unlabeled";
  actor: string | null;
  app_id: number | null;
  app_slug: string | null;
  created_at: string;
  trusted: boolean;
  /** The issue was edited after this agent-build event, so it no longer vouches for what the issue now says. */
  stale?: true;
}

interface GhTimelineEvent {
  event?: string;
  label?: { name?: string };
  actor?: { login?: string };
  performed_via_github_app?: { id?: number; slug?: string } | null;
  created_at?: string;
}

interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  created_at?: string;
  labels?: (string | { name: string })[];
  pull_request?: unknown;
  user?: { login?: string } | null;
  performed_via_github_app?: { id?: number; slug?: string } | null;
}

const labelNames = (i: GhIssue) => (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// The two fixed labels match exactly (the owner's word is `agent-build`, not a case variant); a repo's own label keeps GitHub's
// case-insensitive reading.
const named = (x: string, label: string) => (label === BUILD_LABEL || label === FEATURE_LABEL ? x === label : same(x, label));

export interface MaintainerPr {
  number: number;
  author: string;
  /** bot: an App or automation (Dependabot); fleet: in AidenHQ's records; human: anyone else. */
  author_kind: "bot" | "fleet" | "human";
  draft: boolean;
  /** The author's latest commit, comment or review on the PR (ISO), or the PR's own update time for a bot or fleet PR. */
  last_author_activity: string;
  /** A review is asked of someone (a person or team), so the PR waits on a maintainer, not its author. */
  review_requested: boolean;
  /** What the author must do (failing checks, requested changes, a conflict, still a draft), or null when nothing is asked of them. */
  waiting_on_author: string | null;
  labels: string[];
}

/** A path or ref with a `.` or `..` segment (encodeURIComponent leaves them) could name something outside the repo: refused. */
function noDots(v: string) {
  if (v.split("/").some((seg) => seg === "." || seg === "..")) throw new GitHubRefused(`${v.slice(0, 200)} has a . or .. segment`);
}

/** What a close's posted note says: the note as given, the state it asked for and the agent that signed it. A retry that finds
 * its own earlier comment by this identifies the note it posted even when the POST's answer was lost. */
type NoteSpec = { text: string; state: "open" | "closed"; agent: string };

/** A close note this process posted (or may have: see `confirmed`): its comment id, URL and objects, whether the POST's answer
 * came back, whether the state change was confirmed, when GitHub says it was created (the timeline's own order), when this
 * process recorded it, and, when the comment POST itself may have landed without an answer, the spec to match it by. A record
 * whose POST or PATCH is still unconfirmed is kept until `retainUntil`, even when that is well past the short TTL. */
type NoteRecord = {
  id: number;
  url: string;
  objects: string[];
  confirmed: boolean;
  createdAt: string;
  at: number;
  spec: NoteSpec;
  /** What identifies this call's note in its own body, so a retry can find it when the POST's answer was lost. */
  marker: string;
  /** Until when an unconfirmed record must survive: a rate limit's advertised reset, or now plus the retry window. */
  retainUntil: number;
};

/** Whether a thrown error is a lost answer (a dropped connection or a timed-out fetch) rather than a known refusal: GitHub may
 * or may not have applied the request, so the caller must be told the outcome is unknown, not told what it was. */
function lostAnswer(e: unknown): boolean {
  if (e instanceof GitHubNeed) return false;
  const name = (e as { name?: unknown })?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (e instanceof TypeError) return true;
  return /fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|other side closed/i.test(String((e as Error)?.message ?? ""));
}

/** Whether an error leaves the request's outcome unknown: a dropped connection, or a gateway's 5xx after GitHub may have applied it. */
function ambiguous(e: unknown): boolean {
  if (lostAnswer(e)) return true;
  const status = (e as { status?: unknown })?.status;
  return typeof status === "number" && status >= 500;
}

export class Maintainer {
  private roles = new Map<string, { role: string | null; at: number }>();
  /** Close notes this process posted (see `state`), by repo, issue, state and note text: what it posted, whether the state
   * change was confirmed, and GitHub's creation time. Only a note this process posted is here, so no comment on the issue can
   * suppress one. */
  private readonly noted = new Map<string, NoteRecord>();
  /** The key whose note is being decided and posted right now: a second, overlapping close of the same thing waits for it. */
  private readonly noteLocks = new Map<string, Promise<unknown>>();
  /** How long a confirmed close's note is remembered: a repeat inside this reuses it rather than posting again. */
  private static readonly NOTED_TTL_MS = 60 * 60_000;
  /** How long an unconfirmed record (POST or state change unanswered) survives at least, so a retry after a lost answer finds
   * it: longer than the tool budget, and extended by any refusal's `until`. */
  private static readonly NOTED_KEEP_MS = 24 * 60 * 60_000;
  private static readonly NOTED_CAP = 200;

  /** `repos` is the parsed list, or why it couldn't be parsed: then every tool refuses with that reason. */
  constructor(
    private readonly gh: Pick<GitHubAccess, "rest">,
    private readonly repos: MaintainedRepo[] | Error,
    private readonly terms: string[] = [],
    /** Whether a GitHub object (`github:<repo>#<n>`) is in AidenHQ's records: the fleet acts as the owner's login. */
    private readonly ours: (ref: string) => Promise<boolean> = async () => false,
  ) {}

  private ref(r: MaintainedRepo, number: number) {
    return `github:${r.repo.toLowerCase()}#${number}`;
  }

  /** The configured list (empty when it couldn't be parsed). */
  list(): MaintainedRepo[] {
    return this.repos instanceof Error ? [] : this.repos;
  }

  /** A listed repo's settings, or a refusal: no tool input may name a repository the instance doesn't list. */
  target(repo: string | undefined): MaintainedRepo {
    if (this.repos instanceof Error) throw new GitHubRefused(`maintainer_repos is invalid: ${this.repos.message}`);
    if (!this.repos.length) throw new GitHubRefused("no repos are configured (setting maintainer_repos)");
    const r = this.repos.find((x) => same(x.repo, String(repo ?? "").trim()));
    if (!r) throw new GitHubRefused(`${repo || "(no repo)"} is not a maintained repo; only ${this.repos.map((x) => x.repo).join(", ")}`);
    return r;
  }

  /** The owner-data terms for a comment on `r`: its own org names the repo, so it isn't owner data there. */
  private termsFor(r: MaintainedRepo): string[] {
    return this.terms.filter((t) => !same(t, r.owner));
  }

  /**
   * A collaborator's role, or null when they aren't one, re-read after PERMISSION_TTL_MS. GitHub documents the permission
   * route under Metadata read (X-Accepted-Github-Permissions: metadata=read), so the token asks for that and nothing wider.
   * A 404 means they aren't a user (untrusted, not an error); any other failure throws, so the caller fails closed.
   */
  private async role(owner: string, repo: string, login: string): Promise<string | null> {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()} ${login.toLowerCase()}`;
    const hit = this.roles.get(key);
    if (hit && Date.now() - hit.at < PERMISSION_TTL_MS) return hit.role;
    const r = await this.gh.rest("GET", `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
    if (r.status !== 200 && r.status !== 404) throw new Error(`couldn't read ${login}'s role on ${owner}/${repo} (GitHub said ${r.status})`);
    const role = r.status === 200 ? String(r.body.role_name ?? r.body.permission ?? "") || null : null;
    this.roles.set(key, { role, at: Date.now() });
    return role;
  }

  /**
   * Whether this event adding a label was made by a collaborator whose role is one of the repo's trusted roles. The owner's
   * login is an admin, so a label it adds counts, whether the owner or an agent added it: it gives the owner visibility and
   * is not a security boundary. A label with no actor is untrusted.
   */
  private async trustedEvent(e: GhTimelineEvent, r: MaintainedRepo): Promise<boolean> {
    const login = e.actor?.login;
    if (!login) return false;
    const role = await this.role(r.owner, r.name, login);
    return role !== null && r.trusted.includes(role);
  }

  /**
   * One issue's timeline reduced to label events (optionally one label), each with its trust verdict. The newest event is
   * what decides trust, so a timeline longer than the page cap is refused rather than read as if its tail were the end.
   */
  async labelEvents(repo: string | undefined, number: number, only?: string): Promise<{ repo: string; number: number; events: LabelEvent[] }> {
    const r = this.target(repo);
    const { owner, name } = r;
    const events: LabelEvent[] = [];
    let page = 1;
    for (; page <= PAGE_CAP; page++) {
      const res = await this.gh.rest("GET", `/repos/${owner}/${name}/issues/${number}/timeline?per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't read ${owner}/${name}#${number}'s timeline (GitHub said ${res.status})`);
      const pageEvents = (Array.isArray(res.body) ? res.body : []) as GhTimelineEvent[];
      for (const e of pageEvents) {
        if (e.event !== "labeled" && e.event !== "unlabeled") continue;
        const label = String(e.label?.name ?? "");
        if (!label || (only && !named(label, only))) continue;
        events.push({
          label,
          action: e.event,
          actor: e.actor?.login ?? null,
          app_id: e.performed_via_github_app?.id ?? null,
          app_slug: e.performed_via_github_app?.slug ?? null,
          created_at: String(e.created_at ?? ""),
          trusted: await this.trustedEvent(e, r),
        });
      }
      if (pageEvents.length < 100) break;
    }
    if (page > PAGE_CAP) throw new GitHubRefused(`#${number}'s timeline is longer than ${PAGE_CAP * 100} events, so its latest label event can't be read; refusing to guess`);
    // The owner approved the issue as it read then: an edit to its title or body since (GitHub's lastEditedAt) withdraws that,
    // and the owner relabels to approve it again. An unreadable edit time throws, so the caller fails closed.
    const build = events.filter((e) => e.label === BUILD_LABEL).at(-1);
    if (build?.action === "labeled" && build.trusted) {
      const res = await this.gh.rest("POST", "/graphql", { query: "query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){lastEditedAt}}}", variables: { o: r.owner, n: r.name, i: number } });
      const edited = res.body?.data?.repository?.issue?.lastEditedAt;
      if (res.status !== 200 || res.body?.errors || edited === undefined) throw new Error(`couldn't read when ${r.repo}#${number} was last edited (GitHub said ${res.status})`);
      if (edited && Date.parse(edited) > Date.parse(build.created_at)) Object.assign(build, { trusted: false, stale: true });
    }
    return { repo: r.repo, number, events };
  }

  /** The latest event of `label` (the repo's by default), when it is a `labeled` one: the label is currently on the issue. */
  private latestLabel(r: MaintainedRepo, events: LabelEvent[], label = r.label): LabelEvent | undefined {
    const e = events.filter((x) => named(x.label, label)).at(-1);
    return e?.action === "labeled" ? e : undefined;
  }

  /** The latest label event, or why it couldn't be read: an unreadable timeline is untrusted, never assumed. */
  private async latestOrError(r: MaintainedRepo, number: number, label = r.label): Promise<{ latest?: LabelEvent; error?: string }> {
    try {
      return { latest: this.latestLabel(r, (await this.labelEvents(r.repo, number, label)).events, label) };
    } catch (err) {
      return { error: (err as Error).message.slice(0, 200) };
    }
  }

  /** Open issues carrying `label` (default the repo's), each with its repo-label event and whether that label is trusted. */
  async issueList(repo: string | undefined, label?: string) {
    const r = this.target(repo);
    const { owner, name } = r;
    const asked = label ?? r.label;
    const issues: Record<string, unknown>[] = [];
    for (let page = 1; page <= PAGE_CAP; page++) {
      const res = await this.gh.rest("GET", `/repos/${owner}/${name}/issues?state=open&labels=${encodeURIComponent(asked)}&per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't list ${owner}/${name}'s issues (GitHub said ${res.status})`);
      const pageIssues = (Array.isArray(res.body) ? res.body : []) as GhIssue[];
      for (const i of pageIssues) {
        if (i.pull_request || issues.length >= ISSUE_CAP) continue;
        const { latest, error } = await this.latestOrError(r, i.number, asked);
        issues.push({
          number: i.number,
          title: i.title,
          url: i.html_url,
          updated_at: i.updated_at,
          trusted: Boolean(latest?.trusted),
          labeled_at: latest?.created_at ?? null,
          actor: latest?.actor ?? latest?.app_slug ?? null,
          label_event: latest ?? null,
          ...(error ? { error } : {}),
        });
      }
      if (pageIssues.length < 100) break;
    }
    return { repo: r.repo, label: asked, trusted_roles: r.trusted, features: r.features, issues };
  }

  /** Every page of a GET list (capped), as the owner. */
  private async readAll(r: MaintainedRepo, path: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= PAGE_CAP; page++) {
      const res = await this.gh.rest("GET", `/repos/${r.owner}/${r.name}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't read ${r.repo}${path.split("?")[0]} (GitHub said ${res.status})`);
      const items = (Array.isArray(res.body) ? res.body : Array.isArray(res.body?.check_runs) ? res.body.check_runs : []) as any[];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  /**
   * A maintained repo's open pull requests (newest first, at most PR_CAP), each with who wrote it (bot, the fleet, or a
   * human) and, for a human's, the author's latest activity and what is waiting on them. Titles and bodies are a stranger's
   * words and are not returned.
   */
  async prList(repo: string | undefined): Promise<{ repo: string; prs: MaintainerPr[] }> {
    const r = this.target(repo);
    const listed = (await this.readAll(r, "/pulls?state=open&sort=created&direction=desc")).slice(0, PR_CAP);
    const prs: MaintainerPr[] = [];
    for (const p of listed) {
      const login = String(p.user?.login ?? "");
      const kind = (await this.ours(this.ref(r, p.number))) ? "fleet" : p.user?.type === "Bot" || login.endsWith("[bot]") ? "bot" : "human";
      const base = {
        number: p.number as number,
        author: login,
        author_kind: kind as MaintainerPr["author_kind"],
        draft: p.draft === true,
        review_requested: (p.requested_reviewers?.length ?? 0) + (p.requested_teams?.length ?? 0) > 0,
        labels: ((p.labels ?? []) as { name: string }[]).map((l) => l.name),
      };
      if (kind !== "human") {
        prs.push({ ...base, last_author_activity: String(p.updated_at), waiting_on_author: null });
        continue;
      }
      const n = p.number as number;
      const mine = (x: any) => String(x.user?.login ?? "").toLowerCase() === login.toLowerCase();
      const [head, detail, checks, comments, reviews, threads] = await Promise.all([
        this.gh.rest("GET", `/repos/${r.owner}/${r.name}/commits/${p.head.sha}`),
        this.gh.rest("GET", `/repos/${r.owner}/${r.name}/pulls/${n}`),
        this.readAll(r, `/commits/${p.head.sha}/check-runs`),
        this.readAll(r, `/issues/${n}/comments`),
        this.readAll(r, `/pulls/${n}/reviews`),
        this.readAll(r, `/pulls/${n}/comments`),
      ]);
      if (head.status !== 200 || detail.status !== 200) throw new Error(`couldn't read ${r.repo}#${n} (GitHub said ${head.status === 200 ? detail.status : head.status})`);
      const times = [head.body.commit?.committer?.date, ...comments.filter(mine).map((c) => c.created_at), ...reviews.filter(mine).map((x) => x.submitted_at), ...threads.filter(mine).map((c) => c.created_at)].filter(Boolean).map(String);
      // Each reviewer's latest verdict stands: one who asked for changes and hasn't returned leaves the PR waiting on the author.
      const verdict = new Map<string, string>();
      for (const x of reviews) if (x.state === "CHANGES_REQUESTED" || x.state === "APPROVED" || x.state === "DISMISSED") verdict.set(String(x.user?.login), x.state);
      // Fixed words only: a check's name is whatever the repo's CI (or a stranger's workflow) calls it, so it never reaches a task.
      const failing = checks.filter((c) => ["failure", "timed_out", "action_required"].includes(c.conclusion)).length;
      const waiting = [
        failing ? `failing checks (${failing})` : "",
        [...verdict.values()].includes("CHANGES_REQUESTED") ? "requested changes" : "",
        detail.body.mergeable_state === "dirty" ? "a merge conflict" : "",
        base.draft ? "still a draft" : "",
      ].filter(Boolean);
      prs.push({ ...base, last_author_activity: times.sort().at(-1) ?? String(p.created_at), waiting_on_author: waiting.length ? waiting.join("; ") : null });
    }
    return { repo: r.repo, prs };
  }

  /** The watcher's read: each repo with `contributor_prs` on, its quiet window and open PRs (one repo's failure is its `error`). */
  async prRepos() {
    if (this.repos instanceof Error) throw new GitHubRefused(`maintainer_repos is invalid: ${this.repos.message}`);
    const out: { repo: string; stale_days: number; prs?: MaintainerPr[]; error?: string }[] = [];
    for (const r of this.repos.filter((x) => x.contributor_prs)) {
      try {
        out.push({ repo: r.repo, stale_days: r.stale_days, prs: (await this.prList(r.repo)).prs });
      } catch (err) {
        out.push({ repo: r.repo, stale_days: r.stale_days, error: (err as Error).message.slice(0, 300) });
      }
    }
    return { repos: out };
  }

  /** The repository's file list at a ref, capped in entries and depth. */
  async repoTree(repo: string | undefined, ref = "HEAD") {
    const { owner, name, repo: slug } = this.target(repo);
    noDots(ref);
    const r = await this.gh.rest("GET", `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (r.status !== 200) throw new Error(`couldn't read ${owner}/${name}'s tree at ${ref} (GitHub said ${r.status})`);
    const all = (Array.isArray(r.body.tree) ? r.body.tree : []) as { path: string; type: string; size?: number; sha?: string }[];
    const kept = all.filter((e) => e.path.split("/").length <= TREE_DEPTH).slice(0, TREE_CAP);
    return {
      repo: slug,
      ref,
      truncated: r.body.truncated === true || kept.length < all.length,
      entries: kept.map((e) => ({ path: e.path, type: e.type, ...(e.size != null ? { size: e.size } : {}), ...(e.sha ? { sha: e.sha } : {}) })),
    };
  }

  /** One file at a ref, base64-decoded; over the byte cap it errors rather than truncating. */
  async repoFile(repo: string | undefined, path: string, ref?: string) {
    const { owner, name, repo: slug } = this.target(repo);
    // Resolve the ref to a commit first, and read the file at that commit: the contents API's own `sha` is the blob's, which
    // no caller can resolve as a commit, and a branch could move between the two reads.
    noDots(path);
    noDots(ref ?? "HEAD");
    const commit = await this.commitSha(owner, name, ref ?? "HEAD");
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const r = await this.gh.rest("GET", `/repos/${owner}/${name}/contents/${encoded}?ref=${commit}`);
    if (r.status !== 200) throw new Error(`couldn't read ${owner}/${name}/${path} (GitHub said ${r.status})`);
    if (Array.isArray(r.body)) throw new GitHubRefused(`${path} is a directory; use github_repo_tree`);
    if (r.body.encoding !== "base64" || typeof r.body.content !== "string") throw new Error(`${path} has no inline content (the contents API omits files over 1 MB)`);
    const buf = Buffer.from(r.body.content, "base64");
    if (buf.length > FILE_CAP) throw new GitHubRefused(`${path} is ${buf.length} bytes, over the ${FILE_CAP}-byte cap`);
    return { repo: slug, path, ref: commit, blob_sha: r.body.sha, size: buf.length, text: buf.toString("utf8") };
  }

  /** The commit a branch, tag, sha or HEAD names, or an error naming the ref and GitHub's answer. */
  private async commitSha(owner: string, name: string, ref: string) {
    const r = await this.gh.rest("GET", `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`);
    if (r.status !== 200 || typeof r.body?.sha !== "string") {
      throw new Error(`couldn't resolve ${owner}/${name} at ${ref} to a commit (GitHub said ${r.status}${r.body?.message ? `: ${r.body.message}` : ""})`);
    }
    return r.body.sha as string;
  }

  /**
   * The issue's current repo label, whether it is a pull request, and, when present, whether its latest label event is
   * trusted. A pull request shares the issue number and is marked by `pull_request` on the same read.
   */
  private async currentLabel(r: MaintainedRepo, number: number) {
    const res = await this.gh.rest("GET", `/repos/${r.owner}/${r.name}/issues/${number}`);
    if (res.status !== 200) throw new Error(`couldn't read ${r.repo}#${number} (GitHub said ${res.status})`);
    const issue = res.body as GhIssue;
    const labels = labelNames(issue);
    const pull_request = Boolean(issue.pull_request);
    const present = labels.some((l) => same(l, r.label));
    if (!present) return { present: false, trusted: true, event: undefined as LabelEvent | undefined, labels, pull_request };
    const { events } = await this.labelEvents(r.repo, number, r.label);
    const latest = this.latestLabel(r, events);
    return { present: true, trusted: Boolean(latest?.trusted), event: latest, labels, pull_request };
  }

  /** Refuses a write on an issue whose current repo label is untrusted. */
  private async assertTrusted(r: MaintainedRepo, number: number) {
    const cur = await this.currentLabel(r, number);
    if (cur.present && !cur.trusted) {
      const who = cur.event?.actor ?? cur.event?.app_slug ?? "an unknown actor";
      throw new GitHubRefused(`#${number}'s ${r.label} label is untrusted (added by ${who}); refusing to act on it`);
    }
    return cur;
  }

  /** The comment text with owner data removed; anything the rewrite can't reach refuses it. */
  private scrubbed(r: MaintainedRepo, body: string): string {
    return this.scrubWith(this.termsFor(r), body);
  }

  private scrubWith(terms: string[], body: string): string {
    return publicText(body, terms, "comment");
  }

  /**
   * The body `github_issue_comment` posts on `repo`: on a maintained repo it is scrubbed and refused while the issue's repo
   * label is untrusted; on the product repo it is scrubbed; on any other repo it goes as written.
   */
  async commentBody(repo: string, number: number, body: string, product?: string): Promise<string> {
    const r = this.list().find((x) => same(x.repo, repo));
    if (r) {
      const text = this.scrubbed(r, body);
      await this.assertTrusted(r, number);
      return text;
    }
    if (product && same(product, repo)) return this.scrubWith(this.terms.filter((t) => !same(t, product.split("/")[0]!)), body);
    return body;
  }

  /** One already-scrubbed comment as the owner. */
  private async postComment(r: MaintainedRepo, number: number, text: string) {
    const res = await this.gh.rest("POST", `/repos/${r.owner}/${r.name}/issues/${number}/comments`, { body: text });
    // The status rides on the error: a 5xx may still have created the comment (a gateway answered, not GitHub), so it is not a refusal.
    if (res.status !== 201) throw Object.assign(new Error(`GitHub refused the comment (${res.status} ${res.body?.message ?? ""})`.trim()), { status: res.status });
    return {
      repo: r.repo,
      number,
      url: res.body.html_url,
      id: Number(res.body.id),
      createdAt: String(res.body.created_at ?? ""),
      objects: [`${this.ref(r, number)}/comment/${res.body.id}`],
    };
  }

  /**
   * Add or remove the repo's fix label or `feature-request`, and nothing else (`agent-build` is a trusted collaborator's, never
   * this tool's), refusing an issue whose current fix label is untrusted.
   */
  async label(repo: string | undefined, number: number, action: "add" | "remove", label?: string) {
    const r = this.target(repo);
    if (label !== undefined && same(label, BUILD_LABEL)) throw new GitHubRefused(`${BUILD_LABEL} is the owner's label`);
    const which = label === undefined || same(label, r.label) ? r.label : same(label, FEATURE_LABEL) ? FEATURE_LABEL : undefined;
    if (!which) throw new GitHubRefused(`only the ${r.label} and ${FEATURE_LABEL} labels may be changed on ${r.repo}`);
    const cur = await this.assertTrusted(r, number);
    const present = cur.labels.some((l) => named(l, which));
    const out = (changed: boolean) => ({ repo: r.repo, number, label: which, action, changed,  });
    if (action === "add") {
      if (present) return out(false);
      const res = await this.gh.rest("POST", `/repos/${r.owner}/${r.name}/issues/${number}/labels`, { labels: [which] });
      if (res.status !== 200) throw new Error(`GitHub refused the label (${res.status} ${res.body?.message ?? ""})`.trim());
      return out(true);
    }
    if (!present) return out(false);
    const res = await this.gh.rest("DELETE", `/repos/${r.owner}/${r.name}/issues/${number}/labels/${encodeURIComponent(which)}`);
    if (res.status !== 200) throw new Error(`GitHub refused the label removal (${res.status} ${res.body?.message ?? ""})`.trim());
    return out(true);
  }

  /** The key a posted close note is remembered under: the same call's retry has the same one. */
  private static noteKey(r: MaintainedRepo, number: number, state: "open" | "closed", text: string) {
    return `${r.repo.toLowerCase()}#${number}:${state}:${text}`;
  }

  /** Runs `fn` alone for `key`: a second, overlapping close of the same note waits for the first to finish and then reuses what
   * the first posted. A waiter that cannot still fit a write in its own tool budget fails as `write_busy` before it starts,
   * rather than waiting out the first call and then running its reads and its write after its caller was told it failed. */
  private async withNoteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.noteLocks.get(key) ?? Promise.resolve();
    // No budget (a background or test call) or room for one more attempt: go straight through, as before.
    if (!prev || writeBudgetDeadline() === undefined) return this.runNoteLock(key, prev, fn);
    const raced = await Promise.race([
      prev.catch(() => {}).then(() => "free" as const),
      new Promise<"spent">((resolve) => {
        const left = writeBudgetDeadline()! - Date.now() - 30_000;
        const t = setTimeout(() => resolve("spent"), Math.max(left, 0));
        if (typeof t === "object" && "unref" in t) t.unref();
      }),
    ]);
    if (raced === "spent" || writeBudgetSpent()) throw new GitHubNeed({ cause: "write_busy" });
    return this.runNoteLock(key, prev, fn);
  }

  /** Queues `fn` behind `prev` for `key` and clears the entry when it is the last one. */
  private async runNoteLock<T>(key: string, prev: Promise<unknown>, fn: () => Promise<T>): Promise<T> {
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.noteLocks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.noteLocks.get(key) === tail) this.noteLocks.delete(key);
    }
  }

  /** Remembers a posted note so a retry posts it once. A confirmed record is forgotten after the short TTL; one whose POST or
   * state change is still unconfirmed is kept until `retainUntil` (which a refusal's own `until` extends), so a retry inside
   * the advertised window still finds it. Only a record past both goes, oldest first, and the cap never evicts a live one. */
  private rememberNote(key: string, rec: NoteRecord) {
    this.noted.delete(key);
    this.noted.set(key, rec);
    const at = Date.now();
    for (const [k, v] of this.noted) {
      const live = !v.confirmed || v.retainUntil > at;
      if (live ? at - v.at > Maintainer.NOTED_KEEP_MS : at - v.at > Maintainer.NOTED_TTL_MS) this.noted.delete(k);
    }
    while (this.noted.size > Maintainer.NOTED_CAP) {
      const oldest = [...this.noted].filter(([, v]) => v.confirmed).sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.noted.delete(oldest[0]);
    }
  }

  /** The issue as GitHub returns it. A read that fails throws, and so does a 200 whose body carries no usable state: that state
   * decides whether a note is reused and whether the state change is skipped, so guessing it could post a second note, skip a
   * needed close, or send the PATCH this change means to avoid. */
  private async issue(r: MaintainedRepo, number: number): Promise<{ state: "open" | "closed"; state_reason?: string | null; pull_request?: unknown }> {
    const res = await this.gh.rest("GET", `/repos/${r.owner}/${r.name}/issues/${number}`);
    if (res.status !== 200) throw new Error(`couldn't read ${r.repo}#${number}'s state (GitHub said ${res.status})`);
    const state = res.body?.state;
    if (state !== "open" && state !== "closed")
      throw new Error(`couldn't read ${r.repo}#${number}'s state (GitHub answered ${res.status} without a state)`);
    return { ...res.body, state };
  }

  /** The issue's current state. */
  private async issueState(r: MaintainedRepo, number: number): Promise<string> {
    return (await this.issue(r, number)).state;
  }

  /** Every page of the issue's timeline, refusing one longer than the page cap: a part read could hide a reopen after the
   * note, which would reuse the note for a new close. */
  private async timeline(r: MaintainedRepo, number: number): Promise<any[]> {
    const events: any[] = [];
    let page = 1;
    for (; page <= PAGE_CAP; page++) {
      const res = await this.gh.rest("GET", `/repos/${r.owner}/${r.name}/issues/${number}/timeline?per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't read ${r.repo}#${number}'s timeline (GitHub said ${res.status})`);
      const items = (Array.isArray(res.body) ? res.body : []) as any[];
      events.push(...items);
      if (items.length < 100) break;
    }
    if (page > PAGE_CAP) throw new GitHubRefused(`#${number}'s timeline is longer than ${PAGE_CAP * 100} events, so whether it was reopened since the note can't be read; refusing to guess`);
    return events;
  }

  /**
   * Whether GitHub recorded a reopen after the note `rec` posted. A close whose note was this one ends at that reopen: anything
   * closed after it is a new close and gets its own note. The order is GitHub's own: the note's `commented` event's position in
   * the timeline when GitHub lists it there, otherwise the events stamped at or after the comment's own `created_at`. A timeline
   * that can't be read throws, and is never read as "nothing happened since" (that would reuse a note for a new close).
   */
  private async reopenedAfter(r: MaintainedRepo, number: number, rec: NoteRecord): Promise<boolean> {
    const events = await this.timeline(r, number);
    const at = events.findIndex((e) => e?.event === "commented" && Number(e?.id) === rec.id);
    if (at >= 0) return events.slice(at + 1).some((e) => e?.event === "reopened");
    const created = Date.parse(rec.createdAt);
    if (!Number.isFinite(created)) throw new GitHubRefused(`#${number}'s note has no time GitHub can order its events against`);
    return events.some((e) => e?.event === "reopened" && Date.parse(String(e.created_at ?? "")) >= created);
  }

  /**
   * Whether a note this process posted still stands for this close: a reopen has not happened since, and either the state change
   * was confirmed and the issue is still in that state, or it was not confirmed (its PATCH may have landed without an answer, so
   * the retry sends only the state change). Otherwise this is a new close, which posts its own note.
   */
  private async noteApplies(r: MaintainedRepo, number: number, rec: NoteRecord): Promise<boolean> {
    const state = await this.issueState(r, number);
    if (await this.reopenedAfter(r, number, rec)) return false;
    if (!rec.confirmed) return true;
    return state === "closed";
  }

  /**
   * Close as completed or not_planned, or reopen, refusing an untrusted label. A `note` is posted as a comment first, with
   * the same owner-data scrub as `comment` and signed by `agent` (the AidenHQ footer), and the state changes only once it is posted. A note citing a PR only as a bare
   * "PR #N" is refused before anything is written: the grader's citation parser doesn't read it.
   *
   * The note goes once, and this process records the comment it posted (id, GitHub's `created_at`) keyed by the issue, the state
   * and the note's text; no comment on the issue (whose author this can't verify) can suppress a note. A retry whose note was
   * not confirmed sends only the state change, unless GitHub recorded a reopen after the note (a new close, its own note). A
   * confirmed close is reused while the issue is still closed with no reopen since. Both decisions read the issue's state and
   * the timeline, and a failed read throws rather than guessing: guessing would post the note twice or skip a new one.
   *
   * The state change itself reads the issue first and is skipped when it is already in the requested state: a PR the code host
   * closed, or an issue it reopened. A close on an already-closed issue also carries a reason, so it is skipped only when GitHub
   * already records the requested one (a different one is PATCHed); a PR's reason cannot be changed, so a closed PR is settled
   * whatever was asked. The note is then the whole write, and the answer reports its id and URL. A failed read, including a 200
   * without a state, throws.
   */
  async state(repo: string | undefined, number: number, state: "open" | "closed", reason?: "completed" | "not_planned", note?: string, agent = "AidenHQ") {
    const r = this.target(repo);
    if (note !== undefined && state === "open") throw new GitHubRefused("a note is posted only when closing");
    if (note !== undefined) {
      const bad = noteProblem(note, state, reason);
      if (bad) throw new GitHubRefused(bad);
    }
    const text = note === undefined ? undefined : this.scrubbed(r, note);
    const key = text === undefined ? undefined : Maintainer.noteKey(r, number, state, text);
    // The note goes once. The decision, the post and the state change run under the key's lock, so an overlapping close of the
    // same note waits for the first to finish and then reuses it instead of posting a duplicate. A retry of the same call (the
    // note posted, the state change not confirmed) reuses it too; a close after a reopen posts its own. The record is this
    // process's own, so no comment on the issue (whose author this can't verify) can suppress a note.
    if (key === undefined) {
      await this.assertTrusted(r, number);
      return this.applyState(r, number, state, reason);
    }
    return this.withNoteLock(key, async () => {
      // The gate is rechecked here, after any wait for another close of the same note: a label that turned untrusted while this
      // call was queued must stop it before it posts or changes anything.
      await this.assertTrusted(r, number);
      const spec: NoteSpec = { text: text!, state, agent };
      const earlier = this.noted.get(key);
      // A record with no comment id is a POST whose answer was lost: find it on the issue before considering another one.
      const rec = earlier && earlier.id === 0
        ? await this.reconcilePosted(r, number, key, earlier)
        : earlier && (await this.noteApplies(r, number, earlier))
          ? earlier
          : await this.postNote(r, number, key, spec);
      const out = await this.applyState(r, number, state, reason, rec);
      this.rememberNote(key, { ...rec, confirmed: true });
      return out;
    });
  }

  /** A fresh marker for one POST attempt, carried in its body and kept in its pending record so a retry can find that exact
   * comment. It must be new for each attempt: an earlier close of the same note (before a reopen) carries its own marker, and a
   * later attempt must never take that comment for its own. */
  private static noteMarker(r: MaintainedRepo, number: number, spec: NoteSpec) {
    return createHash("sha256").update(`${r.repo.toLowerCase()}#${number}:${spec.state}:${spec.agent}:${spec.text}:${randomUUID()}`).digest("hex").slice(0, 32);
  }

  /** Every comment on the issue, refusing one longer than the page cap: a part read cannot prove a marker absent, and treating it
   * as absent would post the note again. */
  private async allComments(r: MaintainedRepo, number: number): Promise<any[]> {
    const out: any[] = [];
    let page = 1;
    for (; page <= PAGE_CAP; page++) {
      const res = await this.gh.rest("GET", `/repos/${r.owner}/${r.name}/issues/${number}/comments?per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't read ${r.repo}#${number}'s comments (GitHub said ${res.status})`);
      // A non-array body is not "no comments": a gateway's 200 with something else would otherwise prove the note absent and
      // post it a second time. It cannot be read, so it throws like a failed read.
      if (!Array.isArray(res.body)) throw new Error(`${r.repo}#${number}'s comments came back in a shape GitHub doesn't send, so whether the note is on the issue can't be read`);
      const items = res.body as any[];
      out.push(...items);
      if (items.length < 100) break;
    }
    if (page > PAGE_CAP) throw new GitHubRefused(`#${number} has more than ${PAGE_CAP * 100} comments, so whether the note is on it can't be read; refusing to post it again`);
    return out;
  }

  /** The comment a marker names, when one is on the issue: a lost POST's answer is reconciled through it rather than posting
   * the same note a second time. A read that fails or stops at the page cap throws (it cannot prove the note absent). */
  private async findByMarker(r: MaintainedRepo, number: number, marker: string) {
    const tag = `<!-- aidenhq-note:${marker} -->`;
    const comments = await this.allComments(r, number);
    const hit = comments.find((c) => String(c?.body ?? "").includes(tag));
    return hit ? { id: Number(hit.id), url: String(hit.html_url ?? ""), createdAt: String(hit.created_at ?? "") } : undefined;
  }

  /** The body every post of this note carries: the signed note and the marker that identifies it. */
  private static noteBody(spec: NoteSpec, marker: string) {
    return `${withFooter(spec.text, spec.agent)}\n\n<!-- aidenhq-note:${marker} -->`;
  }

  /** Posts this call's note and records it (unconfirmed) before the POST answers, so a retry or an overlapping close reuses it.
   * A lost POST answer leaves a record with no comment id, and the retry reconciles it by the marker on the issue. */
  private async postNote(r: MaintainedRepo, number: number, key: string, spec: NoteSpec): Promise<NoteRecord> {
    const marker = Maintainer.noteMarker(r, number, spec);
    const pending: NoteRecord = {
      id: 0,
      url: "",
      objects: [],
      confirmed: false,
      createdAt: "",
      at: Date.now(),
      spec,
      marker,
      retainUntil: Date.now() + Maintainer.NOTED_KEEP_MS,
    };
    this.rememberNote(key, pending);
    try {
      const p = await this.postComment(r, number, Maintainer.noteBody(spec, marker));
      const rec: NoteRecord = { ...pending, id: p.id, url: p.url, createdAt: p.createdAt, objects: p.objects };
      this.rememberNote(key, rec);
      return rec;
    } catch (e) {
      // The note may or may not have landed (a dropped connection, or a gateway's 5xx on a POST GitHub may have saved). The
      // pending record stays, so a retry reconciles by its marker first rather than posting a second copy.
      if (ambiguous(e)) throw new Error("whether the note posted is unknown (the answer was lost); call this again with the same state and note, and this will reuse it if it landed");
      this.noted.delete(key);
      throw e;
    }
  }

  /** Settles a note whose POST answer was lost: the marker's comment is this note if it is on the issue, and only if it is not
   * does the retry post it. A comment read that fails throws (it cannot prove the note absent). */
  private async reconcilePosted(r: MaintainedRepo, number: number, key: string, pending: NoteRecord): Promise<NoteRecord> {
    let known: Awaited<ReturnType<Maintainer["findByMarker"]>>;
    try {
      known = await this.findByMarker(r, number, pending.marker);
    } catch (e) {
      // Without a complete read the note may be on the issue: posting again could duplicate it, so the outcome stays unresolved.
      // A typed need keeps its cause and fields (a rate limit keeps its `until`), with the unknown outcome added to its text.
      if (e instanceof GitHubNeed) throw new GitHubNeed(e.need, `${e.message}. Whether the earlier note posted is still unknown, and it can't be checked; read the issue's comments before retrying`);
      throw new Error(`whether the earlier note posted is still unknown, and it can't be checked (${(e as Error).message}); read the issue's comments before retrying`);
    }
    // A new POST attempt gets its own marker: the earlier attempt's was proven absent, and reusing it could match a comment
    // from an earlier close of the same note.
    if (!known) return this.postNote(r, number, key, pending.spec);
    const rec: NoteRecord = { ...pending, id: known.id, url: known.url, createdAt: known.createdAt, objects: [`${this.ref(r, number)}/comment/${known.id}`] };
    this.rememberNote(key, rec);
    return rec;
  }

  /** The state change that follows the note, or the only write when there is none. */
  private async applyState(r: MaintainedRepo, number: number, state: "open" | "closed", reason?: "completed" | "not_planned", noteObj?: NoteRecord) {
    const url = noteObj?.url;
    const body = state === "closed" ? { state, state_reason: reason ?? "completed" } : { state };
    /** What a caller must hear when the note is on the issue and a known refusal stopped the state change. */
    const reset = `the note was posted${url ? ` (${url})` : ""}; the state change to ${state} did not complete — call this again with the same state and no note`;
    /** A lost answer: GitHub may have applied the close. Telling the caller to send the PATCH again could close an issue a
     * maintainer reopened in between, so say the outcome is unknown and let it decide from the issue's state. */
    const unknown = `whether the state change to ${state} landed is unknown (the answer was lost)${url ? `; the note was posted (${url})` : ""} — read the issue's state before retrying`;
    let cur: Awaited<ReturnType<Maintainer["issue"]>>;
    try {
      cur = await this.issue(r, number);
    } catch (e) {
      // Without the read there is no way to know whether the PATCH is needed: fail closed, with the note's outcome added to the
      // message, rather than guess at the state.
      if (e instanceof GitHubNeed) {
        const when = e.need.cause === "rate_limited" ? ` after ${e.need.until}` : "";
        if (e.need.cause === "rate_limited" && e.need.until) this.extendRetention(noteObj, Date.parse(e.need.until));
        throw new GitHubNeed(e.need, `${e.message}. ${url ? reset : `the state change to ${state} did not complete`}${when}`);
      }
      if (url) throw new Error(`${(e as Error).message}. ${reset}`.trim());
      throw e;
    }
    // Already where the caller asked it to be: a PR the code host closed, or an issue it reopened. The note is this call's whole
    // write; a PATCH would only be refused (GitHub rejects a state_reason on a closed PR with a 403) or undo an intervening
    // change. Report the state as GitHub has it, unchanged. A close's `reason` is part of what is asked for, but only on an issue:
    // GitHub accepts a reason change on an already-closed issue, so a different one still goes through the PATCH below. A PR's
    // reason cannot be changed (that PATCH is the 403), so a closed PR is settled whatever reason was asked for.
    const settled = cur.pull_request !== undefined || state === "open" || cur.state_reason === (reason ?? "completed");
    if (cur.state === state && settled)
      return {
        repo: r.repo,
        number,
        state: cur.state,
        state_reason: cur.state_reason ?? null,
        ...(noteObj ? { note: { id: noteObj.id, url: noteObj.url }, objects: noteObj.objects } : {}),
      };
    let res: Awaited<ReturnType<GitHubAccess["rest"]>>;
    try {
      res = await this.gh.rest("PATCH", `/repos/${r.owner}/${r.name}/issues/${number}`, body);
    } catch (e) {
      // The need stays typed (its cause and fields, and the kernel's needs_owner routing), with the note's outcome added to its
      // text. A retry is safe whatever reaches the agent: the record above keeps the note from being posted again.
      if (e instanceof GitHubNeed) {
        const when = e.need.cause === "rate_limited" ? ` after ${e.need.until}` : "";
        if (e.need.cause === "rate_limited" && e.need.until) this.extendRetention(noteObj, Date.parse(e.need.until));
        throw new GitHubNeed(e.need, `${e.message}. ${url ? reset : `the state change to ${state} did not complete`}${when}`);
      }
      if (lostAnswer(e)) throw new Error(`GitHub didn't answer the state change to ${state}: ${unknown}`);
      if (url) throw new Error(`${(e as Error).message}. ${reset}`.trim());
      throw e;
    }
    // A gateway's 5xx may still have applied the change (GitHub answered through a proxy that then failed): the outcome is
    // unknown, and telling the caller to PATCH again could undo a reopen in between.
    if (res.status >= 500) throw new Error(`GitHub answered the state change to ${state} with ${res.status}: ${unknown}`);
    // A refusal that isn't a typed need (a 422 and the like) leaves the note posted just the same: say so, or a retry doubles it.
    if (res.status !== 200) throw new Error(`GitHub refused the state change (${res.status} ${res.body?.message ?? ""})${url ? `. ${reset}` : ""}`.trim());
    // The comment is this call's own GitHub object whether it posted it or reused it: the kernel records it for provenance.
    return { repo: r.repo, number, state: res.body.state, state_reason: res.body.state_reason ?? null, ...(noteObj ? { objects: noteObj.objects } : {}) };
  }

  /** Keeps an unconfirmed record at least until `until` (a refusal's advertised reset), so a retry then still finds it. */
  private extendRetention(noteObj: NoteRecord | undefined, until: number) {
    if (!noteObj || !Number.isFinite(until)) return;
    noteObj.retainUntil = Math.max(noteObj.retainUntil, until + Maintainer.NOTED_KEEP_MS);
  }

  /**
   * The Maintainer's bootstrap read (its watcher's start, a feed gap or resync; `only` names the repos to read, else every listed one): per listed repo, the open issues carrying its
   * fix label (`issues` duty on), and, with `features` on, those carrying agent-build (`builds`) and the trusted
   * feature-request ones (`featured`, which the per-author triage cap leaves uncounted). One repo's failure is its `error` and
   * holds up no other. A label-event read that failed is also an `error`: the bootstrap is retried rather than commit over an
   * issue it never read. Read-only, no model call.
   */
  async bootstrap(only?: string[]) {
    if (this.repos instanceof Error) throw new GitHubRefused(`maintainer_repos is invalid: ${this.repos.message}`);
    type Read = Awaited<ReturnType<Maintainer["repoSince"]>>;
    type Row = { repo: string; issues?: Read["issues"]; builds?: Read["issues"]; featured?: number[]; incomplete?: string; error?: string };
    const out: Row[] = [];
    for (const r of this.repos.filter((x) => !only || only.some((o) => same(o, x.repo)))) {
      const row: Row = { repo: r.repo };
      // What was read is always handed over; an issue whose label events failed to read marks the repo `incomplete`, so it is read again.
      const part = async (label: string | undefined) => {
        const read = await this.repoSince(r.repo, label);
        const unread = read.skipped.filter((s) => s.unread);
        if (unread.length) row.incomplete = `${row.incomplete ? `${row.incomplete}; ` : ""}${label ?? r.label}: ${unread.length} issue(s) whose label events couldn't be read (${unread[0]!.reason})`.slice(0, 300);
        return read.issues;
      };
      try {
        if (r.issues) row.issues = await part(undefined);
        if (r.features) {
          row.builds = await part(BUILD_LABEL);
          row.featured = (await part(FEATURE_LABEL)).map((i) => i.number);
        }
      } catch (err) {
        row.error = (err as Error).message.slice(0, 300);
      }
      out.push(row);
    }
    return { repos: out };
  }

  /**
   * One open issue as the Maintainer's watcher files it, after a feed event named its label: the issue as it stands now, with
   * its label's latest event and trust verdict (the event's own actor never decides). `issue` is null when the issue is closed,
   * a pull request, or no longer carries the label. A read that fails throws, so the watcher's batch is redelivered.
   */
  async oneIssue(repo: string | undefined, number: number, label?: string) {
    const r = this.target(repo);
    const asked = label ?? r.label;
    const res = await this.gh.rest("GET", `/repos/${r.owner}/${r.name}/issues/${number}`);
    if (res.status !== 200) throw new Error(`couldn't read ${r.repo}#${number} (GitHub said ${res.status})`);
    const i = res.body as GhIssue & { state?: string };
    if (i.pull_request || i.state !== "open" || !labelNames(i).some((l) => named(l, asked))) return { repo: r.repo, number, issue: null };
    let latest: LabelEvent | undefined;
    try {
      latest = this.latestLabel(r, (await this.labelEvents(r.repo, number, asked)).events, asked);
    } catch (err) {
      // A timeline that can never be read (past the page cap) is a definite no, never a retry that would stall the watcher's feed.
      if (err instanceof GitHubRefused) return { repo: r.repo, number, issue: null, refused: err.message.slice(0, 200) };
      throw err;
    }
    if (!latest) return { repo: r.repo, number, issue: null };
    return { repo: r.repo, number, issue: { number, trusted: latest.trusted, labeled_at: latest.created_at, actor: latest.actor ?? latest.app_slug ?? null, created_at: i.created_at, labels: labelNames(i) } };
  }

  /**
   * One repo's open issues carrying `label` (default the repo's), each with its trust verdict, plus the untrusted and unreadable
   * ones in `skipped` (`unread`: the label events couldn't be read). Every page is read, and past the page cap the read refuses
   * rather than guess.
   */
  async repoSince(repo: string, label?: string) {
    const r = this.target(repo);
    const asked = label ?? r.label;
    const { owner, name } = r;
    const listed: GhIssue[] = [];
    let page = 1;
    for (; page <= PAGE_CAP; page++) {
      const res = await this.gh.rest("GET", `/repos/${owner}/${name}/issues?state=open&labels=${encodeURIComponent(asked)}&per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't list ${owner}/${name}'s issues (GitHub said ${res.status})`);
      const pageIssues = (Array.isArray(res.body) ? res.body : []) as GhIssue[];
      listed.push(...pageIssues);
      if (pageIssues.length < 100) break;
    }
    if (page > PAGE_CAP) throw new GitHubRefused(`${owner}/${name} has more than ${PAGE_CAP * 100} open ${asked} issues; refusing to read only part of them`);
    const issues: { number: number; trusted: boolean; labeled_at: string; actor: string | null; created_at?: string; labels: string[] }[] = [];
    const skipped: { number: number; reason: string; unread?: true }[] = [];
    const seen = new Set<number>();
    for (const i of listed) {
      if (i.pull_request || seen.has(i.number)) continue;
      seen.add(i.number);
      try {
        const { events } = await this.labelEvents(r.repo, i.number, asked);
        const latest = this.latestLabel(r, events, asked);
        if (!latest) {
          skipped.push({ number: i.number, reason: `no ${asked} label event` });
          continue;
        }
        if (!latest.trusted) {
          skipped.push({ number: i.number, reason: latest.stale ? `#${i.number} was edited after ${asked} was added; the owner relabels it to approve it again` : `${asked} label added by ${latest.actor ?? latest.app_slug ?? "an unknown actor"}, not a trusted collaborator` });
          continue;
        }
        issues.push({ number: i.number, trusted: true, labeled_at: latest.created_at, actor: latest.actor ?? latest.app_slug ?? null, created_at: i.created_at, labels: labelNames(i) });
      } catch (err) {
        // A refusal (a timeline past the page cap) is permanent: skipped like an untrusted label. Anything else is a failed read, retried.
        skipped.push({ number: i.number, reason: `could not read its label events: ${(err as Error).message.slice(0, 120)}`, ...(err instanceof GitHubRefused ? {} : { unread: true as const }) });
      }
    }
    return { issues, skipped };
  }
}

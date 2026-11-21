// The Maintainer's GitHub tools, as the owner, on the repos the instance lists in `maintainer_repos` and no other: open
// issues carrying a repo's label, their label events with a trust verdict, the repo tree and one file, and the three writes
// (comment, label, state). A label is trusted only when a collaborator whose role is one of that repo's `trusted` roles added
// it (the owner's login is an admin, so its labels count); the issue's text or author never decide trust.
import { GitHubRefused } from "./github.js";
import { scrubProblems, scrubText } from "./scrub.js";
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
// How many new unlabelled issues one look hands the board's watcher per repo (each is one triage run): the rest come on the
// next look, so a burst of reports is spread out rather than started at once.
const TRIAGE_BATCH = 10;
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

export class Maintainer {
  private roles = new Map<string, { role: string | null; at: number }>();

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
    return { repo: r.repo, label: asked, trusted_roles: r.trusted, after_merge: r.after_merge, features: r.features, issues };
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
    const text = scrubText(body, terms);
    const left = scrubProblems(text, terms);
    if (left.length) throw new GitHubRefused(`owner data can't go into a public comment; redact these and try again: ${left.join("; ")}`);
    return text;
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
    if (res.status !== 201) throw new Error(`GitHub refused the comment (${res.status} ${res.body?.message ?? ""})`.trim());
    return { repo: r.repo, number, url: res.body.html_url, id: res.body.id, objects: [`${this.ref(r, number)}/comment/${res.body.id}`] };
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

  /**
   * Close as completed or not_planned, or reopen, refusing an untrusted label. A `note` is posted as a comment first, with
   * the same owner-data scrub as `comment` and signed by `agent` (the AidenHQ footer), and the state changes only once it is posted. A note citing a PR only as a bare
   * "PR #N" is refused before anything is written: the grader's citation parser doesn't read it.
   */
  async state(repo: string | undefined, number: number, state: "open" | "closed", reason?: "completed" | "not_planned", note?: string, agent = "AidenHQ") {
    const r = this.target(repo);
    if (note !== undefined && state === "open") throw new GitHubRefused("a note is posted only when closing");
    if (note !== undefined) {
      const bad = noteProblem(note, state, reason);
      if (bad) throw new GitHubRefused(bad);
    }
    const text = note === undefined ? undefined : this.scrubbed(r, note);
    await this.assertTrusted(r, number);
    const posted = text === undefined ? undefined : await this.postComment(r, number, withFooter(text, agent));
    const body = state === "closed" ? { state, state_reason: reason ?? "completed" } : { state };
    const res = await this.gh.rest("PATCH", `/repos/${r.owner}/${r.name}/issues/${number}`, body);
    if (res.status !== 200) throw new Error(`GitHub refused the state change (${res.status} ${res.body?.message ?? ""})`.trim());
    return { repo: r.repo, number, state: res.body.state, state_reason: res.body.state_reason ?? null, ...(posted ? { objects: posted.objects } : {}) };
  }

  /**
   * The board watcher's read: every listed repo, each from its own cursor (`cursors[repo]`). One repo's failure is its
   * `error` and never holds up another's. With `triage` (the triage cursors, when the board triages each new issue), each
   * repo also carries its new unlabelled issues (`untriaged`, `triage_cursor`), or `triage_error` without failing the rest.
   */
  async issuesSince(cursors: Record<string, string> = {}, triage?: Record<string, string>, builds: Record<string, string> = {}) {
    if (this.repos instanceof Error) throw new GitHubRefused(`maintainer_repos is invalid: ${this.repos.message}`);
    type Triage = Partial<Awaited<ReturnType<Maintainer["untriaged"]>>> & { triage_error?: string };
    // A repo with `features` on also brings its issues labelled agent-build (`builds`, from its own cursor `build_cursor`).
    type Build = { builds?: Awaited<ReturnType<Maintainer["repoSince"]>>["issues"]; build_cursor?: string | null; build_error?: string; featured?: number[] };
    type Row = ({ repo: string; error: string } | ({ repo: string } & Awaited<ReturnType<Maintainer["repoSince"]>>)) & Triage & Build;
    const out: Row[] = [];
    const at = (m: Record<string, string>, repo: string) => Object.entries(m).find(([k]) => same(k, repo))?.[1];
    for (const r of this.repos) {
      let row: Row;
      try {
        row = { repo: r.repo, ...(r.issues ? await this.repoSince(r.repo, at(cursors, r.repo)) : { issues: [], skipped: [], cursor: at(cursors, r.repo) ?? null }) };
      } catch (err) {
        row = { repo: r.repo, error: (err as Error).message.slice(0, 300) };
      }
      if (r.features) {
        try {
          const b = await this.repoSince(r.repo, at(builds, r.repo), BUILD_LABEL);
          Object.assign(row, { builds: b.issues, build_cursor: b.cursor });
        } catch (err) {
          row.build_error = (err as Error).message.slice(0, 300);
        }
        // Unread, the day's feature requests count as invalid until the next tick reads them.
        row.featured = await this.recentFeatureRequests(r.repo).catch(() => undefined);
      }
      if (triage && (r.issues || r.features)) {
        try {
          Object.assign(row, await this.untriaged(r.repo, at(triage, r.repo)));
        } catch (err) {
          row.triage_error = (err as Error).message.slice(0, 300);
        }
      }
      out.push(row);
    }
    return { repos: out };
  }

  /**
   * The numbers of the issues labelled feature-request (by a trusted labeler) in the last day, open or closed: the watcher's valid reports that
   * its per-author triage cap leaves uncounted. Counted only when the label's latest event passes the same trust check as the
   * fix label (a collaborator with a trusted role): a template or a stranger can't self-exempt.
   */
  async recentFeatureRequests(repo: string): Promise<number[]> {
    const r = this.target(repo);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await this.gh.rest("GET", `/repos/${r.owner}/${r.name}/issues?state=all&labels=${FEATURE_LABEL}&since=${since}&per_page=100`);
    if (res.status !== 200) throw new Error(`couldn't list ${r.repo}'s feature requests (GitHub said ${res.status})`);
    const trusted: number[] = [];
    for (const i of ((Array.isArray(res.body) ? res.body : []) as GhIssue[]).filter((i) => !i.pull_request)) {
      const { latest } = await this.latestOrError(r, i.number, FEATURE_LABEL);
      if (latest?.trusted) trusted.push(i.number);
    }
    return trusted;
  }

  /**
   * One repo's open issues opened after `since` that carry no repo label (the fleet's own product bugs
   * included): the reports the Maintainer triages one by one. Oldest first, at most TRIAGE_BATCH; `triage_cursor`
   * is the newest one read (the last one handed over when the batch is full). With no `since` (the first look) nothing is
   * handed over and the cursor is now: reports already open are the daily triage's, never a burst of runs. Each carries its
 * author's login, which the board counts toward its per-author triage limit.
   */
  async untriaged(repo: string, since?: string) {
    const r = this.target(repo);
    if (!since) return { untriaged: [] as { number: number; created_at: string; author: string }[], triage_cursor: new Date().toISOString() };
    if (Number.isNaN(Date.parse(since))) throw new GitHubRefused("a triage cursor must be an ISO 8601 timestamp");
    const after = (i: GhIssue) => Date.parse(String(i.created_at)) > Date.parse(since);
    const newer: GhIssue[] = [];
    for (let page = 1; page <= PAGE_CAP; page++) {
      const res = await this.gh.rest("GET", `/repos/${r.owner}/${r.name}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't list ${r.repo}'s new issues (GitHub said ${res.status})`);
      const pageIssues = (Array.isArray(res.body) ? res.body : []) as GhIssue[];
      newer.push(...pageIssues.filter(after));
      if (pageIssues.length < 100 || !pageIssues.every(after)) break;
    }
    const fresh = newer
      .filter((i) => !i.pull_request && !labelNames(i).some((l) => same(l, r.label) || l === FEATURE_LABEL || l === BUILD_LABEL))
      .sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)))
      .slice(0, TRIAGE_BATCH)
      .map((i) => ({ number: i.number, created_at: String(i.created_at), author: String(i.user?.login ?? "") }));
    const newest = newer.reduce((m, i) => (Date.parse(String(i.created_at)) > Date.parse(m) ? String(i.created_at) : m), since);
    return { untriaged: fresh, triage_cursor: fresh.length === TRIAGE_BATCH ? fresh.at(-1)!.created_at : newest };
  }

  /**
   * One repo's open labelled issues updated after `since`, each with its trust verdict, plus the untrusted and unreadable
   * ones in `skipped`. `cursor` is the newest updated_at seen (or `since`), so the next poll passes it back.
   */
  async repoSince(repo: string, since?: string, label?: string) {
    const r = this.target(repo);
    const asked = label ?? r.label;
    const { owner, name } = r;
    // The board's first poll has no cursor yet: that means from the start, like no since at all.
    since = since || undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new GitHubRefused("since must be an ISO 8601 timestamp");
    // Every page before the cursor moves: an issue past the first page would otherwise be marked done unread. Past the cap
    // the read refuses rather than guess, so the watcher retries instead of skipping the tail.
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
    const skipped: { number: number; reason: string }[] = [];
    const seen = new Set<number>();
    // Progress is recorded per issue only once its label events were read: a failed read stays behind the cursor, so the
    // next poll retries it instead of the failure counting as done.
    const read: string[] = [];
    const failed: number[] = [];
    let cursor = since ?? null;
    for (const i of listed) {
      if (i.pull_request || seen.has(i.number)) continue;
      seen.add(i.number);
      if (since && !(Date.parse(i.updated_at) > Date.parse(since))) continue;
      try {
        const { events } = await this.labelEvents(r.repo, i.number, asked);
        const latest = this.latestLabel(r, events, asked);
        read.push(i.updated_at);
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
        failed.push(Date.parse(i.updated_at));
        skipped.push({ number: i.number, reason: `could not read its label events: ${(err as Error).message.slice(0, 120)}` });
      }
    }
    // The newest timestamp whose read (and every earlier one's) succeeded, so nothing past the oldest failure is skipped.
    const oldestFailure = failed.length ? Math.min(...failed) : Infinity;
    for (const at of read) if (Date.parse(at) < oldestFailure && (cursor === null || Date.parse(at) > Date.parse(cursor))) cursor = at;
    return { issues, skipped, cursor };
  }
}

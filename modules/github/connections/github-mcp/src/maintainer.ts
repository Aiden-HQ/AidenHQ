// The Maintainer's GitHub App tools, on the repos the instance lists in `maintainer_repos` and no other: open issues
// carrying a repo's label, their label events with a trust verdict, the repo tree and one file, and the three writes
// (comment, label, state). A label is trusted only when our own App added it or a collaborator whose role is one of that
// repo's `trusted` roles did; nothing in the issue's text or author decides trust.
import { GitHubRefused } from "./github.js";
import { scrubProblems, scrubText } from "./scrub.js";
import type { Projects } from "./projects.js";

export const AGENT_FIX = "agent-fix";
// The roles a repo may trust to vouch for a label: a fixed set in code, never wider than write. A repo's `trusted` picks
// from it (default admin and maintain); triage, read and custom roles never count.
export const TRUST_ROLES = ["admin", "maintain", "write"] as const;
const DEFAULT_TRUSTED = ["admin", "maintain"];
// What follows a fix's merge: `done` (the merged PR is the fix), or `product-pin` (this instance's product pin bump, its
// apply and the generation's health, for the AidenHQ product repo this instance runs).
export const AFTER_MERGE = ["done", "product-pin"] as const;
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

export interface MaintainedRepo {
  repo: string;
  owner: string;
  name: string;
  label: string;
  trusted: string[];
  after_merge: (typeof AFTER_MERGE)[number];
}

/**
 * `maintainer_repos` as compiled from the setting: JSON when an entry is `{ repo, label?, trusted?, after_merge? }`, or
 * comma-joined when every entry is a bare "owner/name" (an entry with every default). Anything malformed throws, naming
 * the entry, so the caller refuses every tool rather than act on a list it misread.
 */
export function parseRepos(raw: string): MaintainedRepo[] {
  if (!raw.trim()) return [];
  let list: unknown;
  try {
    list = raw.trim().startsWith("[") ? JSON.parse(raw) : raw.split(",").map((x) => x.trim());
  } catch {
    throw new Error("maintainer_repos is not a list of { repo, label, trusted, after_merge }");
  }
  if (!Array.isArray(list)) throw new Error("maintainer_repos is not a list");
  const seen = new Set<string>();
  return list.map((entry: any, i) => {
    const where = `maintainer_repos[${i}]`;
    const e = typeof entry === "string" ? { repo: entry } : entry;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`${where}: an entry is { repo, label, trusted, after_merge }`);
    const unknown = Object.keys(e).filter((k) => !["repo", "label", "trusted", "after_merge"].includes(k));
    if (unknown.length) throw new Error(`${where}: unknown key ${unknown.join(", ")}`);
    const m = String(e.repo ?? "").trim().match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
    if (!m) throw new Error(`${where}: repo must be owner/name`);
    const key = `${m[1]}/${m[2]}`.toLowerCase();
    if (seen.has(key)) throw new Error(`${where}: ${m[1]}/${m[2]} is listed twice`);
    seen.add(key);
    const label = e.label === undefined ? AGENT_FIX : String(e.label);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,49}$/.test(label)) throw new Error(`${where}: label must be 1-50 letters, digits, spaces or ._:-`);
    const trusted = e.trusted === undefined ? DEFAULT_TRUSTED : e.trusted;
    if (!Array.isArray(trusted) || !trusted.length || trusted.some((r) => !(TRUST_ROLES as readonly string[]).includes(r)))
      throw new Error(`${where}: trusted must be one or more of ${TRUST_ROLES.join(", ")}`);
    const after = e.after_merge === undefined ? "done" : e.after_merge;
    if (!(AFTER_MERGE as readonly string[]).includes(after)) throw new Error(`${where}: after_merge must be ${AFTER_MERGE.join(" or ")}`);
    return { repo: `${m[1]}/${m[2]}`, owner: m[1]!, name: m[2]!, label, trusted: [...new Set(trusted as string[])], after_merge: after };
  });
}

/** One line per repo, for tool descriptions: what the Maintainer may act on and what follows a merge there. */
export const describeRepos = (repos: MaintainedRepo[]) =>
  repos.length ? repos.map((r) => `${r.repo} (label ${r.label}, trusted ${r.trusted.join("/")}, after merge: ${r.after_merge})`).join("; ") : "none configured (setting maintainer_repos)";

export interface LabelEvent {
  label: string;
  action: "labeled" | "unlabeled";
  actor: string | null;
  app_id: number | null;
  app_slug: string | null;
  created_at: string;
  trusted: boolean;
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

export class Maintainer {
  private slug = "";
  private roles = new Map<string, { role: string | null; at: number }>();

  /** `repos` is the parsed list, or why it couldn't be parsed: then every tool refuses with that reason. */
  constructor(
    private readonly app: Projects,
    private readonly repos: MaintainedRepo[] | Error,
    private readonly terms: string[] = [],
  ) {}

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

  /** The App's slug (its events carry it, and its bot login is `<slug>[bot]`), from codehost-github with a token on `r`. */
  private async appSlug(r: MaintainedRepo): Promise<string> {
    if (!this.slug) this.slug = await this.app.appSlug(r.owner, r.name);
    if (!this.slug) throw new Error("couldn't learn the GitHub App's slug from codehost-github");
    return this.slug;
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
    const r = await this.app.appCall(owner, repo, { metadata: "read" }, "GET", `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
    if (r.status !== 200 && r.status !== 404) throw new Error(`couldn't read ${login}'s role on ${owner}/${repo} (GitHub said ${r.status})`);
    const role = r.status === 200 ? String(r.body.role_name ?? r.body.permission ?? "") || null : null;
    this.roles.set(key, { role, at: Date.now() });
    return role;
  }

  /** Whether this label event was made by our App or by a collaborator with one of the repo's trusted roles. */
  private async trustedEvent(e: GhTimelineEvent, r: MaintainedRepo): Promise<boolean> {
    const slug = await this.appSlug(r);
    if (e.performed_via_github_app?.slug === slug) return true;
    const login = e.actor?.login;
    if (!login) return false;
    if (login.toLowerCase() === `${slug.toLowerCase()}[bot]`) return true;
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
      const res = await this.app.appCall(owner, name, { issues: "read" }, "GET", `/repos/${owner}/${name}/issues/${number}/timeline?per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't read ${owner}/${name}#${number}'s timeline (GitHub said ${res.status})`);
      const pageEvents = (Array.isArray(res.body) ? res.body : []) as GhTimelineEvent[];
      for (const e of pageEvents) {
        if (e.event !== "labeled" && e.event !== "unlabeled") continue;
        const label = String(e.label?.name ?? "");
        if (!label || (only && !same(label, only))) continue;
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
    return { repo: r.repo, number, events };
  }

  /** The repo's latest label event, when it is a `labeled` one: the label is currently on the issue. */
  private latestLabel(r: MaintainedRepo, events: LabelEvent[]): LabelEvent | undefined {
    const e = events.filter((x) => same(x.label, r.label)).at(-1);
    return e?.action === "labeled" ? e : undefined;
  }

  /** The latest label event, or why it couldn't be read: an unreadable timeline is untrusted, never assumed. */
  private async latestOrError(r: MaintainedRepo, number: number): Promise<{ latest?: LabelEvent; error?: string }> {
    try {
      return { latest: this.latestLabel(r, (await this.labelEvents(r.repo, number, r.label)).events) };
    } catch (err) {
      return { error: (err as Error).message.slice(0, 200) };
    }
  }

  /** Open issues carrying `label` (default the repo's), each with its repo-label event and whether that label is trusted. */
  async issueList(repo: string | undefined, label?: string) {
    const r = this.target(repo);
    const { owner, name } = r;
    const issues: Record<string, unknown>[] = [];
    for (let page = 1; page <= PAGE_CAP; page++) {
      const res = await this.app.appCall(owner, name, { issues: "read" }, "GET", `/repos/${owner}/${name}/issues?state=open&labels=${encodeURIComponent(label ?? r.label)}&per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't list ${owner}/${name}'s issues (GitHub said ${res.status})`);
      const pageIssues = (Array.isArray(res.body) ? res.body : []) as GhIssue[];
      for (const i of pageIssues) {
        if (i.pull_request || issues.length >= ISSUE_CAP) continue;
        const { latest, error } = await this.latestOrError(r, i.number);
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
    return { repo: r.repo, label: r.label, trusted_roles: r.trusted, after_merge: r.after_merge, issues };
  }

  /** The repository's file list at a ref, capped in entries and depth. */
  async repoTree(repo: string | undefined, ref = "HEAD") {
    const { owner, name, repo: slug } = this.target(repo);
    const r = await this.app.appCall(owner, name, { contents: "read" }, "GET", `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
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
    const commit = await this.commitSha(owner, name, ref ?? "HEAD");
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const r = await this.app.appCall(owner, name, { contents: "read" }, "GET", `/repos/${owner}/${name}/contents/${encoded}?ref=${commit}`);
    if (r.status !== 200) throw new Error(`couldn't read ${owner}/${name}/${path} (GitHub said ${r.status})`);
    if (Array.isArray(r.body)) throw new GitHubRefused(`${path} is a directory; use github_app_repo_tree`);
    if (r.body.encoding !== "base64" || typeof r.body.content !== "string") throw new Error(`${path} has no inline content (the contents API omits files over 1 MB)`);
    const buf = Buffer.from(r.body.content, "base64");
    if (buf.length > FILE_CAP) throw new GitHubRefused(`${path} is ${buf.length} bytes, over the ${FILE_CAP}-byte cap`);
    return { repo: slug, path, ref: commit, blob_sha: r.body.sha, size: buf.length, text: buf.toString("utf8") };
  }

  /** The commit a branch, tag, sha or HEAD names, or an error naming the ref and GitHub's answer. */
  private async commitSha(owner: string, name: string, ref: string) {
    const r = await this.app.appCall(owner, name, { contents: "read" }, "GET", `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`);
    if (r.status !== 200 || typeof r.body?.sha !== "string") {
      throw new Error(`couldn't resolve ${owner}/${name} at ${ref} to a commit (GitHub said ${r.status}${r.body?.message ? `: ${r.body.message}` : ""})`);
    }
    return r.body.sha as string;
  }

  /** The issue's current repo label and, when present, whether its latest label event is trusted. */
  private async currentLabel(r: MaintainedRepo, number: number) {
    const res = await this.app.appCall(r.owner, r.name, { issues: "read" }, "GET", `/repos/${r.owner}/${r.name}/issues/${number}`);
    if (res.status !== 200) throw new Error(`couldn't read ${r.repo}#${number} (GitHub said ${res.status})`);
    const present = labelNames(res.body as GhIssue).some((l) => same(l, r.label));
    if (!present) return { present: false, trusted: true, event: undefined as LabelEvent | undefined };
    const { events } = await this.labelEvents(r.repo, number, r.label);
    const latest = this.latestLabel(r, events);
    return { present: true, trusted: Boolean(latest?.trusted), event: latest };
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

  /** One comment as the App, with owner data removed before it is sent; anything the rewrite can't reach refuses it. */
  async comment(repo: string | undefined, number: number, body: string) {
    const r = this.target(repo);
    const terms = this.termsFor(r);
    const text = scrubText(body, terms);
    const left = scrubProblems(text, terms);
    if (left.length) throw new GitHubRefused(`owner data can't go into a public comment; redact these and try again: ${left.join("; ")}`);
    await this.assertTrusted(r, number);
    const res = await this.app.appCall(r.owner, r.name, { issues: "write" }, "POST", `/repos/${r.owner}/${r.name}/issues/${number}/comments`, { body: text });
    if (res.status !== 201) throw new Error(`GitHub refused the comment (${res.status} ${res.body?.message ?? ""})`.trim());
    return { repo: r.repo, number, url: res.body.html_url, id: res.body.id };
  }

  /** Add or remove the repo's label and nothing else, refusing an issue whose current label is untrusted. */
  async label(repo: string | undefined, number: number, action: "add" | "remove", label?: string) {
    const r = this.target(repo);
    if (label !== undefined && !same(label, r.label)) throw new GitHubRefused(`only the ${r.label} label may be changed on ${r.repo}`);
    const cur = await this.assertTrusted(r, number);
    const out = (changed: boolean) => ({ repo: r.repo, number, label: r.label, action, changed });
    if (action === "add") {
      if (cur.present) return out(false);
      const res = await this.app.appCall(r.owner, r.name, { issues: "write" }, "POST", `/repos/${r.owner}/${r.name}/issues/${number}/labels`, { labels: [r.label] });
      if (res.status !== 200) throw new Error(`GitHub refused the label (${res.status} ${res.body?.message ?? ""})`.trim());
      return out(true);
    }
    if (!cur.present) return out(false);
    const res = await this.app.appCall(r.owner, r.name, { issues: "write" }, "DELETE", `/repos/${r.owner}/${r.name}/issues/${number}/labels/${encodeURIComponent(r.label)}`);
    if (res.status !== 200) throw new Error(`GitHub refused the label removal (${res.status} ${res.body?.message ?? ""})`.trim());
    return out(true);
  }

  /**
   * Close as completed or not_planned, or reopen, refusing an untrusted label. A `note` is posted as a comment first,
   * through `comment` (so the owner-data scrub applies), and the state changes only once it is posted.
   */
  async state(repo: string | undefined, number: number, state: "open" | "closed", reason?: "completed" | "not_planned", note?: string) {
    const r = this.target(repo);
    if (note !== undefined && state === "open") throw new GitHubRefused("a note is posted only when closing");
    if (note !== undefined) await this.comment(r.repo, number, note);
    else await this.assertTrusted(r, number);
    const body = state === "closed" ? { state, state_reason: reason ?? "completed" } : { state };
    const res = await this.app.appCall(r.owner, r.name, { issues: "write" }, "PATCH", `/repos/${r.owner}/${r.name}/issues/${number}`, body);
    if (res.status !== 200) throw new Error(`GitHub refused the state change (${res.status} ${res.body?.message ?? ""})`.trim());
    return { repo: r.repo, number, state: res.body.state, state_reason: res.body.state_reason ?? null };
  }

  /**
   * The board watcher's read: every listed repo, each from its own cursor (`cursors[repo]`). One repo's failure is its
   * `error` and never holds up another's. With `triage` (the triage cursors, when the board triages each new issue), each
   * repo also carries its new unlabelled issues (`untriaged`, `triage_cursor`), or `triage_error` without failing the rest.
   */
  async issuesSince(cursors: Record<string, string> = {}, triage?: Record<string, string>) {
    if (this.repos instanceof Error) throw new GitHubRefused(`maintainer_repos is invalid: ${this.repos.message}`);
    type Triage = Partial<Awaited<ReturnType<Maintainer["untriaged"]>>> & { triage_error?: string };
    type Row = ({ repo: string; error: string } | ({ repo: string } & Awaited<ReturnType<Maintainer["repoSince"]>>)) & Triage;
    const out: Row[] = [];
    const at = (m: Record<string, string>, repo: string) => Object.entries(m).find(([k]) => same(k, repo))?.[1];
    for (const r of this.repos) {
      let row: Row;
      try {
        row = { repo: r.repo, ...(await this.repoSince(r.repo, at(cursors, r.repo))) };
      } catch (err) {
        row = { repo: r.repo, error: (err as Error).message.slice(0, 300) };
      }
      if (triage) {
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
   * One repo's open issues opened after `since` that carry no repo label and weren't filed by our App (its own filings are
   * labelled at filing): the reports the Maintainer triages one by one. Oldest first, at most TRIAGE_BATCH; `triage_cursor`
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
      const res = await this.app.appCall(r.owner, r.name, { issues: "read" }, "GET", `/repos/${r.owner}/${r.name}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't list ${r.repo}'s new issues (GitHub said ${res.status})`);
      const pageIssues = (Array.isArray(res.body) ? res.body : []) as GhIssue[];
      newer.push(...pageIssues.filter(after));
      if (pageIssues.length < 100 || !pageIssues.every(after)) break;
    }
    const slug = await this.appSlug(r);
    const ours = (i: GhIssue) => i.performed_via_github_app?.slug === slug || String(i.user?.login ?? "").toLowerCase() === `${slug.toLowerCase()}[bot]`;
    const fresh = newer
      .filter((i) => !i.pull_request && !labelNames(i).some((l) => same(l, r.label)) && !ours(i))
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
  async repoSince(repo: string, since?: string) {
    const r = this.target(repo);
    const { owner, name } = r;
    // The board's first poll has no cursor yet: that means from the start, like no since at all.
    since = since || undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new GitHubRefused("since must be an ISO 8601 timestamp");
    // Every page before the cursor moves: an issue past the first page would otherwise be marked done unread. Past the cap
    // the read refuses rather than guess, so the watcher retries instead of skipping the tail.
    const listed: GhIssue[] = [];
    let page = 1;
    for (; page <= PAGE_CAP; page++) {
      const res = await this.app.appCall(owner, name, { issues: "read" }, "GET", `/repos/${owner}/${name}/issues?state=open&labels=${encodeURIComponent(r.label)}&per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`couldn't list ${owner}/${name}'s issues (GitHub said ${res.status})`);
      const pageIssues = (Array.isArray(res.body) ? res.body : []) as GhIssue[];
      listed.push(...pageIssues);
      if (pageIssues.length < 100) break;
    }
    if (page > PAGE_CAP) throw new GitHubRefused(`${owner}/${name} has more than ${PAGE_CAP * 100} open ${r.label} issues; refusing to read only part of them`);
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
        const { events } = await this.labelEvents(r.repo, i.number, r.label);
        const latest = this.latestLabel(r, events);
        read.push(i.updated_at);
        if (!latest) {
          skipped.push({ number: i.number, reason: `no ${r.label} label event` });
          continue;
        }
        if (!latest.trusted) {
          skipped.push({ number: i.number, reason: `${r.label} label added by ${latest.actor ?? latest.app_slug ?? "an unknown actor"}, not the App or a trusted collaborator` });
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

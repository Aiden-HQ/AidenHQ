// Code review's watcher reads (the code-review module's PrSource seam, modules/code-review/service/src/seams.ts): open PRs, one PR,
// a PR's files for its risk tier (snapshot), the PR conversation comments since a time, and a login's permission. Read-only, through the same GitHub client as every other read
// (the owner's sign-in).
import { createHash } from "node:crypto";
import { GitHubRefused, type GitHub } from "./github.js";

export type PullRequest = {
  repo: string; number: number; head: string; base: string; base_ref: string; draft: boolean;
  fork: boolean; author: string; open: boolean; merged: boolean; url: string; title: string; body: string;
  /** GitHub's author_association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, …), and whether the author is this instance's own
   * App: what code review's risk tiers read the author kind from. */
  association: string; own: boolean;
};
/** One file of a PR's own change (GitHub's files list, merge base to head). */
export type PrFile = { path: string; previous?: string; additions: number; deletions: number };
/** GitHub's files list stops at this many files. */
const FILES_MAX = 3000;
export type PrComment = { id: string; number: number; author: string; body: string; created_at: string };
export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_PAGES = 30;

export function repoArg(v: string | null): string {
  const m = (v ?? "").match(REPO);
  if (!m || m[1] === "." || m[1] === ".." || m[2] === "." || m[2] === "..") throw new GitHubRefused("repo must be owner/name");
  return `${m[1]}/${m[2]}`;
}
export function numberArg(v: string | null): number {
  const n = Number(v);
  if (!/^[1-9][0-9]{0,9}$/.test(v ?? "") || !Number.isSafeInteger(n)) throw new GitHubRefused("number must be a positive integer");
  return n;
}
export function shaArg(v: string | null): string {
  if (!/^[0-9a-f]{40}$/.test(v ?? "")) throw new GitHubRefused("sha must be 40 hex characters");
  return v!;
}
export function loginArg(v: string | null): string {
  if (!v || !LOGIN.test(v)) throw new GitHubRefused("login is not a GitHub login");
  return v;
}
export function sinceArg(v: string | null): string {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) || Number.isNaN(Date.parse(v))) throw new GitHubRefused("since must be an ISO UTC timestamp");
  return v;
}

type GhPr = {
  author_association?: string; changed_files?: number;
  number: number; state: string; merged_at?: string | null; merge_commit_sha?: string | null; title?: string; body?: string | null; draft?: boolean; html_url: string; user?: { login?: string } | null;
  head?: { sha?: string; repo?: { full_name?: string } | null }; base?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
};

function shape(repo: string, p: GhPr, self?: string): PullRequest {
  const baseRepo = (p.base?.repo?.full_name ?? repo).toLowerCase();
  const headRepo = p.head?.repo?.full_name?.toLowerCase();
  return {
    repo: repo.toLowerCase(), number: p.number, head: String(p.head?.sha), base: String(p.base?.sha), base_ref: String(p.base?.ref),
    draft: Boolean(p.draft), fork: !headRepo || headRepo !== baseRepo, author: p.user?.login ?? "", open: p.state === "open", merged: !!p.merged_at, url: p.html_url,
    // A stranger's words: plain text on the board, never in a task title; a review gets title and body only fenced as data.
    title: String(p.title ?? "").slice(0, 200), body: String(p.body ?? "").slice(0, 2000),
    association: String(p.author_association ?? "NONE"), own: !!self && (p.user?.login ?? "").toLowerCase() === self.toLowerCase(),
  };
}

export class CodeReviewReader {
  /** `identity`: who a review on owner/repo would post as (review-post.ts identity, auto), or null when nobody may. */
  /** `self`: this instance's own App's bot login (`<slug>[bot]`), whose PRs are a member's. */
  constructor(private readonly github: GitHub, private readonly identity: (owner: string, repo: string) => Promise<"app" | "owner" | null> = async () => null, private readonly self: () => string | undefined = () => undefined) {}

  /** Whether a review may post on the repo, and as whom: the owner, once GitHub is connected (null until then). */
  async postable(repo: string): Promise<{ identity: "app" | "owner" | null; org: string }> {
    const [owner, name] = repo.toLowerCase().split("/");
    return { identity: await this.identity(owner!, name!), org: owner! };
  }

  async open(repo: string): Promise<PullRequest[]> {
    const out: PullRequest[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.github.request<GhPr[]>("GET", `/repos/${repo}/pulls`, { query: { state: "open", per_page: 100, page } });
      out.push(...rows.map((p) => shape(repo, p, this.self())));
      if (rows.length < 100) return out;
    }
    throw new Error(`more than ${MAX_PAGES * 100} open pull requests in ${repo}`);
  }

  async get(repo: string, number: number): Promise<PullRequest> {
    return shape(repo, await this.github.request<GhPr>("GET", `/repos/${repo}/pulls/${number}`), this.self());
  }

  /**
   * One consistent read of a PR's own change, for its risk tier: the PR, every page of its files, then the PR again. `moved` when the
   * head or base moved meanwhile, or the pages don't hold exactly `changed_files` files (the next poll asks again). Over FILES_MAX
   * files GitHub can't list them all: the snapshot holds none and the tier is sensitive, unread.
   */
  async snapshot(repo: string, number: number): Promise<{ moved: true } | { pr: PullRequest; changed_files: number; files: PrFile[] }> {
    const a = await this.github.request<GhPr>("GET", `/repos/${repo}/pulls/${number}`);
    const n = Number(a.changed_files ?? 0);
    const files: PrFile[] = [];
    if (n <= FILES_MAX) for (let page = 1; page <= FILES_MAX / 100; page++) {
      const rows = await this.github.request<{ filename: string; previous_filename?: string; additions?: number; deletions?: number }[]>("GET", `/repos/${repo}/pulls/${number}/files`, { query: { per_page: 100, page } });
      files.push(...rows.map((f) => ({ path: f.filename, ...(f.previous_filename ? { previous: f.previous_filename } : {}), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })));
      if (rows.length < 100) break;
    }
    const b = await this.github.request<GhPr>("GET", `/repos/${repo}/pulls/${number}`);
    if (b.head?.sha !== a.head?.sha || b.base?.sha !== a.base?.sha || b.base?.ref !== a.base?.ref || (n <= FILES_MAX && files.length !== n)) return { moved: true };
    return { pr: shape(repo, b, this.self()), changed_files: n, files: n > FILES_MAX ? [] : files };
  }

  /** PR conversation comments created at or after `since`, oldest first; the cursor is the newest created_at seen (else `since`); at most MAX_PAGES pages a call. */
  async comments(repo: string, since: string): Promise<{ comments: PrComment[]; cursor: string }> {
    const out: PrComment[] = [];
    let cursor = since;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.github.request<{ id: number; body?: string | null; created_at: string; html_url?: string; issue_url?: string; user?: { login?: string } | null }[]>(
        "GET", `/repos/${repo}/issues/comments`, { query: { since, sort: "created", direction: "asc", per_page: 100, page } });
      for (const c of rows) {
        if (!/\/pull\/\d+/.test(c.html_url ?? "") || Date.parse(c.created_at) < Date.parse(since)) continue;
        const number = Number(c.issue_url?.match(/\/issues\/(\d+)$/)?.[1]);
        if (!number) continue;
        out.push({ id: String(c.id), number, author: c.user?.login ?? "", body: c.body ?? "", created_at: c.created_at });
        if (Date.parse(c.created_at) > Date.parse(cursor)) cursor = c.created_at;
      }
      if (rows.length < 100) return { comments: out, cursor };
    }
    // A flood: return what was read; the cursor is its newest, so the next call goes on from there (the service dedupes by id).
    return { comments: out, cursor };
  }

  /** How head relates to base, and their merge base. */
  async compare(repo: string, base: string, head: string): Promise<{ merge_base: string; status: "ahead" | "behind" | "identical" | "diverged" }> {
    const r = await this.github.request<{ status?: string; merge_base_commit?: { sha?: string } }>("GET", `/repos/${repo}/compare/${base}...${head}`, { query: { per_page: 1 } });
    if (!["ahead", "behind", "identical", "diverged"].includes(String(r.status)) || !r.merge_base_commit?.sha) throw new Error("GitHub's compare answer has no status or merge base");
    return { merge_base: r.merge_base_commit.sha, status: r.status as "ahead" };
  }

  /**
   * A fingerprint of the change `base`...`head` (from their merge base): each file's status, name and patch, hunk headers
   * included, so the same edit at another place differs. null when GitHub doesn't show all of it (a file with changes but no
   * patch (a binary, a mode-only change), or the compare's 300-file cap).
   */
  async patchId(repo: string, base: string, head: string): Promise<{ id: string | null }> {
    const r = await this.github.request<{ files?: { filename: string; previous_filename?: string; status: string; changes?: number; patch?: string }[] }>("GET", `/repos/${repo}/compare/${base}...${head}`, { query: { per_page: 1 } });
    const files = r.files ?? [];
    // A file without a patch (a binary, a mode-only change, one too large) can't be compared: no fingerprint.
    if (!Array.isArray(r.files) || files.length >= 300 || files.some((f) => typeof f.patch !== "string")) return { id: null };
    const h = createHash("sha256");
    for (const f of [...files].sort((a, b) => a.filename.localeCompare(b.filename))) h.update(`${f.status}\0${f.previous_filename ?? ""}\0${f.filename}\0${f.patch}\0`);
    return { id: h.digest("hex") };
  }

  /**
   * The PR's true merge base with `head`: what the PR changes. GitHub's `base.sha` is the base branch's tip when the PR was last
   * synced (stale for an open PR once the branch moves or is merged into the head, and for a merged one, the tip at merge), so
   * it is never the base. An open PR is compared with its base branch; a merged one with the first parent of its merge commit.
   */
  async mergeBase(repo: string, number: number, head: string): Promise<{ merge_base: string }> {
    const p = await this.github.request<GhPr>("GET", `/repos/${repo}/pulls/${number}`);
    let base: string;
    if (!p.merged_at) {
      const b = await this.github.request<{ commit?: { sha?: string } }>("GET", `/repos/${repo}/branches/${encodeURIComponent(String(p.base?.ref))}`);
      if (!b.commit?.sha) throw new Error("GitHub's base branch has no tip");
      base = b.commit.sha;
    } else {
      if (!p.merge_commit_sha) throw new Error("GitHub's merged PR has no merge commit");
      const c = await this.github.request<{ parents?: { sha?: string }[] }>("GET", `/repos/${repo}/commits/${p.merge_commit_sha}`);
      if (!c.parents?.[0]?.sha) throw new Error("GitHub's merge commit has no parent");
      base = c.parents[0].sha;
    }
    return { merge_base: (await this.compare(repo, base, head)).merge_base };
  }

  /** The repos the owner's sign-in can read whose name contains `q` (at most 30). */
  async repos(q: string): Promise<{ repo: string; private: boolean; url: string }[]> {
    const out: { repo: string; private: boolean; url: string }[] = [];
    const needle = q.toLowerCase();
    for (let page = 1; page <= 10 && out.length < 30; page++) {
      const rows = await this.github.request<{ full_name: string; private?: boolean; html_url: string }[]>("GET", "/user/repos", { query: { per_page: 100, page, sort: "pushed" } });
      for (const r of rows) if (r.full_name.toLowerCase().includes(needle) && out.length < 30) out.push({ repo: r.full_name, private: Boolean(r.private), url: r.html_url });
      if (rows.length < 100) break;
    }
    return out;
  }

  async permission(repo: string, login: string): Promise<Permission> {
    try {
      const r = await this.github.request<{ permission?: string; role_name?: string }>("GET", `/repos/${repo}/collaborators/${login}/permission`);
      const ok = (v: unknown): v is Permission => ["admin", "maintain", "write", "triage", "read"].includes(String(v));
      return ok(r.role_name) ? r.role_name : ok(r.permission) ? r.permission : "none";
    } catch (err) {
      if (/GitHub 404 /.test((err as Error).message)) return "none";
      throw err;
    }
  }
}

/** GET /internal/code-review/<op>: the answer for the query, as { status, body }. */
export async function codeReviewRoute(reader: CodeReviewReader, op: string, q: URLSearchParams, onError?: (err: unknown) => void | Promise<void>): Promise<{ status: number; body: unknown }> {
  try {
    if (op === "repos") return { status: 200, body: { repos: await reader.repos((q.get("q") ?? "").slice(0, 100)) } };
    const repo = repoArg(q.get("repo"));
    if (op === "prs") return { status: 200, body: { prs: await reader.open(repo) } };
    if (op === "pr") return { status: 200, body: { pr: await reader.get(repo, numberArg(q.get("number"))) } };
    if (op === "snapshot") return { status: 200, body: await reader.snapshot(repo, numberArg(q.get("number"))) };
    if (op === "comments") return { status: 200, body: await reader.comments(repo, sinceArg(q.get("since"))) };
    if (op === "compare") return { status: 200, body: await reader.compare(repo, shaArg(q.get("base")), shaArg(q.get("head"))) };
    if (op === "patch-id") return { status: 200, body: await reader.patchId(repo, shaArg(q.get("base")), shaArg(q.get("head"))) };
    if (op === "merge-base") return { status: 200, body: await reader.mergeBase(repo, numberArg(q.get("number")), shaArg(q.get("head"))) };
    if (op === "postable") return { status: 200, body: await reader.postable(repo) };
    // A login that isn't one (a bot's, an empty or deleted user's) has no permission: an answer, never an error to retry.
    if (op === "permission") {
      let login: string;
      try { login = loginArg(q.get("login")); } catch { return { status: 200, body: { permission: "none" } }; }
      return { status: 200, body: { permission: await reader.permission(repo, login) } };
    }
    return { status: 404, body: { error: "no such operation" } };
  } catch (err) {
    await onError?.(err); // the owner is told of a failure only they can fix (an expired sign-in, an org restriction)
    const detail = (err as Error).message.slice(0, 300);
    if (err instanceof GitHubRefused) return { status: 400, body: { error: "refused", detail } };
    return { status: /GitHub 404 /.test(detail) ? 404 : 502, body: { error: "github_error", detail } };
  }
}

// The typed GitHub operations other modules ask the kernel for (POST /v1/codehost/:op → here, /ops/<op>), each run on the
// owner's sign-in inside this process: fetch, head, read, comment, commit, runner_token (app_token alone is the App's). The kernel has checked the caller's
// grant and the shape of every field; the owner's token never leaves this process, so no answer, header or error carries it
// (errors are scrubbed of it as a last guard). snapshot, clone and bundle stay in service.ts.
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { join } from "node:path";
import type { GitHubAccess } from "../../connections/github-mcp/src/client.ts";
import { withFooter, withTrailer } from "./aidenhq-sdk/attribution.ts";
import { CLOSED_EVENT_SELECTION } from "./aidenhq-sdk/closed-event.ts";

export type OpsContext = {
  access: GitHubAccess;
  /** The repo's bare cache clone's directory, made on first use. */
  cache: (s: { org: string; name: string; slug: string }) => Promise<string>;
  /** git against a bare directory with the hardened arguments; the token (when given) goes to that one command's credential env. */
  git: (dir: string, args: string[], token?: string) => Promise<string>;
  /** A branch of the repo on GitHub fetched into the cache: its directory, local ref and sha (service.ts fetchRemote). */
  fetchRemote: (s: { org: string; name: string; slug: string }, name: string) => Promise<{ dir: string; ref: string; sha: string }>;
  cacheDir: string;
  /** Whether the change feed reads this repo (service.ts feedWatched): the repo's fork and archived flags as GitHub reports them. */
  feedWatched: (slug: string, repo: { isFork?: boolean; isArchived?: boolean }) => boolean;
  /** Makes a scratch bare repo (init --bare) at `dir`. */
  initBare: (dir: string) => Promise<void>;
  /** Whether the kernel's records name this GitHub object (a ref like `github:o/r#1/comment/2`) as made by AidenHQ. */
  ours: (ref: string) => Promise<boolean>;
  /** The owner's one GitHub App (github-mcp's gitHubApp): where it is installed, and a repo-narrowed token from it. */
  app?: {
    installation(repo: string): Promise<number | null>;
    mint(installation: number, narrow: { repositories: string[]; permissions: Record<string, string> }): Promise<{ token: string; expires_at: string }>;
  };
};
type Body = Record<string, any>;
type Answer = { status: number; json?: unknown; text?: string; stream?: Readable };

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const slugOf = (repo: unknown) => {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(repo ?? ""));
  if (!m) throw fail(400, `${String(repo)} is not owner/name`);
  return { slug: `${m[1]}/${m[2]}`, org: m[1]!, name: m[2]! };
};

// A PR and an issue as the grader reads them (modules/grading/service/src/grader/evidence.ts). `baseRefOid` is the base ref's
// commit recorded on this PR, which evidence.ts states as the PR's base commit: a criterion about the commit the PR is based on
// is judged from it. It is not `baseRef.target` (the base branch's current tip, which moves) and not the git merge base.
const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    isFork isArchived
    pullRequest(number: $number) {
      number title body url state isDraft createdAt headRefOid headRefName baseRefName baseRefOid mergedAt mergeCommit { oid }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      history: commits(last: 30) { nodes { commit { oid tree { oid } parents(first: 1) { totalCount } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { databaseId name status conclusion startedAt completedAt externalId checkSuite { app { slug } } } ... on StatusContext { context state createdAt } } } } } } }
      baseRef { target { oid ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { databaseId name status conclusion startedAt completedAt } ... on StatusContext { context state createdAt } } } } } } }
    }
  }
}`;
const ISSUE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number url state stateReason closedAt labels(first: 20) { nodes { name } }
      ${CLOSED_EVENT_SELECTION}
      comments(last: 10) { nodes { author { login } authorAssociation createdAt body } }
    }
  }
}`;

async function ok(ctx: OpsContext, method: string, path: string, body?: unknown, o?: { accept?: string }) {
  const r = await ctx.access.rest(method, path, body, o);
  if (r.status >= 300) throw fail(r.status === 409 ? 409 : 502, `GitHub ${method} ${path.split("?")[0]}: ${r.status} ${r.body?.message ?? ""}`.trim());
  return r;
}

/** The refs of a bundle as a scratch bare repo's names: one per asked ref, HEAD on the default branch when branches are asked. */
async function bundleOf(ctx: OpsContext, s: ReturnType<typeof slugOf>, ref: string): Promise<Answer> {
  const dir = await ctx.cache(s);
  const token = await ctx.access.token();
  const branches = new Map<string, string>(); // ref name in the bundle → sha
  let head: string | undefined;
  if (ref === "refs/heads/*") {
    await ctx.git(dir, ["fetch", "--quiet", "--no-tags", `https://github.com/${s.slug}.git`, "+refs/heads/*:refs/fetched/heads/*"], token);
    for (const line of (await ctx.git(dir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/fetched/heads/"])).split("\n").filter(Boolean)) {
      const [sha, name] = line.split(" ");
      branches.set(`refs/heads/${name!.slice("refs/fetched/heads/".length)}`, sha!);
    }
    const def = String((await ok(ctx, "GET", `/repos/${s.slug}`)).body?.default_branch ?? "");
    head = branches.has(`refs/heads/${def}`) ? `refs/heads/${def}` : undefined;
  } else if (ref.startsWith("refs/heads/")) {
    const f = await ctx.fetchRemote(s, ref.slice("refs/heads/".length));
    branches.set(ref, f.sha);
    head = ref;
  } else {
    await ctx.git(dir, ["fetch", "--quiet", "--no-tags", `https://github.com/${s.slug}.git`, `+${ref}:refs/fetched/pull`], token);
    branches.set(ref, await ctx.git(dir, ["rev-parse", "--verify", "refs/fetched/pull^{commit}"]));
  }
  if (!branches.size) throw fail(404, `${s.slug} has no branches`);
  return { status: 200, stream: await packBundle(ctx, dir, branches, head) };
}

/**
 * A git bundle of `refs` (name → sha, objects from the cache clone `objects`), HEAD on `head` when given: a scratch bare repo
 * borrows the cache's objects, so the bundle holds those refs alone. Sent from the open file, gone from disk at once: nothing
 * is left behind however the send ends.
 */
export async function packBundle(ctx: Pick<OpsContext, "cacheDir" | "git" | "initBare">, objects: string, refs: Map<string, string>, head?: string): Promise<Readable> {
  const tmp = mkdtempSync(join(ctx.cacheDir, "bundle-")), file = join(tmp, "repo.bundle"), bare = join(tmp, "repo.git");
  try {
    await ctx.initBare(bare);
    writeFileSync(join(bare, "objects", "info", "alternates"), `${join(objects, "objects")}\n`);
    for (const [name, sha] of refs) await ctx.git(bare, ["update-ref", name, sha]);
    if (head) await ctx.git(bare, ["symbolic-ref", "HEAD", head]);
    await ctx.git(bare, ["bundle", "create", "--quiet", file, ...(head ? ["HEAD"] : []), ...refs.keys()]);
    const stream = createReadStream(file);
    await once(stream, "open");
    return stream;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

async function read(ctx: OpsContext, s: ReturnType<typeof slugOf>, b: Body): Promise<Answer> {
  const graph = async (query: string, what: string) => {
    const r = await ok(ctx, "POST", "/graphql", { query, variables: { owner: s.org, repo: s.name, number: b.number } });
    // An error is no answer: the caller waits and asks again.
    const noAnswer = () => fail(502, `GitHub has no readable ${s.slug}#${b.number}: ${JSON.stringify(r.body?.errors ?? []).slice(0, 200)}`);
    // GitHub's own NOT_FOUND on the PR read is its word that the repository or PR is not there (the nulls below), not a failure.
    const nulled = r.body?.data?.repository === null || r.body?.data?.repository?.pullRequest === null;
    const gone = what === "pullRequest" && nulled && r.body.errors?.length && r.body.errors.every((e: any) => e?.type === "NOT_FOUND");
    if (r.body?.errors?.length && !gone) throw noAnswer();
    const data = r.body?.data;
    if (!data || typeof data !== "object") throw noAnswer();
    const node = data.repository;
    // A PR read answers null for a repository that is gone, and for the PR field of a repository that still has the others. That
    // is GitHub's word that the PR is not there, not a failed read: keeping the nulls lets grading's presence check tell a PR
    // that cannot reappear from one it could not read. Only the PR read does this: every other read treats a null as no answer.
    if (what === "pullRequest" && node === null) return { repository: null };
    if (!node || typeof node !== "object") throw noAnswer();
    if (what === "pullRequest" && "pullRequest" in node && node.pullRequest === null) return data;
    if (!node[what]) throw noAnswer();
    return data;
  };
  if (b.kind === "pr") {
    const data = await graph(PR_QUERY, "pullRequest");
    // Whether the change feed watches the repo, so a consumer that waits on its events (sessions) knows they will come. A repository
    // GitHub answered null stays null (grading tells a PR that is gone from one it could not read).
    const repository = data.repository && typeof data.repository === "object" ? { ...data.repository, feedWatched: ctx.feedWatched(s.slug, data.repository) } : data.repository;
    return { status: 200, json: { ...data, repository } };
  }
  if (b.kind === "issue") return { status: 200, json: await graph(ISSUE_QUERY, "issue") };
  if (b.kind === "diff") return { status: 200, text: String((await ok(ctx, "GET", `/repos/${s.slug}/pulls/${b.number}`, undefined, { accept: "application/vnd.github.diff" })).body ?? "") };
  if (b.kind === "job") {
    const r = await ctx.access.rest("GET", `/repos/${s.slug}/actions/jobs/${b.id}`);
    if (r.status === 404) return { status: 200, json: null };
    // A permission refusal (the access layer already types rate limits and sign-in problems) stays a 403: the caller may try another repo.
    if (r.status >= 300) throw fail(r.status === 403 ? 403 : 502, `GitHub GET /repos/${s.slug}/actions/jobs/${b.id}: ${r.status}`);
    const j = r.body;
    return { status: 200, json: { id: j.id, name: j.name, state: j.status, conclusion: j.conclusion, run_id: j.run_id, run_attempt: j.run_attempt ?? null, url: j.html_url } };
  }
  // A workflow run's identity: which workflow, what event, which head, and the base CI read its own inputs from. A 404 is
  // "no such run", never an error.
  if (b.kind === "run") {
    const r = await ctx.access.rest("GET", `/repos/${s.slug}/actions/runs/${b.id}`);
    if (r.status === 404) return { status: 200, json: null };
    if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}/actions/runs/${b.id}: ${r.status}`);
    const u = r.body;
    const w = u?.workflow_id ? await ctx.access.rest("GET", `/repos/${s.slug}/actions/workflows/${u.workflow_id}`).then((a) => (a.status < 300 ? a.body : undefined), () => undefined) : undefined;
    // The run's own jobs, so a command fact can require the `post-checks` job that posted the per-suite checks (the one part
    // of that evidence a poster cannot invent). Across every attempt: a re-run keeps an earlier attempt's passing shard, and
    // the poster must have run in that same attempt. An unreadable list is no jobs at all, never a guess.
    const post: { run_attempt: number | null; state: string | null; conclusion: string | null }[] = [];
    // Each shard job's latest instance: `filter=latest` answers the newest attempt of every job name, so a shard that passed,
    // published and was then re-run keeps only the re-run here. A suite check naming the superseded instance is stale (the
    // shard's latest run did not pass), and one naming the latest is the shard's own current record. `latest` is a map of
    // `packages (N)`/`modules (N)` to that instance; a name with no entry is a shard this run has no job for.
    const latest: Record<string, { id: number | null; run_attempt: number | null; state: string | null; conclusion: string | null }> = {};
    for (let page = 1; page <= 10; page++) {
      const jr = await ctx.access.rest("GET", `/repos/${s.slug}/actions/runs/${b.id}/jobs?filter=all&per_page=100&page=${page}`);
      if (jr.status >= 300) break;
      const jobs: any[] = Array.isArray(jr.body?.jobs) ? jr.body.jobs : [];
      for (const j of jobs) if (j?.name === "post-checks") post.push({ run_attempt: j.run_attempt ?? null, state: j.status ?? null, conclusion: j.conclusion ?? null });
      if (jobs.length < 100) break;
    }
    for (let page = 1; page <= 10; page++) {
      const lr = await ctx.access.rest("GET", `/repos/${s.slug}/actions/runs/${b.id}/jobs?filter=latest&per_page=100&page=${page}`);
      if (lr.status >= 300) break;
      const jobs: any[] = Array.isArray(lr.body?.jobs) ? lr.body.jobs : [];
      for (const j of jobs) {
        if (typeof j?.name !== "string" || !/^(packages|modules) \(\d{1,6}\)$/.test(j.name)) continue;
        latest[j.name] = { id: j.id ?? null, run_attempt: j.run_attempt ?? null, state: j.status ?? null, conclusion: j.conclusion ?? null };
      }
      if (jobs.length < 100) break;
    }
    // The run's own base: main as it was when this run started, as this run recorded it. One value only — two PRs on one run,
    // or two bases, are an ambiguity, never a pick. GitHub drops the `pull_requests` entry once the PR merges, which is why a
    // merged run answers no base; the PR's own `baseRef` is the branch tip now, not this, and is never used in its place.
    const bases = new Set((u?.pull_requests ?? []).filter((p: any) => p?.head?.sha === u?.head_sha && p?.base?.sha).map((p: any) => String(p.base.sha)));
    return { status: 200, json: { id: u.id, run_attempt: u.run_attempt ?? null, event: u.event ?? null, head_sha: u.head_sha ?? null, status: u.status ?? null,
      workflow_id: u.workflow_id ?? null, workflow_path: w?.path ?? null, workflow_state: w?.state ?? null, base_sha: bases.size === 1 ? String([...bases][0]) : null,
      post_checks: post, latest_shard_jobs: latest } };
  }
  // prs: every open PR, newest page first up to 500.
  const prs: { number: number; sha: string; base: string; head_repo: string | null; head_ref: string | null; draft: boolean; created_at: string | null }[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = (await ok(ctx, "GET", `/repos/${s.slug}/pulls?state=open&per_page=100&page=${page}`)).body as any[];
    for (const p of r) prs.push({ number: p.number, sha: p.head?.sha, base: p.base?.ref, head_repo: p.head?.repo?.full_name ?? null, head_ref: p.head?.ref ?? null, draft: !!p.draft, created_at: p.created_at ?? null });
    if (r.length < 100) break;
  }
  return { status: 200, json: prs };
}

/**
 * A listed file at an exact commit: its text as it is, a parsed JSON body back out as JSON (never "[object Object]").
 *
 * The path must be a regular blob in the commit's tree, and is read from the tree first. The contents API follows a symlink whose
 * target is a regular file in the repository and answers with that target's bytes — under every media type, `raw` and the plain
 * JSON object alike — so a listed path that is a symlink there would hand back a file the grant does not name. A tree entry is the
 * literal object at that path: `blob` at mode `100644`/`100755` is a file, `120000` is a symlink, `160000` a submodule, a `tree`
 * a directory, and a missing entry is nothing. Anything but a regular blob refuses (404), and the contents read is not made.
 */
async function file(ctx: OpsContext, s: ReturnType<typeof slugOf>, b: Body): Promise<Answer> {
  const path = String(b.path), ref = String(b.ref);
  // The commit's own tree, listed once: `git/trees/{sha}` resolves a commit to the tree it records, and a recursive listing names
  // every entry by its full path, so the entry at `path` is the literal object there.
  const t = await ctx.access.rest("GET", `/repos/${s.slug}/git/trees/${ref}?recursive=1`);
  if (t.status === 404) return { status: 404, json: { error: `${s.slug} has no ${path} at ${ref}` } };
  if (t.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}/git/trees/${ref}: ${t.status}`);
  // A truncated tree (over 100,000 entries) cannot say whether this path is a blob or something else, so it proves nothing.
  if (t.body?.truncated !== false) throw fail(502, `GitHub's tree for ${s.slug}@${ref} is truncated: ${path} cannot be placed`);
  const entry = (Array.isArray(t.body?.tree) ? t.body.tree : []).find((e: any) => e?.path === path);
  if (!entry || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return { status: 404, json: { error: `${s.slug} has no regular file ${path} at ${ref}` } };
  const r = await ctx.access.rest("GET", `/repos/${s.slug}/contents/${enc(path)}?ref=${ref}`, undefined, { accept: "application/vnd.github.raw+json" });
  if (r.status === 404) return { status: 404, json: { error: `${s.slug} has no ${path} at ${ref}` } };
  if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}/contents/${path}: ${r.status}`);
  return { status: 200, text: typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null) };
}

/**
 * A commit's parents, first parent first: the tree a merge was made on. For a merged PR, whose CI run no longer records its own
 * base (`pull_requests` is dropped on merge), the merge commit's first parent is that base. A commit GitHub has no answer for
 * is 404 to the caller; its parent list is the API's own order, and nothing here reorders or picks a different one.
 */
async function commitOf(ctx: OpsContext, s: ReturnType<typeof slugOf>, b: Body): Promise<Answer> {
  const r = await ctx.access.rest("GET", `/repos/${s.slug}/commits/${String(b.ref)}`);
  if (r.status === 404) return { status: 404, json: { error: `${s.slug} has no commit ${String(b.ref)}` } };
  if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}/commits/${String(b.ref)}: ${r.status}`);
  const parents = Array.isArray(r.body?.parents) ? r.body.parents.map((p: any) => String(p?.sha ?? "")).filter(Boolean) : [];
  return { status: 200, json: { sha: String(r.body?.sha ?? ""), parents } };
}

/**
 * Whether a path is a directory at an exact commit, as CI's own `post-checks` decides it before posting a suite's check
 * (`.github/workflows/ci.yml`): the contents API lists a directory as an array, 404s for a missing one, and an unreadable
 * answer is neither. A 404 is "not there" (a real answer); anything else unreadable throws, so the caller mints nothing.
 */
async function exists(ctx: OpsContext, s: ReturnType<typeof slugOf>, b: Body): Promise<Answer> {
  const r = await ctx.access.rest("GET", `/repos/${s.slug}/contents/${enc(String(b.path))}?ref=${String(b.ref)}`, undefined, { accept: "application/vnd.github+json" });
  if (r.status === 404) return { status: 200, json: { exists: false } };
  if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}/contents/${String(b.path)}: ${r.status}`);
  return { status: 200, json: { exists: Array.isArray(r.body) } };
}

async function commit(ctx: OpsContext, s: ReturnType<typeof slugOf>, b: Body): Promise<Answer> {
  const tip = String((await ok(ctx, "GET", `/repos/${s.slug}/branches/${enc(b.branch)}`)).body?.commit?.sha ?? "");
  if (tip !== b.parent) throw fail(409, `${s.slug} \`${b.branch}\` is at ${tip.slice(0, 12)}, not ${String(b.parent).slice(0, 12)}`);
  // The file's current blob, when it exists (an update needs it; a new file has none).
  const cur = await ctx.access.rest("GET", `/repos/${s.slug}/contents/${enc(b.path)}?ref=${encodeURIComponent(b.branch)}`).then((r) => (r.status === 200 ? String(r.body?.sha ?? "") : ""), (e) => { if ((e as { need?: { cause?: string } }).need?.cause === "unreachable") return ""; throw e; });
  const who = await ctx.access.identity();
  const message = withTrailer(String(b.message), String(b.module ?? "AidenHQ"));
  const r = await ok(ctx, "PUT", `/repos/${s.slug}/contents/${enc(b.path)}`, {
    message, content: Buffer.from(b.content, "utf8").toString("base64"), branch: b.branch, ...(cur ? { sha: cur } : {}),
    author: { name: who.name, email: who.email }, committer: { name: who.name, email: who.email },
  });
  return { status: 200, json: { sha: String(r.body?.commit?.sha ?? "") } };
}

/** The scopes that cover `admin:org`'s runner registration, GitHub's OAuth tree (its client.ts IMPLIES): any of these grants it. */
const RUNNER_SCOPES = ["admin:org", "write:org", "manage_runners:org"];
/**
 * A runner registration refused with no usable `X-Accepted-OAuth-Scopes` header (the client cannot name the scope from the
 * answer alone) is still a missing `admin:org` when the sign-in's own scopes say so: the owner's fix is the same one. GitHub
 * omits that header on some 403s, so the op derives the need from the known scopes instead of leaving a plain error.
 *
 * Only a known scope list can say a scope is absent: an empty one means the scopes could not be read (a failed grant lookup, a
 * connection that is not signed in), and a 403 with nothing to compare is the plain error it was, never a guessed need.
 */
const missingRunnerScope = (ctx: OpsContext) => {
  const scopes = ctx.access.scopes();
  return scopes.length > 0 && !RUNNER_SCOPES.some((s) => scopes.includes(s));
};

/** One op's answer: a status, then a JSON body (or, for fetch, the bundle's open file stream in `json`). */
export async function answerOp(op: string, b: Body, ctx: OpsContext): Promise<Answer> {
  if (op === "runner_token") {
    if (!/^[\w.-]+$/.test(String(b.org ?? ""))) throw fail(400, `${String(b.org)} is not an org`);
    const path = `/orgs/${b.org}/actions/runners/registration-token`;
    // The client classifies a 403 with a usable X-Accepted-OAuth-Scopes as a scope need and throws it here unchanged; a 403
    // it could not classify comes back as an answer, and is still the owner's missing runner permission when the sign-in's
    // own scopes say admin:org is absent. Otherwise it stays the plain error it was.
    const r = await ctx.access.rest("POST", path);
    if (r.status >= 300) {
      if (r.status === 403 && missingRunnerScope(ctx)) throw Object.assign(fail(403, `GitHub needs the \`admin:org\` permission: reconnect GitHub on the board (Settings, Connections)`), { need: { cause: "scope", scope: "admin:org" } });
      throw fail(r.status === 409 ? 409 : 502, `GitHub POST ${path}: ${r.status} ${r.body?.message ?? ""}`.trim());
    }
    return { status: 200, json: { token: r.body?.token, expires_at: r.body?.expires_at } };
  }
  const s = slugOf(b.repo);
  // A session box's git credential: an installation token for this one repo, contents and pull requests only. The App's token,
  // never the owner's: the kernel asks only for a repo a session may reach (jobtools.ts gitToken).
  if (op === "app_token") {
    const installation = await ctx.app?.installation(s.slug);
    if (installation == null) throw fail(409, `the GitHub App isn't set up or isn't installed on ${s.slug}: set up the GitHub App (#/setup/github-app) and install it there`);
    return { status: 200, json: await ctx.app!.mint(installation, { repositories: [s.name], permissions: { contents: "write", pull_requests: "write" } }) };
  }
  if (op === "fetch") return bundleOf(ctx, s, String(b.ref));
  if (op === "head") return { status: 200, json: { sha: String((await ok(ctx, "GET", `/repos/${s.slug}/branches/${enc(String(b.ref))}`)).body?.commit?.sha ?? "") } };
  if (op === "read" && b.kind === "file") return file(ctx, s, b);
  if (op === "read" && b.kind === "exists") return exists(ctx, s, b);
  if (op === "read" && b.kind === "commit") return commitOf(ctx, s, b);
  if (op === "read") return read(ctx, s, b);
  if (op === "comment") {
    const body = withFooter(String(b.body), String(b.module ?? "AidenHQ"));
    // Editing a comment: only one AidenHQ posted (the kernel records each new comment's ref).
    if (b.id && !(await ctx.ours(`github:${s.slug}#${Number(b.number)}/comment/${Number(b.id)}`))) throw fail(403, `comment ${String(b.id)} isn't one AidenHQ posted: it can't be edited`);
    const r = b.id ? await ok(ctx, "PATCH", `/repos/${s.slug}/issues/comments/${b.id}`, { body }) : await ok(ctx, "POST", `/repos/${s.slug}/issues/${b.number}/comments`, { body });
    return { status: 200, json: { id: r.body?.id } };
  }
  if (op === "commit") return commit(ctx, s, b);
  throw fail(404, `no such operation ${op}`);
}

/** POST /ops/<op> from the kernel (already authenticated by the caller): the answer, or an error naming its cause and fix. */
export async function serveOps(req: IncomingMessage, res: ServerResponse, ctx: OpsContext): Promise<void> {
  const op = /^\/ops\/(fetch|head|read|comment|commit|runner_token|app_token)$/.exec(String(req.url ?? ""))?.[1];
  if (!op) throw fail(404, "no such operation");
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 2_000_000) throw fail(413, "request too large"); }
  const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  // The token in an error (a git failure that echoed its environment, a GitHub message) never reaches the answer.
  const scrub = async (text: string) => { try { const t = await ctx.access.token(); return t ? text.split(t).join("***") : text; } catch { return text; } };
  try {
    const a = await answerOp(op, JSON.parse(raw || "{}"), ctx);
    if (a.stream) {
      res.writeHead(a.status, { "content-type": "application/octet-stream" });
      a.stream.pipe(res);
      await once(a.stream, "close");
      return;
    }
    if (a.text !== undefined) res.writeHead(a.status, { "content-type": "text/plain; charset=utf-8" }).end(a.text);
    else send(a.status, a.json);
  } catch (e) {
    const err = e as { status?: number; message: string; need?: { cause: string } };
    const message = await scrub(err.message);
    // A typed GitHub need: what is wrong, and (owner-fixable) that the owner was told.
    if (err.need) send({ not_connected: 503, expired: 503, scope: 403, sso: 403, restricted: 403, unreachable: 404, rate_limited: 429 }[err.need.cause] ?? 502, { error: message, need: err.need });
    else send(err.status ?? 500, { error: message });
  }
}

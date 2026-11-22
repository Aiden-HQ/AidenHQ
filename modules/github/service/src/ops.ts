// The typed GitHub operations other modules ask the kernel for (POST /v1/codehost/:op → here, /ops/<op>), each run on the
// owner's sign-in inside this process: fetch, head, read, comment, commit, runner_token. The kernel has checked the caller's
// grant and the shape of every field; the owner's token never leaves this process, so no answer, header or error carries it
// (errors are scrubbed of it as a last guard). snapshot, clone and bundle stay in service.ts.
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { join } from "node:path";
import type { GitHubAccess } from "../../connections/github-mcp/src/client.ts";
import { withFooter, withTrailer } from "./aidenhq-sdk/attribution.ts";

export type OpsContext = {
  access: GitHubAccess;
  /** The repo's bare cache clone's directory, made on first use. */
  cache: (s: { org: string; name: string; slug: string }) => Promise<string>;
  /** git against a bare directory with the hardened arguments; the token (when given) goes to that one command's credential env. */
  git: (dir: string, args: string[], token?: string) => Promise<string>;
  /** A branch of the repo on GitHub fetched into the cache: its directory, local ref and sha (service.ts fetchRemote). */
  fetchRemote: (s: { org: string; name: string; slug: string }, name: string) => Promise<{ dir: string; ref: string; sha: string }>;
  cacheDir: string;
  /** Makes a scratch bare repo (init --bare) at `dir`. */
  initBare: (dir: string) => Promise<void>;
  /** Whether the kernel's records name this GitHub object (a ref like `github:o/r#1/comment/2`) as made by AidenHQ. */
  ours: (ref: string) => Promise<boolean>;
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
    pullRequest(number: $number) {
      number title body url state headRefOid headRefName baseRefName baseRefOid mergedAt mergeCommit { oid }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      history: commits(last: 30) { nodes { commit { oid tree { oid } parents(first: 1) { totalCount } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
      baseRef { target { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
    }
  }
}`;
const ISSUE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number url state stateReason closedAt labels(first: 20) { nodes { name } }
      closedEvents: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { __typename login } closer { __typename ... on PullRequest { number url state mergedAt mergeCommit { oid } repository { nameWithOwner } } } } } }
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
    if (r.body?.errors?.length || !r.body?.data?.repository?.[what]) throw fail(502, `GitHub has no readable ${s.slug}#${b.number}: ${JSON.stringify(r.body?.errors ?? []).slice(0, 200)}`);
    return r.body.data;
  };
  if (b.kind === "pr") return { status: 200, json: await graph(PR_QUERY, "pullRequest") };
  if (b.kind === "issue") return { status: 200, json: await graph(ISSUE_QUERY, "issue") };
  if (b.kind === "diff") return { status: 200, text: String((await ok(ctx, "GET", `/repos/${s.slug}/pulls/${b.number}`, undefined, { accept: "application/vnd.github.diff" })).body ?? "") };
  if (b.kind === "job") {
    const r = await ctx.access.rest("GET", `/repos/${s.slug}/actions/jobs/${b.id}`);
    if (r.status === 404) return { status: 200, json: null };
    // A permission refusal (the access layer already types rate limits and sign-in problems) stays a 403: the caller may try another repo.
    if (r.status >= 300) throw fail(r.status === 403 ? 403 : 502, `GitHub GET /repos/${s.slug}/actions/jobs/${b.id}: ${r.status}`);
    const j = r.body;
    return { status: 200, json: { id: j.id, name: j.name, state: j.status, conclusion: j.conclusion, run_id: j.run_id, url: j.html_url } };
  }
  // prs: every open PR, newest page first up to 500.
  const prs: { number: number; sha: string; base: string; head_repo: string | null }[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = (await ok(ctx, "GET", `/repos/${s.slug}/pulls?state=open&per_page=100&page=${page}`)).body as any[];
    for (const p of r) prs.push({ number: p.number, sha: p.head?.sha, base: p.base?.ref, head_repo: p.head?.repo?.full_name ?? null });
    if (r.length < 100) break;
  }
  return { status: 200, json: prs };
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
  if (op === "fetch") return bundleOf(ctx, s, String(b.ref));
  if (op === "head") return { status: 200, json: { sha: String((await ok(ctx, "GET", `/repos/${s.slug}/branches/${enc(String(b.ref))}`)).body?.commit?.sha ?? "") } };
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
  const op = /^\/ops\/(fetch|head|read|comment|commit|runner_token)$/.exec(String(req.url ?? ""))?.[1];
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

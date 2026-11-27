// The typed GitHub operations other modules ask the kernel for (POST /v1/codehost/:op → here, /ops/<op>): fetch, head, read,
// comment, commit, runner_token and app_token. Each write goes as the actor client.ts's actorFor picks for its op (the instance's
// GitHub App where installed with the permission, else the owner; runner_token is always the owner's, app_token always the App's).
// The kernel has checked the caller's grant and the shape of every field; the owner's token never leaves this process, so no
// answer, header or error carries it (errors are scrubbed of it as a last guard). snapshot, clone and bundle stay in service.ts.
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { join } from "node:path";
import type { Actor, GitHubAccess } from "../../connections/github-mcp/src/client.ts";
import type { GitHubApp } from "../../connections/github-mcp/src/github-app.ts";
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
  /** Whether the change feed reads this repo (service.ts feedWatched): the repo's fork and archived flags as GitHub reports them. */
  feedWatched: (slug: string, repo: { isFork?: boolean; isArchived?: boolean }) => boolean;
  /** Makes a scratch bare repo (init --bare) at `dir`. */
  initBare: (dir: string) => Promise<void>;
  /** Whether the kernel's records name this GitHub object (a ref like `github:o/r#1/comment/2`) as made by AidenHQ. */
  ours: (ref: string) => Promise<boolean>;
  /** The instance's GitHub App (github-mcp's gitHubApp): where it is installed, a repo-narrowed token from it, and who it is. */
  app?: Pick<GitHubApp, "installed" | "mint" | "identity">;
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

// A PR's state as callers read it: sessions (merged, its merge commit, whether the change feed watches the repo) and apps-mcp
// (open, draft, created).
const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    isFork isArchived
    pullRequest(number: $number) { number url state isDraft createdAt mergedAt mergeCommit { oid } }
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
  if (b.kind === "pr") {
    const r = await ok(ctx, "POST", "/graphql", { query: PR_QUERY, variables: { owner: s.org, repo: s.name, number: b.number } });
    // An error is no answer: the caller waits and asks again.
    const noAnswer = () => fail(502, `GitHub has no readable ${s.slug}#${b.number}: ${JSON.stringify(r.body?.errors ?? []).slice(0, 200)}`);
    // GitHub's own NOT_FOUND is its word that the repository or PR is not there (the nulls below), not a failure.
    const nulled = r.body?.data?.repository === null || r.body?.data?.repository?.pullRequest === null;
    const gone = nulled && r.body.errors?.length && r.body.errors.every((e: any) => e?.type === "NOT_FOUND");
    if (r.body?.errors?.length && !gone) throw noAnswer();
    const data = r.body?.data;
    if (!data || typeof data !== "object") throw noAnswer();
    const repo = data.repository;
    if (repo === null) return { status: 200, json: { repository: null } };
    if (!repo || typeof repo !== "object") throw noAnswer();
    // Whether the change feed watches the repo, so a consumer that waits on its events (sessions) knows they will come.
    return { status: 200, json: { ...data, repository: { ...repo, feedWatched: ctx.feedWatched(s.slug, repo) } } };
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

async function commit(ctx: OpsContext, s: ReturnType<typeof slugOf>, b: Body): Promise<Answer> {
  // GitHub makes the commit (createCommitOnBranch) as the write's actor, with no custom author, bound to `parent`
  // (expectedHeadOid): a branch that moved refuses it.
  const actor = await ctx.access.actorFor({ repo: s.slug }, "contents");
  const [headline, ...rest] = withTrailer(String(b.message), String(b.module ?? "AidenHQ")).split("\n");
  const input = {
    branch: { repositoryNameWithOwner: s.slug, branchName: String(b.branch) }, expectedHeadOid: String(b.parent),
    message: { headline: headline!.slice(0, 250), body: rest.join("\n").trim() },
    fileChanges: { additions: [{ path: String(b.path), contents: Buffer.from(String(b.content), "utf8").toString("base64") }] },
  };
  const r = await actor.mutate("CREATE_COMMIT", { input });
  const sha = r.body?.data?.createCommitOnBranch?.commit?.oid;
  if (r.status < 300 && !r.body?.errors?.length && sha) return { status: 200, json: { sha: String(sha) } };
  const why = String((r.body?.errors ?? []).map((e: { message?: unknown }) => String(e?.message ?? "")).filter(Boolean).join("; ") || r.body?.message || `HTTP ${r.status}`);
  // A moved branch is the caller's 409 (read again and retry); anything else GitHub's refusal.
  const tip = String((await ok(ctx, "GET", `/repos/${s.slug}/branches/${enc(String(b.branch))}`).catch(() => undefined))?.body?.commit?.sha ?? "");
  if (tip && tip !== b.parent) throw fail(409, `${s.slug} \`${b.branch}\` is at ${tip.slice(0, 12)}, not ${String(b.parent).slice(0, 12)}`);
  throw fail(502, `GitHub refused the commit on ${s.slug} \`${b.branch}\`: ${why.slice(0, 300)}`);
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
    // runner_token asks no App permission (OPS): the owner's, by the rule.
    const r = await (await ctx.access.actorFor({ org: String(b.org) }, "runner_token")).rest("POST", path);
    if (r.status >= 300) {
      if (r.status === 403 && missingRunnerScope(ctx)) throw Object.assign(fail(403, `GitHub needs the \`admin:org\` permission: reconnect GitHub on the board (Settings, Connections)`), { need: { cause: "scope", scope: "admin:org" } });
      throw fail(r.status === 409 ? 409 : 502, `GitHub POST ${path}: ${r.status} ${r.body?.message ?? ""}`.trim());
    }
    return { status: 200, json: { token: r.body?.token, expires_at: r.body?.expires_at } };
  }
  const s = slugOf(b.repo);
  // A session box's git credential: an installation token for this one repo, narrowed to contents, pull requests, issues and
  // workflows, each only where the installation accepted it. The App's token, never the owner's (none where the App isn't
  // installed): the kernel asks only for a repo a session may reach (jobtools.ts gitToken).
  if (op === "app_token") {
    const inst = await ctx.app?.installed(s.slug);
    if (!inst) throw fail(409, `the GitHub App isn't set up or isn't installed on ${s.slug}: set up the GitHub App (/setup/github-app) and install it there`);
    const permissions = Object.fromEntries(BOX_PERMISSIONS.filter((p) => inst.permissions[p] === "write" || inst.permissions[p] === "admin").map((p) => [p, "write"]));
    if (!permissions.contents) throw fail(409, `the GitHub App's installation on ${s.slug} hasn't accepted Contents write: accept the App's permissions on that installation`);
    return { status: 200, json: await ctx.app!.mint(inst.id, { repositories: [s.name], permissions }) };
  }
  if (op === "fetch") return bundleOf(ctx, s, String(b.ref));
  if (op === "head") return { status: 200, json: { sha: String((await ok(ctx, "GET", `/repos/${s.slug}/branches/${enc(String(b.ref))}`)).body?.commit?.sha ?? "") } };
  if (op === "read") return read(ctx, s, b);
  if (op === "comment") {
    const body = withFooter(String(b.body), String(b.module ?? "AidenHQ"));
    // Editing a comment: only one AidenHQ posted (the kernel records each new comment's ref).
    if (b.id && !(await ctx.ours(`github:${s.slug}#${Number(b.number)}/comment/${Number(b.id)}`))) throw fail(403, `comment ${String(b.id)} isn't one AidenHQ posted: it can't be edited`);
    const actor = await ctx.access.actorFor({ repo: s.slug }, "issue");
    // Only the actor's own comment is edited: one the other identity made (before a switch) stays, and this actor posts its own.
    const n = Number(b.number), patch = async (id: unknown) => (await authorIs(ctx, actor, s.slug, id)) ? actor.rest("PATCH", `/repos/${s.slug}/issues/comments/${id}`, { body }) : { status: 0, body: {} };
    // One post-or-edit at a time per PR, so two callers can't both find no comment and each create one.
    const key = `${s.slug}#${n}`;
    const run = (commentTails.get(key) ?? Promise.resolve()).then(async () => {
      let r = b.id ? await patch(b.id) : undefined;
      // With no id (or one whose comment is gone), a `marker` finds the comment an earlier post made: only one AidenHQ posted (the same
      // check as an edit by id), whose text begins with the marker. Else a new one.
      // No id, one whose comment is gone (with a marker), or another identity's (status 0): find or post this actor's own.
      if (!r || r.status === 0 || (r.status === 404 && b.marker)) {
        const id = b.marker ? await markedComment(ctx, actor, s.slug, n, String(b.marker)) : undefined;
        r = id ? await patch(id) : await actor.rest("POST", `/repos/${s.slug}/issues/${n}/comments`, { body });
      }
      if (r.status >= 300) throw fail(r.status === 409 ? 409 : 502, `GitHub comment: ${r.status} ${r.body?.message ?? ""}`.trim());
      return r.body?.id;
    });
    commentTails.set(key, run.then(() => {}, () => {}));
    return { status: 200, json: { id: await run } };
  }
  if (op === "commit") return commit(ctx, s, b);
  throw fail(404, `no such operation ${op}`);
}

const commentTails = new Map<string, Promise<void>>();

/** The box token's permissions, each asked only where the installation accepted it (contents is required). */
const BOX_PERMISSIONS = ["contents", "pull_requests", "issues", "workflows"];

/** Whether comment `id` on `slug` was written by `actor` (its login), so it may edit it. */
async function authorIs(ctx: OpsContext, actor: Actor, slug: string, id: unknown): Promise<boolean> {
  const r = await ctx.access.rest("GET", `/repos/${slug}/issues/comments/${Number(id)}`);
  if (r.status === 404) return true; // gone: the PATCH answers it as it did
  if (r.status >= 300) throw fail(502, `GitHub GET comment ${Number(id)}: ${r.status}`);
  return String(r.body?.user?.login ?? "").toLowerCase() === (await actor.identity()).login.toLowerCase();
}

/** The newest comment on the PR that AidenHQ posted as `actor` (the kernel's records, as for an edit by id) and whose text begins with `marker`, or undefined. */
async function markedComment(ctx: OpsContext, actor: Actor, slug: string, number: number, marker: string): Promise<number | undefined> {
  const me = (await actor.identity()).login.toLowerCase();
  let found: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const cs = (await ok(ctx, "GET", `/repos/${slug}/issues/${number}/comments?per_page=100&page=${page}`)).body;
    if (!Array.isArray(cs)) break;
    for (const c of cs) if (String(c?.body ?? "").startsWith(marker) && String(c?.user?.login ?? "").toLowerCase() === me && await ctx.ours(`github:${slug}#${number}/comment/${c.id}`)) found = Number(c.id);
    if (cs.length < 100) break;
  }
  return found;
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
    // The App's own failure (broken, or refused by GitHub) is no sign-in need: a plain error, so the kernel never asks the owner to
    // reconnect for it.
    if (err.need?.cause === "app_broken" || err.need?.cause === "app_refused") send(err.need.cause === "app_refused" ? 403 : 502, { error: message });
    // A typed GitHub need: what is wrong, and (owner-fixable) that the owner was told.
    else if (err.need) send({ not_connected: 503, expired: 503, scope: 403, sso: 403, restricted: 403, unreachable: 404, rate_limited: 429 }[err.need.cause] ?? 502, { error: message, need: err.need });
    else send(err.status ?? 500, { error: message });
  }
}

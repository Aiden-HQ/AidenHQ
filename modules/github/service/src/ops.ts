// The typed GitHub operations other modules ask the kernel for (POST /v1/codehost/:op → here, /ops/<op>), each run on the
// owner's sign-in inside this process: fetch, head, read, comment, commit, runner_token. The kernel has checked the caller's
// grant and the shape of every field; the owner's token never leaves this process, so no answer, header or error carries it
// (errors are scrubbed of it as a last guard). snapshot, clone and bundle stay in service.ts.
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
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
  fetch?: typeof fetch;
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

const LOG_MAX = 30_000_000;
const ZIP_ENTRIES = 200;
const ZIP_OUT = 4_000_000;

function zipText(buf: Buffer): string | undefined {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return undefined;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return undefined;
  const count = buf.readUInt16LE(eocd + 10), parts: string[] = [];
  let at = buf.readUInt32LE(eocd + 16), out = 0, cut = count > ZIP_ENTRIES;
  for (let n = 0; n < Math.min(count, ZIP_ENTRIES) && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42), start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    at += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50 || start + size > buf.length) continue;
    let entry: Buffer;
    try { entry = method === 0 ? buf.subarray(start, start + size) : method === 8 ? inflateRawSync(buf.subarray(start, start + size), { maxOutputLength: ZIP_OUT - out }) : Buffer.alloc(0); }
    catch { cut = true; continue; }
    if (!entry.length) continue;
    out += entry.length; parts.push(entry.toString("utf8"));
    if (out >= ZIP_OUT) { cut = true; break; }
  }
  if (!parts.length) return undefined;
  return cut ? `${parts.join("\n")}\n[cut: log unpacked only to ${ZIP_OUT} bytes]` : parts.join("\n");
}

const LOG_HOSTS = [/(^|\.)actions\.githubusercontent\.com$/, /^productionresultssa\d*\.blob\.core\.windows\.net$/];
function logHostAllowed(to: string): boolean {
  try {
    const u = new URL(to);
    return u.protocol === "https:" && LOG_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}
function bounded(text: string, bytes: number): string {
  if (text.length <= bytes) return text;
  const head = Math.floor(bytes / 4);
  return `${text.slice(0, head)}\n[cut: ${text.length - bytes} bytes not shown]\n${text.slice(-(bytes - head))}`;
}

// A PR and an issue as the grader reads them.
const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title body url state headRefOid headRefName baseRefName mergedAt mergeCommit { oid }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      history: commits(last: 30) { nodes { commit { oid tree { oid } parents(first: 1) { totalCount } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { databaseId name status conclusion } ... on StatusContext { context state } } } } } } }
      baseRef { target { oid ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
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
    if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}/actions/jobs/${b.id}: ${r.status}`);
    const j = r.body;
    // The job's Test step, its run's base and the workflow that owns it; unreadable is no evidence.
    const get = async (path: string) => {
      try { const a = await ctx.access.rest("GET", path); return a.status < 300 ? a.body : undefined; } catch { return undefined; }
    };
    const run = j.run_id ? await get(`/repos/${s.slug}/actions/runs/${j.run_id}`) : undefined;
    const workflow = run?.workflow_id ? await get(`/repos/${s.slug}/actions/workflows/${run.workflow_id}`) : undefined;
    const bases = new Set((run?.pull_requests ?? []).filter((p: any) => p?.head?.sha === run?.head_sha && p?.base?.sha).map((p: any) => String(p.base.sha)));
    const base = bases.size === 1 ? String([...bases][0]) : null;
    return { status: 200, json: { id: j.id, name: j.name, state: j.status, conclusion: j.conclusion, run_id: j.run_id, run_base: base,
      workflow_path: workflow?.path ?? null, workflow_state: workflow?.state ?? null, event: run?.event ?? null, head_sha: run?.head_sha ?? null, url: j.html_url,
      steps: (Array.isArray(j.steps) ? j.steps : []).map((s: any) => ({ name: String(s?.name ?? ""), state: String(s?.status ?? ""), conclusion: String(s?.conclusion ?? "") })) } };
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

async function file(ctx: OpsContext, s: ReturnType<typeof slugOf>, b: Body): Promise<Answer> {
  const r = await ctx.access.rest("GET", `/repos/${s.slug}/contents/${enc(String(b.path))}?ref=${String(b.ref)}`, undefined, { accept: "application/vnd.github.raw+json" });
  if (r.status === 404) return { status: 404, json: { error: `${s.slug} has no ${String(b.path)} at ${String(b.ref)}` } };
  if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}/contents/${String(b.path)}: ${r.status}`);
  return { status: 200, text: typeof r.body === "string" ? r.body : String(r.body ?? "") };
}

async function jobLog(ctx: OpsContext, s: ReturnType<typeof slugOf>, b: Body, bytes: number): Promise<Answer> {
  // Only ci.yml's own pull_request runs are evidence.
  const notEvidence = (): Answer => ({ status: 404, json: { error: `${s.slug} job ${b.id} is not a ci.yml pull request job` } });
  const job = (await ctx.access.rest("GET", `/repos/${s.slug}/actions/jobs/${b.id}`)).body;
  const run = job?.run_id ? (await ctx.access.rest("GET", `/repos/${s.slug}/actions/runs/${job.run_id}`)).body : undefined;
  if (!job?.run_id || run?.path !== ".github/workflows/ci.yml" || run?.event !== "pull_request") return notEvidence();
  const url = new URL(`/repos/${s.slug}/actions/jobs/${b.id}/logs`, "https://api.github.com");
  const doFetch = ctx.fetch ?? fetch;
  const headers = { authorization: `Bearer ${await ctx.access.token()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "aidenhq-codehost" };
  const res = await doFetch(url, { method: "GET", redirect: "manual", headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return { status: 404, json: { error: `GitHub has no job ${b.id} in ${s.slug}` } };
  if (res.status !== 302) throw fail(502, `GitHub GET /repos/${s.slug}/actions/jobs/${b.id}/logs: ${res.status}`);
  const to = res.headers.get("location") ?? "";
  if (!logHostAllowed(to)) throw fail(502, `GitHub job ${b.id} log points somewhere other than GitHub's log hosts`);
  const dl = await doFetch(to, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!dl.ok) throw fail(502, `the job ${b.id} log download answered ${dl.status}`);
  if (Number(dl.headers.get("content-length") ?? 0) > LOG_MAX) throw fail(502, `GitHub job ${b.id} log is over ${LOG_MAX} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for (const reader = dl.body!.getReader();;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.length;
    if (total > LOG_MAX) { await reader.cancel(); throw fail(502, `GitHub job ${b.id} log is over ${LOG_MAX} bytes`); }
    chunks.push(Buffer.from(part.value));
  }
  const raw = Buffer.concat(chunks);
  return { status: 200, text: bounded(zipText(raw) ?? raw.toString("utf8"), bytes) };
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

/** One op's answer: a status, then a JSON body (or, for fetch, the bundle's open file stream in `json`). */
export async function answerOp(op: string, b: Body, ctx: OpsContext): Promise<Answer> {
  if (op === "runner_token") {
    if (!/^[\w.-]+$/.test(String(b.org ?? ""))) throw fail(400, `${String(b.org)} is not an org`);
    const r = await ok(ctx, "POST", `/orgs/${b.org}/actions/runners/registration-token`);
    return { status: 200, json: { token: r.body?.token, expires_at: r.body?.expires_at } };
  }
  const s = slugOf(b.repo);
  if (op === "fetch") return bundleOf(ctx, s, String(b.ref));
  if (op === "head") return { status: 200, json: { sha: String((await ok(ctx, "GET", `/repos/${s.slug}/branches/${enc(String(b.ref))}`)).body?.commit?.sha ?? "") } };
  if (op === "read" && b.kind === "file") return file(ctx, s, b);
  if (op === "read" && b.kind === "log") return jobLog(ctx, s, b, Math.min(30_000_000, Math.max(1_000, Number(b.bytes) || 512_000)));
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { answerOp, type OpsContext } from "../service/src/ops.ts";

/** The ops' context with a fake GitHub: only what the read ops reach. */
const ctx = (): OpsContext => ({
  access: {
    connected: () => true, token: async () => "tok", scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), lines: [], graphql: async () => ({}),
    identity: async () => ({ login: "o", name: "O", email: "o@example.com" }),
    rest: async () => ({ status: 404, body: {}, headers: new Headers() }),
  } as unknown as OpsContext["access"],
  cacheDir: "/tmp", feedWatched: () => true, cache: async () => "/tmp", git: async () => "", fetchRemote: async () => ({ dir: "/tmp", ref: "", sha: "" }), initBare: async () => {}, ours: async () => false,
});
/** The context answering every REST call with `rest`. */
const withRest = (c: OpsContext, rest: OpsContext["access"]["rest"]): OpsContext => ({ ...c, access: { ...c.access, rest } as unknown as OpsContext["access"] });
const ok = (body: unknown) => ({ status: 200, body, headers: new Headers() });
const sha = "a".repeat(40);

/** A tree listing with the given entries: what the `file` read places a path in before it reads any content. */
const tree = (entries: { path: string; mode: string; type: string }[], truncated = false) => ok({ sha: "t", truncated, tree: entries });
const BLOB = { mode: "100644", type: "blob" };

test("a file at an exact commit is its text — a parsed JSON body goes back out as JSON, never [object Object]", async () => {
  const c = ctx();
  const areas = { path: ".github/ci/areas.json", ...BLOB };
  const parsed = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: sha },
    withRest(c, async (_m, path) => path.includes("/git/trees/") ? tree([areas]) : ok({ suites: [] })));
  assert.equal(parsed.text, "{\"suites\":[]}", "a parsed JSON file is serialized back, not stringified as an object");
  assert.doesNotMatch(parsed.text, /object Object/);
  const yml = { path: ".github/workflows/ci.yml", ...BLOB };
  const raw = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/workflows/ci.yml", ref: sha },
    withRest(c, async (_m, path) => path.includes("/git/trees/") ? tree([yml]) : ok("name: ci\njobs: {}\n")));
  assert.equal(raw.text, "name: ci\njobs: {}\n", "a non-JSON file (ci.yml is YAML) stays its own text");
  assert.equal((await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: sha }, c)).status, 404, "no tree at all is no file");
});

test("a granted path that is a symlink, a submodule or a directory at the commit mints nothing: only a regular blob is read", async () => {
  // The contents API dereferences a symlink whose target is a regular file and answers with that file's bytes, so the literal tree
  // entry is what confines a read to the grant. Nothing but a blob at 100644/100755 is the file the grant names.
  const c = ctx();
  const path = ".github/ci/areas.json";
  for (const entry of [
    { path, mode: "120000", type: "blob" },  // a symlink: its mode is what makes it one, and the contents API would follow it
    { path, mode: "160000", type: "commit" }, // a submodule
    { path, mode: "040000", type: "tree" },   // a directory
  ]) {
    let read = false;
    const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path, ref: sha },
      withRest(c, async (_m, p) => (p.includes("/git/trees/") ? tree([entry]) : ((read = true), ok("SECRETS=1\n")))));
    assert.equal(a.status, 404, JSON.stringify(entry));
    assert.equal(read, false, `the contents of a ${entry.type}/${entry.mode} are never read`);
  }
  // A path the tree does not carry is not there, whatever the contents endpoint would answer for a nearby name.
  const missing = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path, ref: sha },
    withRest(c, async (_m, p) => (p.includes("/git/trees/") ? tree([{ path: ".github/ci/other.json", ...BLOB }]) : ok("SECRETS=1\n"))));
  assert.equal(missing.status, 404);
  // A truncated listing cannot place the path, so it proves nothing — never a fallback to the contents read.
  await assert.rejects(() => answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path, ref: sha },
    withRest(c, async (_m, p) => (p.includes("/git/trees/") ? tree([{ path, ...BLOB }], true) : ok("SECRETS=1\n")))), /truncated/);
  // A regular blob — 100644 or the executable 100755 — is the file.
  const runnable = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path, ref: sha },
    withRest(c, async (_m, p) => (p.includes("/git/trees/") ? tree([{ path, mode: "100755", type: "blob" }]) : ok("ok\n"))));
  assert.equal(runnable.text, "ok\n");
});

test("the run's latest shard jobs come from the filter=latest query, one instance per shard name", async () => {
  const c = ctx();
  const asked: string[] = [];
  const rest = async (_m: string, path: string) => {
    asked.push(path);
    if (path.includes("filter=latest")) return ok({ total_count: 3, jobs: [
      { name: "packages (1)", id: 601, run_attempt: 2, status: "completed", conclusion: "failure" },
      { name: "modules (1)", id: 602, run_attempt: 1, status: "completed", conclusion: "success" },
      { name: "post-checks", id: 603, run_attempt: 2, status: "completed", conclusion: "success" },
    ] });
    if (path.includes("/jobs")) return ok({ total_count: 0, jobs: [] });
    if (path.includes("/actions/workflows/")) return ok({ path: ".github/workflows/ci.yml", state: "active" });
    return ok({ id: 900, run_attempt: 2, event: "pull_request", head_sha: "h", status: "completed", workflow_id: 9, pull_requests: [] });
  };
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, rest));
  assert.ok(asked.some((p) => p.includes("filter=latest")), "the latest instance of each shard needs its own query");
  assert.deepEqual(a.json.latest_shard_jobs, {
    "packages (1)": { id: 601, run_attempt: 2, state: "completed", conclusion: "failure" },
    "modules (1)": { id: 602, run_attempt: 1, state: "completed", conclusion: "success" },
  }, "only shard jobs, one per name, with the newest attempt each: a shard re-run to failure keeps only the failure");
  // An unreadable latest query is no map at all, and the fact refuses on it (evidence.ts requires the entry).
  const unreadable = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 },
    withRest(c, async (_m, path) => path.includes("filter=latest") ? { status: 502, body: {}, headers: new Headers() } : rest(_m, path)));
  assert.deepEqual(unreadable.json.latest_shard_jobs, {});
});

test("an exists read answers only whether a path is a directory at a commit: 404 is not there, a listing is, a file is not", async () => {
  const c = ctx();
  const ref = "a".repeat(40);
  const asDir = await answerOp("read", { module: "grading", repo: "acme/app", kind: "exists", path: "kernel", ref }, withRest(c, async () => ok([{ name: "a.ts", type: "file" }])));
  assert.deepEqual(asDir.json, { exists: true }, "a directory lists as an array");
  const asFile = await answerOp("read", { module: "grading", repo: "acme/app", kind: "exists", path: "kernel/x.ts", ref }, withRest(c, async () => ok({ name: "x.ts", type: "file" })));
  assert.deepEqual(asFile.json, { exists: false }, "a file is not a directory (run-suites.sh tests -d)");
  const gone = await answerOp("read", { module: "grading", repo: "acme/app", kind: "exists", path: "kernel", ref }, c);
  assert.deepEqual(gone.json, { exists: false }, "a 404 is a real answer: not there");
  await assert.rejects(() => answerOp("read", { module: "grading", repo: "acme/app", kind: "exists", path: "kernel", ref }, withRest(c, async () => ({ status: 502, body: {}, headers: new Headers() }))), /502/, "an unreadable answer throws, so the caller mints nothing");
});

test("a workflow run's identity is its workflow, event, head, attempt and its own base", async () => {
  const c = ctx();
  const rest = async (_m: string, path: string) => path.includes("/jobs") ?
    ok({ total_count: 2, jobs: [{ name: "modules (3)", id: 500, run_attempt: 2, status: "completed", conclusion: "success" }, { name: "post-checks", run_attempt: 2, status: "completed", conclusion: "success" }] }) :
    path.includes("/actions/workflows/") ? ok({ path: ".github/workflows/ci.yml", state: "active" }) :
    ok({ id: 900, run_attempt: 2, event: "pull_request", head_sha: "h", status: "completed", workflow_id: 9, pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }] });
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, rest));
  assert.deepEqual(a.json, { id: 900, run_attempt: 2, event: "pull_request", head_sha: "h", status: "completed", workflow_id: 9,
    workflow_path: ".github/workflows/ci.yml", workflow_state: "active", base_sha: "base",
    post_checks: [{ run_attempt: 2, state: "completed", conclusion: "success" }],
    latest_shard_jobs: { "modules (3)": { id: 500, run_attempt: 2, state: "completed", conclusion: "success" } } },
    "the run carries its post-checks instances and each shard's latest instance, so a fact can require CI's own poster and refuse a superseded pass");
  assert.equal((await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 901 }, withRest(c, async () => ({ status: 404, body: {}, headers: new Headers() })))).json, null, "a run GitHub has no answer for is null");
  // Two PRs on one head, two bases: ambiguous, no base at all (never one of them picked).
  const two = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, async (_m, path) => path.includes("/jobs") ? ok({ total_count: 0, jobs: [] }) : path.includes("/actions/workflows/") ? ok({ path: ".github/workflows/ci.yml", state: "active" }) :
    ok({ id: 900, head_sha: "h", pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }, { head: { sha: "h" }, base: { sha: "x" } }] })));
  assert.equal(two.json.base_sha, null);
  // A run whose workflow can't be read names no workflow: no fact, never a guess.
  const unreadable = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, async (_m, path) => path.includes("/actions/workflows/") ? { status: 500, body: {}, headers: new Headers() } : rest(_m, path)));
  assert.equal(unreadable.json.workflow_path, null);
  // A jobs list GitHub refuses is no poster at all: the fact refuses on the empty list, never a guess.
  const noJobs = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, async (_m, path) => path.includes("/jobs") ? { status: 502, body: {}, headers: new Headers() } : rest(_m, path)));
  assert.deepEqual(noJobs.json.post_checks, []);
});

test("a commit read answers its parents in the API's order, first parent first, and the tree it records; a 404 is no commit", async () => {
  const c = ctx();
  const parents = [{ sha: "b".repeat(40) }, { sha: "c".repeat(40) }];
  const tree = "t".repeat(40);
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "commit", ref: sha }, withRest(c, async () => ok({ sha, parents, commit: { tree: { sha: tree } } })));
  assert.deepEqual(a.json, { sha, parents: ["b".repeat(40), "c".repeat(40)], tree }, "the merge commit's first parent is the base, and its tree is the code it records");
  const noTree = await answerOp("read", { module: "grading", repo: "acme/app", kind: "commit", ref: sha }, withRest(c, async () => ok({ sha, parents })));
  assert.deepEqual(noTree.json, { sha, parents: ["b".repeat(40), "c".repeat(40)] }, "a read with no tree answers none, never a guess");
  const none = await answerOp("read", { module: "grading", repo: "acme/app", kind: "commit", ref: sha }, ctx());
  assert.equal(none.status, 404, "a commit GitHub has no answer for is a 404, never a guess");
  await assert.rejects(() => answerOp("read", { module: "grading", repo: "acme/app", kind: "commit", ref: sha }, withRest(c, async () => ({ status: 502, body: {}, headers: new Headers() }))), /502/, "an unreadable answer throws");
});

test("a job GitHub has no answer for is null, never an error", async () => {
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "job", id: 42 }, ctx());
  assert.equal(a.status, 200);
  assert.equal(a.json, null);
});

test("a job's record carries its run and the name and conclusion a suite's check is bound to", async () => {
  const c = ctx();
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "job", id: 42 }, withRest(c, async () => ok({ id: 42, run_id: 7, run_attempt: 1, name: "packages (1)", status: "completed", conclusion: "success" })));
  assert.deepEqual({ id: a.json.id, name: a.json.name, state: a.json.state, conclusion: a.json.conclusion, run_id: a.json.run_id },
    { id: 42, name: "packages (1)", state: "completed", conclusion: "success", run_id: 7 });
});

test("the PR query asks for each check's external_id and whether the check list is cut", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../service/src/ops.ts", import.meta.url), "utf8");
  const query = /const PR_QUERY = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
  // `app` is a field of CheckSuite, never of CheckRun: selecting it on the run itself is a schema error that fails the whole read.
  assert.match(query, /CheckRun \{ databaseId name status conclusion startedAt completedAt externalId checkSuite \{ app \{ slug \} \} \}/,
    "a suite check carries its external_id, the App that posted it, and the id and times the gate picks the newest run by");
  assert.match(query, /statusCheckRollup \{ contexts\(first: 100\) \{ pageInfo \{ hasNextPage \}/, "a truncated check list is refused, not read as complete");
  assert.match(query, /files\(first: 100\) \{ pageInfo \{ hasNextPage endCursor \} nodes \{ path changeType \} \}/, "the file list carries its page cursor and each file's change type");
  assert.match(query, /baseRef \{ target \{ oid /, "the PR's own base oid comes back, for a merged run whose pull_requests list GitHub dropped");
});

test("a PR read pages its file list past the first 100, and a page it can't read is no answer at all", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts` }));
  const answers = (body: unknown) => answerOp("read", { module: "grading", repo: "acme/app", kind: "pr", number: 7 },
    withRest(ctx(), async (_m, path, sent) => (path === "/graphql"
      ? ok((sent as any)?.variables?.after === "f1" ? body : { data: { repository: { pullRequest: { number: 7, headRefOid: sha, baseRefOid: sha, files: { pageInfo: { hasNextPage: true, endCursor: "f1" }, nodes: first } } } } })
      : ok({}))));
  const whole = await answers({ data: { repository: { pullRequest: { headRefOid: sha, baseRefOid: sha, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "deploy/Dockerfile" }] } } } } });
  const files = whole.json.repository.pullRequest.files;
  assert.deepEqual(files.pageInfo, { hasNextPage: false });
  assert.equal(files.nodes.length, 101, "every page is read");
  assert.equal(files.nodes.at(-1).path, "deploy/Dockerfile", "the image definition on the second page is in the list");
  // A second page GitHub refuses is no answer: a partial list would hide an image definition past the cut.
  const refuse = (page: unknown) => answerOp("read", { module: "grading", repo: "acme/app", kind: "pr", number: 7 },
    withRest(ctx(), async (_m, path, sent) => (path === "/graphql"
      ? (sent as any)?.variables?.after === "f1" ? page : ok({ data: { repository: { pullRequest: { number: 7, headRefOid: sha, baseRefOid: sha, files: { pageInfo: { hasNextPage: true, endCursor: "f1" }, nodes: first } } } } })
      : ok({}))));
  await assert.rejects(() => refuse({ status: 502, body: {}, headers: new Headers() }), /GitHub POST \/graphql: 502/);
  // A 200 whose body carries GraphQL errors and partial data is no answer either: the page it shows may be missing a file.
  await assert.rejects(() => refuse(ok({ data: { repository: { pullRequest: { files: { pageInfo: { hasNextPage: false }, nodes: [] } } } }, errors: [{ message: "timeout" }] })), /timeout/);
  // A page read at another head is no answer: the PR's metadata (and its checks) describe one head, the page another.
  await assert.rejects(() => refuse(ok({ data: { repository: { pullRequest: { headRefOid: "c".repeat(40), baseRefOid: sha, files: { pageInfo: { hasNextPage: false }, nodes: [] } } } } })), /moved while its files were read/);
});

test("a PR read keeps GitHub's explicit nulls, so grading can tell a PR that is gone from one it could not read", async () => {
  // A token that lost access, or a deleted repo, answers `repository: null`; a repository that has its other fields but no PR
  // answers `pullRequest: null` beside them. Both are answers about the PR, and the grading module's presence check needs them
  // to stop holding a close for a PR that cannot come back. Anything malformed, or a GraphQL error, is still no answer.
  const pr = (answer: unknown) => answerOp("read", { module: "grading", repo: "acme/app", kind: "pr", number: 7 },
    withRest(ctx(), async (_m, path) => (path === "/graphql" ? ok(answer) : ok({}))));
  const noRepo = await pr({ data: { repository: null } });
  assert.deepEqual(noRepo.json, { repository: null }, "a null repository is kept as the answer");
  const noPr = await pr({ data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: null } } });
  assert.equal(noPr.json.repository.pullRequest, null, "an explicit null PR is kept beside its siblings");
  await assert.rejects(() => pr({ data: { repository: { defaultBranchRef: { name: "main" } } } }), /no readable/, "an omitted PR field is no answer");
  await assert.rejects(() => pr({ data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository." }] }), /no readable/, "a GraphQL error is no answer");
  const gone = await pr({ data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest." }] });
  assert.equal(gone.json.repository.pullRequest, null, "GitHub's NOT_FOUND beside the null is its word that the PR is not there");
  await assert.rejects(() => pr({ data: { repository: { pullRequest: null } }, errors: [{ type: "FORBIDDEN", message: "denied" }] }), /no readable/, "any other error beside a null is no answer");
  // The issue read is unchanged: a null issue is still no answer.
  await assert.rejects(() => answerOp("read", { module: "grading", repo: "acme/app", kind: "issue", number: 7 },
    withRest(ctx(), async (_m, path) => (path === "/graphql" ? ok({ data: { repository: { issue: null } } }) : ok({})))), /no readable/);
});

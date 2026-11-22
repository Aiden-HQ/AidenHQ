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
  cacheDir: "/tmp", cache: async () => "/tmp", git: async () => "", fetchRemote: async () => ({ dir: "/tmp", ref: "", sha: "" }), initBare: async () => {}, ours: async () => false,
});
/** The context answering every REST call with `rest`. */
const withRest = (c: OpsContext, rest: OpsContext["access"]["rest"]): OpsContext => ({ ...c, access: { ...c.access, rest } as unknown as OpsContext["access"] });
const ok = (body: unknown) => ({ status: 200, body, headers: new Headers() });
const sha = "a".repeat(40);

test("a file at an exact commit is its text — a parsed JSON body goes back out as JSON, never [object Object]", async () => {
  const c = ctx();
  const parsed = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: sha }, withRest(c, async () => ok({ suites: [] })));
  assert.equal(parsed.text, "{\"suites\":[]}", "a parsed JSON file is serialized back, not stringified as an object");
  assert.doesNotMatch(parsed.text, /object Object/);
  const raw = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/workflows/ci.yml", ref: sha }, withRest(c, async () => ok("name: ci\njobs: {}\n")));
  assert.equal(raw.text, "name: ci\njobs: {}\n", "a non-JSON file (ci.yml is YAML) stays its own text");
  assert.equal((await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: sha }, c)).status, 404);
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
    ok({ total_count: 2, jobs: [{ name: "modules (3)", run_attempt: 2, status: "completed", conclusion: "success" }, { name: "post-checks", run_attempt: 2, status: "completed", conclusion: "success" }] }) :
    path.includes("/actions/workflows/") ? ok({ path: ".github/workflows/ci.yml", state: "active" }) :
    ok({ id: 900, run_attempt: 2, event: "pull_request", head_sha: "h", status: "completed", workflow_id: 9, pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }] });
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, rest));
  assert.deepEqual(a.json, { id: 900, run_attempt: 2, event: "pull_request", head_sha: "h", status: "completed", workflow_id: 9,
    workflow_path: ".github/workflows/ci.yml", workflow_state: "active", base_sha: "base",
    post_checks: [{ run_attempt: 2, state: "completed", conclusion: "success" }] }, "the run carries its post-checks instances, so a fact can require CI's own poster");
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

test("a commit read answers its parents in the API's order, first parent first; a 404 is no commit", async () => {
  const c = ctx();
  const parents = [{ sha: "b".repeat(40) }, { sha: "c".repeat(40) }];
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "commit", ref: sha }, withRest(c, async () => ok({ sha, parents })));
  assert.deepEqual(a.json, { sha, parents: ["b".repeat(40), "c".repeat(40)] }, "the merge commit's first parent is the base");
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
  assert.match(query, /CheckRun \{ name status conclusion externalId checkSuite \{ app \{ slug \} \} \}/,
    "a suite check carries its external_id and the App that posted it");
  assert.match(query, /statusCheckRollup \{ contexts\(first: 100\) \{ pageInfo \{ hasNextPage \}/, "a truncated check list is refused, not read as complete");
  assert.match(query, /files\(first: 100\) \{ pageInfo \{ hasNextPage \}/, "a truncated file list is refused too");
  assert.match(query, /baseRef \{ target \{ oid /, "the PR's own base oid comes back, for a merged run whose pull_requests list GitHub dropped");
});

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

test("a workflow run's identity is its workflow, event, head, attempt and its own base", async () => {
  const c = ctx();
  const rest = async (_m: string, path: string) => path.includes("/actions/workflows/") ?
    ok({ path: ".github/workflows/ci.yml", state: "active" }) :
    ok({ id: 900, run_attempt: 2, event: "pull_request", head_sha: "h", status: "completed", workflow_id: 9, pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }] });
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, rest));
  assert.deepEqual(a.json, { id: 900, run_attempt: 2, event: "pull_request", head_sha: "h", status: "completed", workflow_id: 9,
    workflow_path: ".github/workflows/ci.yml", workflow_state: "active", base_sha: "base" });
  assert.equal((await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 901 }, withRest(c, async () => ({ status: 404, body: {}, headers: new Headers() })))).json, null, "a run GitHub has no answer for is null");
  // Two PRs on one head, two bases: ambiguous, no base at all (never one of them picked).
  const two = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, async (_m, path) => path.includes("/actions/workflows/") ? ok({ path: ".github/workflows/ci.yml", state: "active" }) :
    ok({ id: 900, head_sha: "h", pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }, { head: { sha: "h" }, base: { sha: "x" } }] })));
  assert.equal(two.json.base_sha, null);
  // A run whose workflow can't be read names no workflow: no fact, never a guess.
  const unreadable = await answerOp("read", { module: "grading", repo: "acme/app", kind: "run", id: 900 }, withRest(c, async (_m, path) => path.includes("/actions/workflows/") ? { status: 500, body: {}, headers: new Headers() } : rest(_m, path)));
  assert.equal(unreadable.json.workflow_path, null);
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
  assert.match(query, /CheckRun \{ name status conclusion externalId detailsUrl app \{ slug \} checkSuite \{ workflowRun \{ databaseId \} \} \}/,
    "a suite check carries its external_id, the App and check suite GitHub made it in, and its own job link");
  assert.match(query, /statusCheckRollup \{ contexts\(first: 100\) \{ pageInfo \{ hasNextPage \}/, "a truncated check list is refused, not read as complete");
  assert.match(query, /files\(first: 100\) \{ pageInfo \{ hasNextPage \}/, "a truncated file list is refused too");
  assert.match(query, /baseRef \{ target \{ oid /, "the PR's own base oid comes back, for a merged run whose pull_requests list GitHub dropped");
});

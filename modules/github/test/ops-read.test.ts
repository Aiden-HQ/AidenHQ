import { test } from "node:test";
import assert from "node:assert/strict";
import { answerOp, type OpsContext } from "../service/src/ops.ts";

/** The ops' context with a fake GitHub: only what read(file) and read(job) reach. */
const ctx = (): OpsContext => ({
  access: {
    connected: () => true, token: async () => "tok", scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), lines: [], graphql: async () => ({}),
    identity: async () => ({ login: "o", name: "O", email: "o@example.com" }),
    rest: async () => ({ status: 404, body: {}, headers: new Headers() }),
  } as unknown as OpsContext["access"],
  cacheDir: "/tmp", cache: async () => "/tmp", git: async () => "", fetchRemote: async () => ({ dir: "/tmp", ref: "", sha: "" }), initBare: async () => {}, ours: async () => false,
});

const read = (c: OpsContext, body: Record<string, unknown>) => answerOp("read", { module: "grading", repo: "acme/app", ...body }, c);

test("a file at an exact commit is its text, or 404", async () => {
  const c = ctx();
  const present = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: "a".repeat(40) }, {
    ...c, access: { ...c.access, rest: async () => ({ status: 200, body: "{\"suites\":[]}", headers: new Headers() }) } as unknown as OpsContext["access"],
  });
  assert.equal(present.text, "{\"suites\":[]}");
  const absent = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: "a".repeat(40) }, c);
  assert.equal(absent.status, 404);
});

test("a job's record carries its steps, its run's base and the workflow that ran it", async () => {
  const c = ctx(), ok = (body: unknown) => ({ status: 200, body, headers: new Headers() });
  const rest = async (_m: string, path: string) => path.includes("/actions/runs/") ?
    ok({ head_sha: "h", event: "pull_request", workflow_id: 9, pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }] }) :
    path.includes("/actions/workflows/") ? ok({ path: ".github/workflows/ci.yml", state: "active" }) :
    ok({ id: 42, run_id: 7, name: "packages (1)", status: "completed", conclusion: "success", steps: [{ name: "Test", status: "completed", conclusion: "success" }] });
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "job", id: 42 }, { ...c, access: { ...c.access, rest } as unknown as OpsContext["access"] });
  assert.deepEqual(a.json.steps, [{ name: "Test", state: "completed", conclusion: "success" }]);
  assert.equal(a.json.run_id, 7, "the run names the job instance a suite's check's external_id carries");
  assert.equal(a.json.run_base, "base");
  assert.equal(a.json.workflow_path, ".github/workflows/ci.yml");
  assert.equal(a.json.workflow_state, "active");
  assert.equal(a.json.event, "pull_request");
  assert.equal(a.json.head_sha, "h");
  const unreadable = await answerOp("read", { module: "grading", repo: "acme/app", kind: "job", id: 42 }, { ...c, access: { ...c.access, rest: async (_m: string, path: string) => path.includes("/actions/workflows/") ? { status: 500, body: {}, headers: new Headers() } : rest(_m, path) } as unknown as OpsContext["access"] });
  assert.equal(unreadable.json.workflow_path, null);
  // Two PRs on one head, two bases: ambiguous, no fact.
  const again = await answerOp("read", { module: "grading", repo: "acme/app", kind: "job", id: 42 }, { ...c, access: { ...c.access, rest: async (_m: string, path: string) => path.includes("/actions/runs/") ? { status: 200, body: { head_sha: "h", pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }, { head: { sha: "h" }, base: { sha: "x" } }] }, headers: new Headers() } : rest(_m, path) } as unknown as OpsContext["access"] });
  assert.equal(again.json.run_base, null);
});

test("a directory probe answers whether the folder is there, never its contents", async () => {
  const c = ctx();
  const at = (status: number, body: unknown) => ({ ...c, access: { ...c.access, rest: async () => ({ status, body, headers: new Headers() }) } as unknown as OpsContext["access"] });
  // GitHub answers a directory with a JSON list; a file is an object, so a file path is not a directory.
  assert.deepEqual((await read(at(200, [{ name: "a" }]), { kind: "dir", path: "kernel", ref: "a".repeat(40) })).json, { path: "kernel", present: true });
  assert.deepEqual((await read(at(200, { name: "x", type: "file" }), { kind: "dir", path: "kernel", ref: "a".repeat(40) })).json, { path: "kernel", present: false });
  assert.deepEqual((await read(at(404, {}), { kind: "dir", path: "gone", ref: "a".repeat(40) })).json, { path: "gone", present: false });
});

test("a job GitHub has no answer for is null, never an error", async () => {
  const a = await read(ctx(), { kind: "job", id: 42 });
  assert.equal(a.status, 200);
  assert.equal(a.json, null);
});

test("the PR query asks for each check's job id and the base oid", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../service/src/ops.ts", import.meta.url), "utf8");
  const query = /const PR_QUERY = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
  assert.match(query, /CheckRun \{ databaseId name status conclusion externalId \}/, "each CheckRun's databaseId is the Actions job behind it");
  assert.match(query, /contexts\(first: 100\) \{ pageInfo \{ hasNextPage \}/, "a truncated check list is refused, not read as complete");
  assert.match(query, /baseRef \{ target \{ oid /, "the base oid is the CI map CI executes");
  assert.match(src, /steps: \(Array\.isArray\(j\.steps\)/, "a job's own steps come back, so the Test step can be required");
});


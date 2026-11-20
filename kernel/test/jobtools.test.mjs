// A job's next-turn requests: bound to the job its token names (live, on its own agent and task), never to the body; an engine
// request only for an engine and a model the job's agent may run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJobTools } from "../src/jobtools.ts";
import { mintToken } from "../src/gateway/token.ts";
import { createCodehost } from "../src/codehost.ts";
import { createBackplane } from "../src/backplane.ts";
import { readBody, serve } from "./helpers.mjs";
import { localSnapshot } from "../../modules/codehost-local/src/snapshot.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("jobtools: a job token reaches only its own live job", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, agent TEXT, task TEXT, state TEXT, authority TEXT)");
  const a = JSON.stringify({ engine: "codex", engines: ["codex"], models: ["~openai/gpt-sol-latest"] });
  db.prepare("INSERT INTO jobs VALUES ('j-a', 'ag1', 'task-a', 'running', ?), ('j-b', 'ag1', 'task-b', 'running', ?), ('j-old', 'ag1', 'task-a', 'done', ?)").run(a, a, a);
  const tools = createJobTools({ db, secret: () => "s", engines: () => ["codex", "other"] });
  const tokenA = mintToken("s", { kind: "job", job: "j-a", agentId: "ag1", issueId: "task-a" });
  tools.run(tokenA, "reset", { job: "j-b" });
  tools.run(tokenA, "engine", { engine: "codex", model: "~openai/gpt-sol-latest" });
  assert.throws(() => tools.run(tokenA, "engine", { engine: "codex", model: "acme/other" }), /isn't one this agent may use/);
  assert.throws(() => tools.run(tokenA, "engine", { engine: "other" }), /isn't one this agent may run/); // in the registry, not in its engines
  // A job's prechecks: three reviewer calls, then refused; never a next-turn request.
  // One whose reviewer call failed is refunded, once: it got no review.
  const refund = tools.review(tokenA);
  refund(); refund();
  for (let i = 0; i < 3; i++) tools.review(tokenA);
  assert.throws(() => tools.review(tokenA), /had its 3 prechecks/);
  // Read by the task's next turn once the job has ended; spent once that turn has started.
  assert.equal(tools.pending("task-a"), undefined);
  db.prepare("UPDATE jobs SET state = 'done' WHERE id IN ('j-a', 'j-b')").run();
  assert.equal(tools.pending("task-b"), undefined);
  assert.deepEqual(tools.pending("task-a"), { job: "j-a", fresh: true, engine: { kind: "codex", model: "~openai/gpt-sol-latest" }, cleanup: false });
  tools.taken("task-a");
  assert.equal(tools.pending("task-a"), undefined);
  // A token naming another task's job, an ended job, or another kind's token: refused.
  assert.throws(() => tools.run(mintToken("s", { kind: "job", job: "j-b", agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /ended/);
  assert.throws(() => tools.run(mintToken("s", { kind: "job", job: "j-old", agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /ended/);
  assert.throws(() => tools.run(mintToken("s", { kind: "grader", agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /kernel job's own token/);
});

// `repo-checkout`: a job box's request reaches the code host's snapshot op through the kernel's broker, only for a live job
// that holds the role, and only for an agents-org repo.
test("repo-checkout: a role holder's job gets the code host's snapshot; no role, other orgs and stale shas never reach it", async (t) => {
  const asked = [];
  const host = await serve((req, res) => {
    readBody(req).then((b) => {
      asked.push({ auth: req.headers.authorization, ...JSON.parse(b) });
      res.writeHead(200, { "content-type": "application/gzip", "x-aidenhq-commit": "a".repeat(40) }).end("TARBALL");
    });
  });
  t.after(() => host.s.close());
  // A bare repo of the org `local` on this host, with one commit.
  const root = mkdtempSync(join(tmpdir(), "codehost-"));
  const bare = join(root, "local", "app.git"), work = join(root, "work");
  mkdirSync(bare, { recursive: true }); mkdirSync(work);
  const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();
  git(bare, "init", "--quiet", "--bare", "-b", "main");
  git(work, "init", "--quiet", "-b", "main"); writeFileSync(join(work, "hello.txt"), "hi\n"); git(work, "add", "."); git(work, "commit", "--quiet", "-m", "one");
  git(work, "push", "--quiet", bare, "main");
  const head = git(work, "rev-parse", "HEAD");
  const codehost = createCodehost({
    grants: () => [{ module: "github", snapshot: { repos: ["*/*"] } }, { module: "codehost-local", snapshot: { repos: ["local/*"] } }], repos: () => ({ agentsOrgs: ["acme-agents", "local"] }),
    kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${host.url}/aidenhq/v1/executor`, auth_secret: "k" } }),
    local: () => ({ snapshot: localSnapshot({ bare: (r) => join(root, "local", `${r.split("/")[1]}.git`) }), clone: async () => { throw new Error("unused"); } }),
    secret: () => "ch-key", resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} }, workspace: async () => { throw new Error("unused"); },
  });
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, agent TEXT, task TEXT, state TEXT, authority TEXT)");
  db.prepare("INSERT INTO jobs VALUES ('j-a', 'ag1', 't', 'running', ?), ('j-b', 'ag2', 't', 'running', ?)").run(JSON.stringify({ roles: ["repo-checkout"] }), JSON.stringify({ roles: [] }));
  const jobTools = createJobTools({ db, secret: () => "s", engines: () => [], orgs: () => ["acme-agents", "local"] });
  const bp = await serve(createBackplane({ whoami: async () => { throw new Error("no"); }, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), jobTools, codehost: codehost.op }));
  t.after(() => bp.s.close());
  const post = (agent, job, b) => fetch(`${bp.url}/v1/checkout`, { method: "POST", headers: { authorization: `Bearer ${mintToken("s", { kind: "job", job, agentId: agent, issueId: "t" })}` }, body: JSON.stringify(b) });
  const sha = "a".repeat(40);
  const ok = await post("ag1", "j-a", { repo: "ACME-agents/app", sha });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-aidenhq-commit"), sha);
  assert.equal(await ok.text(), "TARBALL");
  assert.deepEqual(asked, [{ auth: "Bearer ch-key", module: "github", repo: "ACME-agents/app", ref: sha }]);
  assert.equal((await post("ag2", "j-b", { repo: "acme-agents/app", sha })).status, 403, "no role");
  assert.equal((await post("ag1", "j-a", { repo: "other-org/app", sha })).status, 403, "not the agents org");
  assert.equal((await post("ag1", "j-a", { repo: "acme-agents/app", sha: "main" })).status, 400, "a full sha only");
  assert.equal(asked.length, 1);
  // A local/ repo is served by codehost-local's snapshot op through the same route: its tarball, the commit in the header,
  // and never GitHub's service.
  const local = await post("ag1", "j-a", { repo: "local/app", sha: head });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get("x-aidenhq-commit"), head);
  const tar = join(root, "snap.tgz"); writeFileSync(tar, Buffer.from(await local.arrayBuffer()));
  assert.match(execFileSync("tar", ["-tzf", tar], { encoding: "utf8" }), /hello\.txt/);
  assert.equal((await post("ag1", "j-a", { repo: "local/app" })).headers.get("x-aidenhq-commit"), head, "no sha: the default branch");
  assert.equal((await post("ag1", "j-a", { repo: "local/app", sha: "b".repeat(40) })).status, 404, "a commit it doesn't have");
  assert.equal(asked.length, 1);
});

// `aidenhq clone`: an engineer job's own token, a repo on this server, and only one its dispatcher's clone grant covers.
test("aidenhq clone: only a local repo the job's dispatcher may clone", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, module TEXT, agent TEXT, task TEXT, state TEXT, authority TEXT)");
  db.prepare("INSERT INTO jobs VALUES ('j-a', 'dispatch', 'ag1', 't', 'running', ?)").run(JSON.stringify({ profile: "engineer", roles: [] }));
  const jobTools = createJobTools({ db, secret: () => "s", engines: () => [], mayClone: (module, repo) => module === "dispatch" && repo === "local/app" });
  const token = mintToken("s", { kind: "job", job: "j-a", agentId: "ag1", issueId: "t" });
  assert.deepEqual(jobTools.clone(token, { repo: "local/app" }), { repo: "local/app" });
  assert.throws(() => jobTools.clone(token, { repo: "local/other" }), (e) => e.status === 403, "outside the grant");
  assert.throws(() => jobTools.clone(token, { repo: "acme/app" }), (e) => e.status === 400, "not on this server");
});

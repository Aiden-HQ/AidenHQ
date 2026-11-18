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
  // Read by the task's next turn once the job has ended; spent once that turn has started.
  assert.equal(tools.pending("task-a"), undefined);
  db.prepare("UPDATE jobs SET state = 'done' WHERE id IN ('j-a', 'j-b')").run();
  assert.equal(tools.pending("task-b"), undefined);
  assert.deepEqual(tools.pending("task-a"), { job: "j-a", fresh: true, engine: { kind: "codex", model: "~openai/gpt-sol-latest" }, cleanup: false });
  tools.taken("task-a");
  assert.equal(tools.pending("task-a"), undefined);
  // A token naming another task's job, an ended job, or an agent token: refused.
  assert.throws(() => tools.run(mintToken("s", { kind: "job", job: "j-b", agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /ended/);
  assert.throws(() => tools.run(mintToken("s", { kind: "job", job: "j-old", agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /ended/);
  assert.throws(() => tools.run(mintToken("s", { agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /kernel job's own token/);
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
  const codehost = createCodehost({
    grants: () => [{ module: "codehost-github", snapshot: { repos: ["*/*"] } }], repos: () => ({ agentsOrg: "acme-agents" }),
    kind: () => ({ module: "codehost-github", floor: 0, tools: [], executor: { url: `${host.url}/aidenhq/v1/executor`, auth_secret: "k" } }),
    secret: () => "ch-key", resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} }, workspace: async () => { throw new Error("unused"); },
  });
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, agent TEXT, task TEXT, state TEXT, authority TEXT)");
  db.prepare("INSERT INTO jobs VALUES ('j-a', 'ag1', 't', 'running', ?), ('j-b', 'ag2', 't', 'running', ?)").run(JSON.stringify({ roles: ["repo-checkout"] }), JSON.stringify({ roles: [] }));
  const jobTools = createJobTools({ db, secret: () => "s", engines: () => [], agentsOrg: () => "acme-agents" });
  const bp = await serve(createBackplane({ whoami: async () => { throw new Error("no"); }, asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), jobTools, codehost: codehost.op }));
  t.after(() => bp.s.close());
  const post = (agent, job, b) => fetch(`${bp.url}/v1/checkout`, { method: "POST", headers: { authorization: `Bearer ${mintToken("s", { kind: "job", job, agentId: agent, issueId: "t" })}` }, body: JSON.stringify(b) });
  const sha = "a".repeat(40);
  const ok = await post("ag1", "j-a", { repo: "ACME-agents/app", sha });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-aidenhq-commit"), sha);
  assert.equal(await ok.text(), "TARBALL");
  assert.deepEqual(asked, [{ auth: "Bearer ch-key", module: "codehost-github", repo: "ACME-agents/app", ref: sha }]);
  assert.equal((await post("ag2", "j-b", { repo: "acme-agents/app", sha })).status, 403, "no role");
  assert.equal((await post("ag1", "j-a", { repo: "other-org/app", sha })).status, 403, "not the agents org");
  assert.equal((await post("ag1", "j-a", { repo: "acme-agents/app", sha: "main" })).status, 400, "a full sha only");
  assert.equal(asked.length, 1);
});

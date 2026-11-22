// A job's next-turn requests: bound to the job its token names (live, on its own agent and task), never to the body; an engine
// request only for an engine and a model the job's agent may run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJobTools } from "../src/jobtools.ts";
import { mintToken } from "../src/gateway/token.ts";

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
  // A review that timed out or failed after its reviewer took it is spent.
  tools.review(tokenA)({ status: 504, type: "timeout" });
  tools.review(tokenA)({ status: 502, type: "review_failed" });
  // One that never reached a reviewer is refunded, once each, and at most 3 times a job.
  for (let i = 0; i < 4; i++) { const refund = tools.review(tokenA); refund({ status: 503, type: "no_reviewer" }); refund({ status: 503, type: "no_reviewer" }); }
  // The fourth refund was refused: three prechecks are spent.
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

// `aidenhq clone`: an engineer job's own token names the repo and its dispatcher, whose clone grant the code host broker checks.

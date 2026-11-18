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
  const a = JSON.stringify({ models: ["~openai/gpt-sol-latest"] });
  db.prepare("INSERT INTO jobs VALUES ('j-a', 'ag1', 'task-a', 'running', ?), ('j-b', 'ag1', 'task-b', 'running', ?), ('j-old', 'ag1', 'task-a', 'done', ?)").run(a, a, a);
  const tools = createJobTools({ db, secret: () => "s", engines: () => ["codex"] });
  const tokenA = mintToken("s", { kind: "job", job: "j-a", agentId: "ag1", issueId: "task-a" });
  tools.run(tokenA, "reset", { job: "j-b" });
  tools.run(tokenA, "engine", { engine: "codex", model: "~openai/gpt-sol-latest" });
  assert.throws(() => tools.run(tokenA, "engine", { engine: "codex", model: "acme/other" }), /isn't one this agent may use/);
  assert.throws(() => tools.run(tokenA, "engine", { engine: "other" }), /no engine/);
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

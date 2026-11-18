// A job's next-turn requests: bound to the job its token names (live, on its own agent and task), never to the body, read once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJobTools } from "../src/jobtools.ts";
import { mintToken } from "../src/gateway/token.ts";

test("jobtools: a job token reaches only its own live job", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, agent TEXT, task TEXT, state TEXT)");
  db.prepare("INSERT INTO jobs VALUES ('j-a', 'ag1', 'task-a', 'running'), ('j-b', 'ag1', 'task-b', 'running'), ('j-old', 'ag1', 'task-a', 'done')").run();
  const tools = createJobTools({ db, secret: () => "s", engines: () => ["codex"] });
  const tokenA = mintToken("s", { kind: "job", job: "j-a", agentId: "ag1", issueId: "task-a" });
  tools.run(tokenA, "reset", { job: "j-b" });
  tools.run(tokenA, "engine", { engine: "codex", model: "~openai/gpt-sol-latest" });
  assert.deepEqual(tools.nextTurn("j-b"), { fresh: false, engine: null, cleanup: false });
  assert.deepEqual(tools.nextTurn("j-a"), { fresh: true, engine: { kind: "codex", model: "~openai/gpt-sol-latest" }, cleanup: false });
  assert.deepEqual(tools.nextTurn("j-a"), { fresh: false, engine: null, cleanup: false });
  // A token naming another task's job, an ended job, or an agent token: refused.
  assert.throws(() => tools.run(mintToken("s", { kind: "job", job: "j-b", agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /ended/);
  assert.throws(() => tools.run(mintToken("s", { kind: "job", job: "j-old", agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /ended/);
  assert.throws(() => tools.run(mintToken("s", { agentId: "ag1", issueId: "task-a" }), "cleanup", {}), /kernel job's own token/);
  assert.throws(() => tools.run(tokenA, "engine", { engine: "other" }), /no engine/);
});

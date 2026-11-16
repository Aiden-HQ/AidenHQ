// `aidenhq advise` end to end: the CLI → the run's helper → the gateway's /advisor route on the job's own model credential
// (kind agent: capped, billed to its Engineer and task), on the advisor model; placeholder briefs and a 6th call are refused
// without reaching the gateway. A runner that adopts the job after a restart uses the same credential and carries on the count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startRepoHelper } from "../src/repohelper.ts";
import { jobAdvise } from "../src/advise.ts";
import { jobToken } from "../src/engines.mjs";
import { verifyToken } from "../../../kernel/src/gateway/token.ts";
import { ADVISOR_MODEL } from "../../../modules/tasks/connections/tasks-mcp/src/models.mjs";

const CLI = join(import.meta.dirname, "..", "bin", "aidenhq");

test("aidenhq advise: the job's own credential on the advisor route, 5 a job across an adoption, placeholders refused", async (t) => {
  const calls = [];
  const gateway = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const b = JSON.parse(body);
    calls.push({ url: req.url, model: b.model, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "openai/gpt-sol", choices: [{ message: { content: "Take option B." } }] }));
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "advise-"));
  writeFileSync(join(dir, "gateway_job_secret"), "job-secret");
  const cfg = { secretsDir: dir, timeout_minutes: 60, gatewayUrl: `http://127.0.0.1:${gateway.address().port}` };
  let saved; // the runner's state: what saveTools keeps of the run
  const helper = startRepoHelper(async () => "", () => {}, {
    advise: (ctx, args) => jobAdvise(ctx, args.brief, { cfg, save: (c) => (saved = { ...c.run, advised: c.advised?.advisor ?? c.run.advised }) }),
  });
  await helper.listening;
  t.after(() => { helper.close(); gateway.close(); });
  const startedAt = Date.now();
  const advise = (env, ...args) => promisify(execFile)(process.execPath, [CLI, "advise", ...args], { env: { ...process.env, ...env } }).then((r) => ({ out: r.stdout }), (e) => ({ err: e.stderr }));
  const first = helper.register({ issue: { id: "iss1", identifier: "PEN-1" }, agentId: "eng1", run: { startedAt, agentId: "eng1" } });

  assert.match((await advise(first.env, "placeholder")).err, /empty or a placeholder/);
  assert.match((await advise(first.env, "why?")).err, /empty or a placeholder/);
  assert.equal(calls.length, 0);

  const brief = "The migration failed twice with a lock timeout on the users table; retry in batches, or take a maintenance window?";
  for (let i = 0; i < 3; i++) assert.match((await advise(first.env, brief)).out, /Take option B\.[\s\S]*openai\/gpt-sol; \d advisor calls left/);
  // The runner restarts and adopts the job: a new context from what it saved, the same helper token.
  first.done();
  const adopted = helper.register({ issue: { id: "iss1", identifier: "PEN-1" }, agentId: saved.agentId, run: saved }, first.token);
  assert.match((await advise(adopted.env, brief)).out, /1 advisor calls left/);
  assert.match((await advise(adopted.env, brief)).out, /0 advisor calls left/);
  assert.match((await advise(adopted.env, brief)).err, /advisor_limit/);
  assert.equal(calls.length, 5);
  // Every call is the job's own token, the one its engine was given: kind agent, its Engineer and task.
  const own = `Bearer ${jobToken(cfg, { agentId: "eng1", issueId: "iss1", at: startedAt })}`;
  for (const c of calls) {
    assert.deepEqual([c.url, c.model, c.auth], ["/advisor/api/v1/chat/completions", ADVISOR_MODEL, own]);
    const p = verifyToken("job-secret", c.auth.replace(/^Bearer /, ""));
    assert.deepEqual([p?.k, p?.a, p?.i], ["agent", "eng1", "iss1"]);
  }

  // A run with no Engineer on record (adopted from before this was saved) is refused, never sent unattributed.
  const orphan = helper.register({ issue: { id: "iss2", identifier: "PEN-2" }, agentId: null, run: { startedAt } });
  assert.match((await advise(orphan.env, brief)).err, /no Engineer on record/);
  assert.equal(calls.length, 5);
});

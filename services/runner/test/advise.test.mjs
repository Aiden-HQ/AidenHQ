// `aidenhq advise` end to end: the CLI → the run's helper → the gateway's /advisor route on the job's own model credential
// (kind agent: capped, billed to its Engineer and task), on the advisor model; placeholder briefs and a 6th call are refused
// without reaching the gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startRepoHelper } from "../src/repohelper.ts";
import { jobAdvisor } from "../src/advise.mjs";
import { jobToken } from "../src/engines.mjs";
import { verifyToken } from "../../gateway/token.ts";
import { ADVISOR_MODEL } from "../../paperclip-tasks-mcp/models.mjs";

const CLI = join(import.meta.dirname, "..", "bin", "aidenhq");

test("aidenhq advise: the job's credential on the advisor route, 5 a run, placeholders refused", async (t) => {
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
  writeFileSync(join(dir, "secret"), "job-secret");
  const cfg = { gatewayJobSecretFile: join(dir, "secret"), timeout_minutes: 60 };
  const helper = startRepoHelper(async () => "", () => {}, {
    // As main.mjs agentAdvise: one advisor per job, on the job's own credential.
    advise: (ctx, args) => (ctx.advisor ??= jobAdvisor({ gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, key: ctx.modelKey, agentId: ctx.agentId }))(args.brief),
  });
  await helper.listening;
  const job = helper.register({ issue: { id: "iss1", identifier: "PEN-1" }, agentId: "eng1", modelKey: jobToken(cfg, { agentId: "eng1", issueId: "iss1" }) });
  t.after(() => { helper.close(); gateway.close(); });
  const advise = (...args) => promisify(execFile)(process.execPath, [CLI, "advise", ...args], { env: { ...process.env, ...job.env } }).then((r) => ({ out: r.stdout }), (e) => ({ err: e.stderr }));

  assert.match((await advise("placeholder")).err, /empty or a placeholder/);
  assert.match((await advise("why?")).err, /empty or a placeholder/);
  assert.equal(calls.length, 0);

  const brief = "The migration failed twice with a lock timeout on the users table; retry in batches, or take a maintenance window?";
  for (let i = 0; i < 5; i++) assert.match((await advise(brief)).out, /Take option B\.[\s\S]*openai\/gpt-sol; \d advisor calls left/);
  assert.match((await advise(brief)).err, /advisor_limit/);
  assert.equal(calls.length, 5);
  for (const c of calls) {
    assert.equal(c.url, "/advisor/api/v1/chat/completions");
    assert.equal(c.model, ADVISOR_MODEL);
    const p = verifyToken("job-secret", c.auth.replace(/^Bearer /, ""));
    assert.deepEqual([p?.k, p?.a, p?.i], ["agent", "eng1", "iss1"]);
  }
});

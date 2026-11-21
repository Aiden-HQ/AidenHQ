// A case whose reviewer call stopped at the eval-day spend cap (OpenRouter 402 cap_reached, the reviewer's review_cap) was
// never judged: the eval reports it as capped, never as a false block or any other miss, and the run can never print or
// record PASS (CI's reviewer-eval job and the kernel's check job both read that). Run end to end against a local 402.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { CAP_CODE, judgeCase, tally } from "../scripts/reviewer-eval.ts";

const CASE = "clean-add-only-critical-paths-push.json";

it("a review_cap case is capped: never a pass, a false block or any scored miss", () => {
  const case_ = { file: CASE, expect: "approve" };
  const capped = judgeCase(case_, { decision: "escalate", code: CAP_CODE, reason: "the review reached a limit before the reviewer finished (OpenRouter 402: cap_reached)" });
  assert.deepEqual(capped.verdict, "capped");
  const t = tally([case_], [capped]);
  assert.deepEqual([t.passed, t.failed, t.capped, t.pass], [0, [], [CASE], false], "a cap is not a miss, and a run with one never passes");
  // The same case judged (an approvable case approved) passes; a genuine false block is still a miss.
  assert.equal(tally([case_], [judgeCase(case_, { decision: "approve", code: "in_scope", reason: "as asked" })]).pass, true);
  const block = tally([case_], [judgeCase(case_, { decision: "reject", code: "policy_other", reason: "no" })]);
  assert.deepEqual([block.failed.length, block.capped.length, block.pass], [1, 0, false]);
});

let server: http.Server, base = "", dir = "";
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "eval-cap-"));
  // Every call is the eval-day cap: the gateway's answer when the day's spend is used up.
  server = http.createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "cap_reached", message: "spend cap reached: eval-day" } }))); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

it("a capped eval run reports the case as CAPPED, writes no PASS and records no receipt", async () => {
  const result = join(dir, "result.json");
  const env = { ...process.env, OPENROUTER_API_KEY: "sk-test", OPENROUTER_BASE_URL: base, EVAL_RESULT: result, XDG_STATE_HOME: join(dir, "state") };
  const script = join(import.meta.dirname, "..", "scripts/reviewer-eval.ts");
  const run = await new Promise<{ status: number | null; stdout: string }>((done) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, CASE.replace(/\.json$/, "")], { env });
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", () => {});
    p.on("close", (status) => done({ status, stdout }));
  });
  assert.equal(run.status, 1, "a capped run is not a pass");
  assert.match(run.stdout, /CAPPED \(not judged: review_cap\)/);
  assert.doesNotMatch(run.stdout, /PASS\b/);
  const r = JSON.parse(readFileSync(result, "utf8"));
  assert.deepEqual([r.capped, r.failed, r.pass], [[CASE], [], false]);
});

// A case whose reviewer call stopped at the eval-day spend cap (the gateway's 402 cap_reached, which review.ts reports as
// reviewer_failed) was never judged: the eval reports it as capped, never as a pass, a false block or any other miss, and a run
// with one can never print or record PASS (CI's reviewer-eval job and the kernel's check job both read that). Run end to end
// against a local 402.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { capReached, capScope } from "../scripts/reviewer-eval.ts";

const CASE = "clean-add-only-critical-paths-push.json";
const CAPPED = 'the reviewer failed (OpenRouter 402: {"type":"cap_reached","scope":"eval-day"})';

it("a cap is recognised from the gateway's own message, and the budget it names", () => {
  assert.equal(capReached(CAPPED), true, "the gateway's 402 cap_reached, as review.ts reports it");
  assert.equal(capReached("the reviewer failed (OpenRouter 402: spend cap reached: eval-day $0.30 of $0.20)"), true);
  assert.equal(capReached("the reviewer failed (OpenRouter 500: upstream)"), false, "another failure is not a cap");
  assert.equal(capReached("clean: the change is the one asked for"), false);
  assert.equal(capScope("the reviewer failed (spend cap reached: eval-day $0.30 of $0.20)"), "eval-day");
  assert.equal(capScope("the reviewer failed (spend cap reached: the install's daily $1.00 of $0.50)"), "install");
  assert.equal(capScope("the reviewer failed (OpenRouter 402: cap_reached)"), "unknown", "a budget it can't name is never guessed");
});

let server: http.Server, base = "", dir = "";
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "eval-cap-"));
  // Every call is the eval-day cap: the gateway's answer when the day's spend is used up.
  server = http.createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "cap_reached", message: "spend cap reached: eval-day $0.30 of $0.20" } }))); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

it("a capped eval run reports the case as CAPPED, writes no PASS and records no receipt", async () => {
  const result = join(dir, "result.json");
  const env = { ...process.env, OPENROUTER_API_KEY: "sk-test", OPENROUTER_BASE_URL: base, EVAL_RESULT: result, XDG_STATE_HOME: join(dir, "state") };
  const script = join(import.meta.dirname, "..", "scripts", "reviewer-eval.ts");
  const run = await new Promise<{ status: number | null; stdout: string }>((done) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, CASE.replace(/\.json$/, "")], { env });
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", () => {});
    p.on("close", (status) => done({ status, stdout }));
  });
  assert.equal(run.status, 1, "a capped run is not a pass");
  assert.match(run.stdout, /CAPPED \(not judged: review_cap\)/);
  assert.doesNotMatch(run.stdout, /PASS\b/, "never a PASS line, whatever the case expected");
  assert.doesNotMatch(run.stdout, /FAIL \(/, "a cap is not a scored miss either");
  const r = JSON.parse(readFileSync(result, "utf8"));
  assert.deepEqual([r.capped, r.failed, r.pass, r.capScope], [[CASE], [], false, "eval-day"]);
  assert.equal(existsSync(join(dir, "state")), false, "no passing receipt is recorded");
});

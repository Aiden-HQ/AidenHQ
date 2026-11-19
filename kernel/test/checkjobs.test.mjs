// Check jobs end to end with a fake box and a fake snapshot: receipts bind the head (and the eval's judge and policy), the
// box gets no credential, the eval runs by the judging rules, and the eval's model calls stop at the eval day cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createChecks } from "../src/checkjobs.ts";
import { createGateway } from "../src/gateway/lib.ts";
import { mintToken, verifyToken } from "../src/gateway/token.ts";
import { createIdentity } from "../src/identity.ts";
import { recipes } from "./helpers.mjs";

const A = "a".repeat(40), B = "b".repeat(40), J = "1".repeat(40), S = "2".repeat(40);
const CASES = "modules/ai-reviewer/test/reviewer-cases";

function setup(trees, judge = () => ({ failed: [] })) {
  const dir = mkdtempSync(join(tmpdir(), "checks-"));
  const runs = [];
  const box = {
    async run(o) {
      runs.push(o);
      if (o.argv.includes("scripts/reviewer-eval.mjs")) {
        const cases = readdirSync(join(o.workspace, CASES)).sort();
        const script = readFileSync(join(o.workspace, "modules/ai-reviewer/scripts/reviewer-eval.mjs"), "utf8");
        const failed = judge(cases, runs.filter((r) => r.argv.includes("scripts/reviewer-eval.mjs")).length).failed;
        o.seen = { total: cases.length, script, cases: Object.fromEntries(cases.map((c) => [c, readFileSync(join(o.workspace, CASES, c), "utf8")])) };
        writeFileSync(join(o.out, "result.json"), JSON.stringify({ total: cases.length, passed: cases.length - failed.length, failed }));
        return { exit: 0, out: "", timedOut: false };
      }
      return { exit: trees.exit ?? 0, out: "lint: 1 error", timedOut: false };
    },
  };
  const snapshot = async (repo, ref, into) => {
    for (const [f, text] of Object.entries(trees[ref] ?? {})) (mkdirSync(dirname(join(into, f)), { recursive: true }), writeFileSync(join(into, f), text));
  };
  const db = new DatabaseSync(":memory:");
  const checks = createChecks({ db, secret: () => "receipt-secret", recipes, box, snapshot: () => snapshot, modelToken: (head) => mintToken("job-secret", { kind: "check", component: `eval:${head}` }), gatewayUrl: "http://gw", workDir: dir, log: () => {} });
  const done = async (v) => { while (v.state === "running") v = await checks.get("codehost-github", v.id, { after: v.version, waitMs: 1000 }); return v; };
  return { checks, runs, done, db };
}

test("checks: a receipt binds its head, run, judge and policy; the box gets no credential", async () => {
  const pkg = JSON.stringify({ scripts: { "aidenhq:fast-check": "eslint ." } });
  const { checks, runs, done } = setup({ [A]: { "package.json": pkg }, [B]: { "package.json": pkg } });
  const v = await done(checks.start("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: { base: B } }));
  assert.equal(v.state, "done");
  assert.deepEqual([v.receipt.verdict, v.receipt.ran], ["pass", true]);
  assert.deepEqual(checks.verify(v.receipt, { repo: "acme/app", head: A, run: "fast" }), { ok: true });
  assert.equal(checks.verify(v.receipt, { repo: "acme/app", head: B, run: "fast" }).ok, false);
  assert.equal(checks.verify(v.receipt, { repo: "acme/app", head: A, run: "eval" }).ok, false);
  assert.equal(checks.verify({ ...v.receipt, head: B }, { repo: "acme/app", head: B, run: "fast" }).ok, false);
  // Once per head and spec: asking again is the same check.
  assert.equal(checks.start("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: { base: B } }).id, v.id);
  // Exactly the allowlisted env: no GitHub, run or tool token, nothing of the kernel's own.
  assert.deepEqual(Object.keys(runs[0].env).sort(), ["CI", "HOME", "npm_config_audit", "npm_config_fund", "npm_config_update_notifier"]);
  assert.equal(runs[0].image, "engineer");
  // The box's folders are its attempt's, in the shape the launcher's /check takes: checks/c-<16 hex>/{ws,out}.
  assert.match(runs[0].check, /^c-[0-9a-f]{16}$/);
  assert.equal(basename(dirname(runs[0].workspace)), runs[0].check);
  assert.equal(basename(dirname(dirname(runs[0].workspace))), "checks");
});

test("checks: whether a fast check is due is the base's to say, and a check that didn't run is no evidence", async () => {
  const pkg = JSON.stringify({ scripts: { "aidenhq:fast-check": "eslint ." } });
  const C = "c".repeat(40), D = "d".repeat(40), E = "e".repeat(40);
  const { checks, runs, done } = setup({ [B]: { "package.json": pkg }, [A]: { "package.json": JSON.stringify({ scripts: {} }) }, [C]: { "package.json": "{ not json" }, [D]: {}, [E]: {} });
  const fast = async (head, base) => (await done(checks.start("codehost-github", { repo: "acme/app", head, run: "fast", spec: { base } }))).receipt;
  // The base declares it; the head deletes it: fail, nothing run.
  const dropped = await fast(A, B);
  assert.deepEqual([dropped.verdict, dropped.ran], ["fail", false]);
  assert.match(dropped.summary, /removes the fast check/);
  // The head's package.json can't be read: fail.
  assert.deepEqual([(await fast(C, B)).verdict, (await fast(C, D)).verdict], ["fail", "fail"]);
  assert.equal(runs.length, 0);
  // Neither declares one: nothing to run, and that receipt is refused unless the caller's policy accepts "none".
  const none = await fast(E, D);
  assert.deepEqual([none.verdict, none.ran], ["pass", false]);
  assert.deepEqual(checks.verify(none, { repo: "acme/app", head: E, run: "fast" }), { ok: false, why: "no check ran" });
  assert.deepEqual(checks.verify(none, { repo: "acme/app", head: E, run: "fast", none: true }), { ok: true });
  // A fast check names its base.
  assert.throws(() => checks.start("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: {} }), /names base/);
});

test("checks: find reads the check already asked for and never starts one, and a spec that doesn't fit is no check", async () => {
  const pkg = JSON.stringify({ scripts: { "aidenhq:fast-check": "eslint ." } });
  const { checks, runs, done } = setup({ [A]: { "package.json": pkg } });
  // Nothing asked yet: "none", and no run was started by looking.
  assert.equal(checks.find("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: { base: B } }), undefined);
  assert.equal(runs.length, 0);
  // Asked for: the same check, in its state, and still no second run.
  const v = await done(checks.start("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: { base: B } }));
  assert.equal(checks.find("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: { base: B } })?.id, v.id);
  assert.equal(runs.length, 1);
  // A spec the recipe can't take (a change with no base) is no check at all, never a throw at a reader.
  assert.equal(checks.find("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: { base: "" } }), undefined);
  assert.equal(checks.find("codehost-github", { repo: "acme/app", head: A, run: "deploy", spec: {} }), undefined);
});

test("checks: a recipe is the installed module's: unknown runs and bad specs are refused, the module's contract kit runs in its own folder", async () => {
  const { checks, runs, done } = setup({ [A]: { "mod/module.yaml": "name: mod" } });
  assert.throws(() => checks.start("codehost-github", { repo: "acme/mod", head: A, run: "deploy", spec: {} }), /run: .*contract/);
  for (const path of ["../x", "a/../b", "/abs", ""]) assert.throws(() => checks.start("codehost-github", { repo: "acme/mod", head: A, run: "contract", spec: { path } }), /spec\.path/);
  const v = await done(checks.start("codehost-github", { repo: "acme/mod", head: A, run: "contract", spec: { path: "mod" } }));
  assert.deepEqual([v.receipt.verdict, v.receipt.ran, runs[0].cwd], ["pass", true, "mod"]);
  assert.match(runs[0].argv.join(" "), /contract\.sh/);
  assert.ok(Object.keys(recipes().contract.files).includes("contract.sh"));
});

test("checks: the eval runs by the judging rules and its receipt binds judge and policy", async () => {
  const ok = (expect) => JSON.stringify({ expect });
  const base = { "modules/ai-reviewer/scripts/reviewer-eval.mjs": "JUDGE", "modules/ai-reviewer/test/case-pad.mjs": "pad", "modules/ai-reviewer/service/src/aidenhq-sdk/pass-rule.ts": "rule" };
  for (let i = 0; i < 20; i++) base[`${CASES}/c${i}.json`] = ok(i ? "approve" : "reject");
  const subject = { ...base, "modules/ai-reviewer/scripts/reviewer-eval.mjs": "FORGED", [`${CASES}/c0.json`]: ok("approve"), [`${CASES}/new.json`]: ok("reject") };
  delete subject[`${CASES}/c1.json`];
  // First run: an added case fails; the one re-run passes it.
  const { checks, runs, done } = setup({ [J]: base, [S]: subject }, (cases, n) => ({ failed: n === 1 ? [{ file: "new.json", got: "approve" }] : [] }));
  const spec = { repo: "acme/aidenhq", judge_commit: J, subject_commit: S, cases_from: S, policy_hash: "abc1234" };
  const v = await done(checks.start("codehost-github", { repo: "acme/product", head: A, run: "eval", spec }));
  assert.equal(v.receipt.verdict, "pass", v.receipt.summary);
  const evals = runs.filter((r) => r.argv.includes("scripts/reviewer-eval.mjs"));
  assert.equal(evals.length, 2);
  // The judge's script; the deleted case at its base version; the changed one twice, held to the base's expectation.
  assert.equal(evals[0].seen.script, "JUDGE");
  assert.equal(evals[0].seen.total, 22);
  assert.equal(evals[0].seen.cases["c1.json"], base[`${CASES}/c1.json`]);
  assert.deepEqual(JSON.parse(evals[0].seen.cases["c0.head.json"]), { expect: "reject" });
  assert.deepEqual(Object.keys(evals[1].seen.cases), ["new.json"]);
  const want = { repo: "acme/product", head: A, run: "eval", judge: J, policy: "abc1234" };
  assert.deepEqual(checks.verify(v.receipt, want), { ok: true });
  assert.equal(checks.verify(v.receipt, { ...want, judge: S }).ok, false);
  assert.equal(checks.verify(v.receipt, { ...want, policy: "fff0000" }).ok, false);
  assert.equal(checks.verify(v.receipt, { ...want, head: B }).ok, false);
  // The eval's only credential is a check token: no tools, no writes.
  const token = evals[0].env.OPENROUTER_API_KEY;
  assert.equal(verifyToken("job-secret", token).k, "check");
  assert.equal(evals[0].env.GH_TOKEN, undefined);
  const whoami = createIdentity({ grants: () => ({}), jobcaps: () => ({}), connections: () => ({}), modules: () => ({}), secret: (n) => (n === "gateway_job_secret" ? "job-secret" : "") });
  await assert.rejects(whoami(token), /invalid or expired/);
});

test("checks: the eval's model calls stop at the eval day cap", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-check-"));
  const price = { in: 1, cached_in: 0.1, out: 1, peak: 1, max_output: 4096 };
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: {} }));
  writeFileSync(join(dir, "gateway.json"), JSON.stringify({ models: { m: price }, eval_day_usd: 0.05 }));
  const upstream = await new Promise((r) => { const s = http.createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `g${Math.random()}`, model: "m", usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.03 } }))); }).listen(0, "127.0.0.1", () => r(s)); });
  const gw = createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: (n) => ({ openrouter_key: "sk", gateway_job_secret: "job-secret" })[n] ?? "", upstream: `http://127.0.0.1:${upstream.address().port}` });
  const front = await new Promise((r) => { const s = http.createServer((q, s2) => gw.handle(q, s2)).listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => { upstream.close(); front.close(); gw.close(); });
  const token = mintToken("job-secret", { kind: "check", component: `eval:${A}` });
  const call = () => fetch(`http://127.0.0.1:${front.address().port}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] }) });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  const r = await call();
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error.type, "cap_reached");
});

test("checks: each end of a check is a check.ended fact, a re-run's too", async () => {
  const pkg = JSON.stringify({ scripts: { "aidenhq:fast-check": "eslint ." } });
  const { checks, done, db } = setup({ [A]: { "package.json": pkg }, [B]: { "package.json": pkg } });
  const v = await done(checks.start("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: { base: B } }));
  const facts = () => db.prepare("SELECT subject, actor, data FROM facts WHERE type = 'check.ended'").all().map((f) => ({ ...f, data: JSON.parse(f.data) }));
  assert.deepEqual(facts(), [{ subject: `check:${v.id}`, actor: "module:codehost-github", data: { kind: "fast", repo: "acme/app", head: A, verdict: "pass" } }]);
  db.prepare("UPDATE checks SET state = 'error', at = at - 1 WHERE id = ?").run(v.id);
  await done(checks.start("codehost-github", { repo: "acme/app", head: A, run: "fast", spec: { base: B } }));
  assert.equal(facts().length, 2);
});

const evalSpec = { repo: "acme/aidenhq", judge_commit: J, subject_commit: J, cases_from: J, policy_hash: "abc1234" };
const evalTree = () => {
  const t = { "modules/ai-reviewer/scripts/reviewer-eval.mjs": "JUDGE", "modules/ai-reviewer/test/case-pad.mjs": "pad", "modules/ai-reviewer/service/src/aidenhq-sdk/pass-rule.ts": "rule" };
  for (let i = 0; i < 3; i++) t[`${CASES}/c${i}.json`] = JSON.stringify({ expect: "approve" });
  return { [J]: t };
};

test("checks: an eval that writes no result is an error with the box's output, never a fail receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "checks-"));
  const logs = [];
  let runs = 0;
  const box = { async run() { runs++; return { exit: 1, out: "Error: Cannot find module 'yaml'", timedOut: false }; } };
  const snapshot = async (repo, ref, into) => { for (const [f, text] of Object.entries(evalTree()[ref] ?? {})) (mkdirSync(dirname(join(into, f)), { recursive: true }), writeFileSync(join(into, f), text)); };
  const checks = createChecks({ db: new DatabaseSync(":memory:"), secret: () => "s", recipes, box, snapshot: () => snapshot, modelToken: () => "t", gatewayUrl: "http://gw", workDir: dir, log: (m, f) => logs.push({ m, ...f }) });
  let v = checks.start("codehost-github", { repo: "acme/product", head: A, run: "eval", spec: evalSpec });
  while (v.state === "running") v = await checks.get("codehost-github", v.id, { after: v.version, waitMs: 1000 });
  assert.deepEqual([v.state, v.receipt], ["error", null]);
  assert.match(v.error, /wrote no usable result/);
  assert.match(logs.find((l) => l.m.startsWith("WARNING")).err, /Cannot find module 'yaml'/);
  // No receipt: asking again runs it again.
  checks.start("codehost-github", { repo: "acme/product", head: A, run: "eval", spec: evalSpec });
  assert.equal(runs, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, 2);
});

test("checks: a restart's re-run never shares the draining kernel's folder, and the old run's late end doesn't overwrite it", async () => {
  // Two kernels on one db and work dir, as during a drained restart: the old one's box is still running when the new one starts.
  const dir = mkdtempSync(join(tmpdir(), "checks-"));
  const db = new DatabaseSync(join(dir, "kernel.db"));
  const pkg = JSON.stringify({ scripts: { "aidenhq:fast-check": "eslint ." } });
  const snapshot = async (repo, ref, into) => writeFileSync(join(into, "package.json"), pkg);
  let t = 1000;
  const now = () => t++;
  let release;
  const held = new Promise((r) => (release = r));
  const seen = [];
  const kernel = (run) => createChecks({ db, secret: () => "s", recipes, box: { run }, snapshot: () => snapshot, modelToken: () => "t", gatewayUrl: "http://gw", workDir: dir, log: () => {}, now });
  const oldK = kernel(async (o) => { seen.push(o.workspace); await held; return { exit: 1, out: "old", timedOut: false }; });
  const ask = { repo: "acme/app", head: A, run: "fast", spec: { base: B } };
  const first = oldK.start("codehost-github", ask);
  while (seen.length === 0) await new Promise((r) => setTimeout(r, 5));
  const newK = kernel(async (o) => { seen.push(o.workspace); assert.ok(existsSync(seen[0]), "the old run's folder is untouched"); return { exit: 0, out: "", timedOut: false }; });
  assert.equal(newK.find("codehost-github", ask).state, "lost");
  let v = newK.start("codehost-github", ask);
  assert.equal(v.id, first.id);
  while (v.state === "running") v = await newK.get("codehost-github", v.id, { after: v.version, waitMs: 1000 });
  assert.equal(v.receipt.verdict, "pass");
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.notEqual(seen[0], seen[1]);
  const after = await newK.get("codehost-github", v.id);
  assert.deepEqual([after.state, after.receipt.verdict, after.receipt.at], ["done", "pass", v.receipt.at]);
});

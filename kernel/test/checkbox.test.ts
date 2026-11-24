// Check jobs as main.ts wires them (checkbox.ts), through the backplane's routes: a fixture repo served by a stand-in code host
// (`git archive`, as codehost-github's /ops/snapshot), a stand-in launcher, and the box's command run on the host with its
// folders mapped. A fast check sees exactly the change (the box's own history); its receipt verifies for its head only; a
// snapshot of another commit than the one asked for gives no receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkBoxes, checkJobsFrom } from "../src/checkbox.ts";
import { createChecks, resultHash } from "../src/checkjobs.ts";
import { spawnDetached } from "../src/jobs.ts";
import { createCodehost } from "../src/codehost.ts";
import { kernel, readBody, recipes, serve } from "./helpers.ts";

/** The box's `docker exec`, run detached on the host as the kernel runs it: its env file is its whole env, its folders the
 * check's own (the last box the launcher stand-in made). */
const hostRun = (boxes) => (argv, log) => {
  const box = boxes.at(-1);
  const [, , , envFile, , cwd, , ...cmd] = argv;
  const map = (a) => a.replaceAll("/aidenhq-out", box.out);
  const env = readFileSync(envFile, "utf8").trim().split("\n").map(map);
  return spawnDetached(["env", "-i", `PATH=${process.env.PATH}`, ...env, "sh", "-c", 'cd "$0" && exec "$@"', cwd.replace("/workspace", box.workspace), ...cmd.map(map)], log);
};

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "fixture-"));
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  // The fast check: fails on any changed file that holds a type error; it needs the box's history to see the change at all.
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fx", scripts: { "aidenhq:fast-check": "node check.ts" } }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "fx", lockfileVersion: 3, requires: true, packages: { "": { name: "fx" } } }));
  writeFileSync(join(repo, "check.ts"), `import { execFileSync } from "node:child_process"; import { readFileSync } from "node:fs";
const changed = execFileSync("git", ["diff", "--name-only", process.env.AIDENHQ_BASE, "HEAD"], { encoding: "utf8" }).split("\\n").filter(Boolean);
if (!changed.length) { console.log("no change seen"); process.exit(1); }
for (const f of changed) if (readFileSync(f, "utf8").includes("TYPE ERROR")) { console.log(f + ": type error"); process.exit(1); }
console.log("checked " + changed.join(", "));`);
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "good.ts"), "export const x: number = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "good");
  const good = git("rev-parse", "HEAD");
  git("checkout", "-q", base);
  writeFileSync(join(repo, "bad.ts"), "TYPE ERROR\n");
  git("add", "-A");
  git("commit", "-qm", "bad");
  return { repo, base, good, bad: git("rev-parse", "HEAD") };
}

test("check jobs: a fixture's fast check runs in a credential-free box; its receipt verifies for its own head only", async (t) => {
  const fx = fixture();
  const asked = [];
  let lie;
  // codehost-github's snapshot op: git archive of the commit, asked by the kernel's broker with the code host's own key.
  const codehost = await serve(async (req, res) => {
    const b = JSON.parse(await readBody(req));
    asked.push({ auth: req.headers.authorization, ...b });
    if (req.headers.authorization !== "Bearer codehost-token") return res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/gzip", "x-aidenhq-commit": lie ?? b.ref });
    spawn("git", ["-C", fx.repo, "archive", "--format=tar.gz", b.ref], { stdio: ["ignore", "pipe", "ignore"] }).stdout.pipe(res);
  });
  const boxes = [];
  const launcher = await serve(async (req, res) => {
    const b = JSON.parse(await readBody(req));
    if (req.headers.authorization !== "Bearer kernel-key") return res.writeHead(401).end();
    if (req.url === "/check") boxes.push(b);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.url === "/check" ? { container: `box-${boxes.length}` } : { state: "missing" }));
  });
  t.after(() => { codehost.s.close(); launcher.s.close(); });
  const secrets = { codehost_github_token: "codehost-token", receipt_secret: "receipt-secret", launcher_kernel_key: "kernel-key", gateway_job_secret: "job-secret" };
  const modules = { modules: { "github": { roles: ["kernel.checks"], token: "codehost_github_token", codehost: { snapshot: { repos: ["acme/*"] } } } } };
  const broker = createCodehost({
    grants: () => Object.entries(modules.modules).map(([module, d]) => ({ ...d.codehost, module })), repos: () => ({}),
    kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${codehost.url}/aidenhq/v1/executor`, auth_secret: "codehost_github_token" } }),
    secret: (n) => secrets[n] ?? "", resolver: { resolve: async (u) => { const x = new URL(u); return { host: x.hostname, port: Number(x.port), path: x.pathname }; }, forget: () => {} },
  });
  const call = async (route, body) => (await fetch(`${launcher.url}${route}`, { method: "POST", headers: { authorization: `Bearer ${secrets.launcher_kernel_key}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const checkJobs = checkJobsFrom({
    db: new DatabaseSync(":memory:"), secret: (n) => secrets[n] ?? "", recipes, ask: broker.ask, call, spawnRun: hostRun(boxes), pollMs: 20, log: () => {},
    workDir: mkdtempSync(join(tmpdir(), "work-")), gatewayUrl: "http://gw/api/v1",
  });
  const k = await kernel(t, { modules, secrets, checkJobs });
  const run = async (head) => {
    let v = (await k.v1("POST", "/v1/checks", { repo: "acme/app", head, run: "fast", spec: { base: fx.base } }, "codehost-token")).json;
    while (v.state === "running") v = (await k.v1("GET", `/v1/checks/${v.id}?after=${v.version}&wait=5000`, undefined, "codehost-token")).json;
    return v;
  };
  const verify = async (receipt, head) => (await k.v1("POST", "/v1/receipts/verify", { receipt, for: { repo: "acme/app", head, run: "fast" } }, "codehost-token")).json;

  const good = await run(fx.good);
  assert.deepEqual([good.receipt.verdict, good.receipt.ran], ["pass", true], good.receipt.summary);
  assert.deepEqual(await verify(good.receipt, fx.good), { ok: true });
  // The same receipt for another head (a tampered one): refused.
  assert.equal((await verify(good.receipt, fx.bad)).ok, false);
  assert.equal((await verify({ ...good.receipt, head: fx.bad }, fx.bad)).ok, false);
  // The box: no credential at all for a fast check, its own folders, writable.
  assert.equal(boxes[0].token, undefined);
  assert.equal(boxes[0].readOnly, false);
  assert.deepEqual(asked.map((a) => a.ref).sort(), [fx.base, fx.good].sort());

  const bad = await run(fx.bad);
  assert.deepEqual([bad.receipt.verdict, bad.receipt.ran], ["fail", true]);
  assert.match(bad.receipt.summary, /bad\.ts: type error/);

  // A code host that answers with another commit than the one asked for: no receipt.
  lie = fx.good;
  let v = (await k.v1("POST", "/v1/checks", { repo: "acme/app", head: fx.bad, run: "fast", spec: { base: fx.good } }, "codehost-token")).json;
  while (v.state === "running") v = (await k.v1("GET", `/v1/checks/${v.id}?after=${v.version}&wait=5000`, undefined, "codehost-token")).json;
  assert.deepEqual([v.state, v.receipt], ["error", null]);
  assert.equal(v.error, `the snapshot of acme/app is of ${fx.good.slice(0, 12)}, not ${fx.bad.slice(0, 12)}`);
});

test("check box: every computer busy is a wait for a free one, not a check that can't run; another refusal is", async () => {
  let asks = 0, slept = 0;
  const busy = () => Object.assign(new Error("the computer launcher answered 503 on /check: all 12 computers are busy"), { status: 503 });
  const call = async (route) => {
    if (route !== "/check") return {};
    if (++asks < 3) throw busy();
    return { container: "box-1" };
  };
  const box = checkBoxes({ call, spawnRun: () => 4242, sleep: async () => void slept++ });
  const out = join(mkdtempSync(join(tmpdir(), "attempt-")), "out");
  const run = { check: "c-0000000000000000", image: "engineer", workspace: "/w", out, cwd: ".", argv: ["true"], env: {}, timeoutMs: 1000 };
  const waits = [];
  const h = await box.launch({ ...run, waiting: (w) => waits.push(w) });
  assert.deepEqual([h.container, h.pid, h.log], ["box-1", 4242, `${out}.log`]);
  assert.deepEqual([...new Set(waits)], [true, false], "waiting while it has no computer, not once it has one");
  assert.equal(asks, 3);
  assert.equal(slept, 2);
  const refused = checkBoxes({ call: async () => { throw Object.assign(new Error("no image"), { status: 400 }); }, sleep: async () => assert.fail("a 400 isn't waited on") });
  await assert.rejects(refused.launch(run), /no image/);
});

test("check box: a restart adopts a running check, which ends with its result, receipt and cost, and its box ends once", async () => {
  // Two kernels on one db and work dir, as across a restart: the old one launches the box run and stops following it as it
  // drains; the box runs on, and the next kernel follows it to its end, though the deploy that restarted it changed the recipe
  // (the box already holds the files it launched with): never a second run.
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  const db = new DatabaseSync(join(dir, "kernel.db"));
  const A = "a".repeat(40), B = "b".repeat(40);
  const review = { module: "code-review", argv: ["sh", "-c", `sleep 1; echo '{"findings":[]}' > /aidenhq-out/result.json; echo reviewed`], timeout_min: 5, title: "the review", spec: { base: "sha" }, files: {}, model: true, result: true };
  const boxes = [], calls = [];
  const call = async (route, body) => {
    calls.push(route);
    if (route === "/check") return (boxes.push(body), { container: `box-${boxes.length}` });
    return { state: "missing" };
  };
  const kernel = (recipe = review) => createChecks({ db, secret: () => "receipt-secret", recipes: () => ({ "code-review": recipe }), box: checkBoxes({ call, spawnRun: hostRun(boxes), pollMs: 20 }),
    snapshot: () => async () => {}, modelToken: () => "tok", spent: () => 0.25, tokens: () => ({ input: 10, cached: 0, output: 5 }), gatewayUrl: "http://gw", workDir: dir, log: () => {} });
  const pause = () => new Promise((r) => setTimeout(r, 10));
  const old = kernel();
  const ask = { repo: "acme/app", head: A, run: "code-review", spec: { base: B } };
  const { id } = old.start("github", ask);
  while (!db.prepare("SELECT follow FROM checks WHERE id = ?").get(id).follow) await pause();
  old.detach();
  while (old.inflight() > 0) await pause();
  // The old kernel let go: the run is still running, its box not released and its folder kept.
  const attempt = dirname(boxes[0].out);
  assert.deepEqual([(await old.get("github", id)).state, calls.includes("/job/release"), existsSync(attempt)], ["running", false, true]);
  const boxAt = (await old.get("github", id)).box_at;
  assert.match(boxAt, /^\d{4}-\d\d-\d\dT/, "the check records when it got its box");

  const next = kernel({ ...review, files: { "review.ts": "// the deploy's newer recipe" } });
  await next.recover();
  const v = await next.get("github", id);
  assert.equal(v.state, "done", v.error ?? "");
  assert.equal(v.box_at, boxAt, "an adopted check keeps the box time its first kernel recorded");
  assert.deepEqual([v.receipt.verdict, v.result.findings, v.result.cost_usd, v.result.tokens.output, v.billed_usd], ["pass", [], 0.25, 5, 0.25]);
  assert.deepEqual(next.verify(v.receipt, { repo: "acme/app", head: A, run: "code-review", result: resultHash(JSON.stringify(v.result)) }), { ok: true });
  assert.deepEqual([calls.filter((c) => c === "/check").length, calls.filter((c) => c === "/job/release").length, existsSync(attempt)], [1, 1, false]);
});

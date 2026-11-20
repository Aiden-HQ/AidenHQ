// Check jobs as main.ts wires them (checkbox.ts), through the backplane's routes: a fixture repo served by a stand-in code host
// (`git archive`, as codehost-github's /ops/snapshot), a stand-in launcher, and the box's command run on the host with its
// folders mapped. A fast check sees exactly the change (the box's own history); its receipt verifies for its head only; a
// snapshot of another commit than the one asked for gives no receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkBoxes, checkJobsFrom } from "../src/checkbox.ts";
import { createCodehost } from "../src/codehost.ts";
import { kernel, readBody, recipes, serve } from "./helpers.ts";

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
  // The box's `docker exec`, run here: its env file is its whole env, its folders the check's own.
  const docker = async (args) => {
    const box = boxes.at(-1);
    const env = Object.fromEntries(readFileSync(args[2], "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const argv = args.slice(6).map((a) => a.replaceAll("/aidenhq-out", box.out));
    const r = spawnSync(argv[0], argv.slice(1), { cwd: args[4].replace("/workspace", box.workspace), env: { PATH: process.env.PATH, ...env, HOME: env.HOME.replace("/aidenhq-out", box.out) }, encoding: "utf8" });
    return { exit: r.status, out: `${r.stdout}${r.stderr}`, timedOut: false };
  };
  const secrets = { codehost_github_token: "codehost-token", receipt_secret: "receipt-secret", launcher_kernel_key: "kernel-key", gateway_job_secret: "job-secret" };
  const modules = { modules: { "github": { roles: ["kernel.checks"], token: "codehost_github_token", codehost: { snapshot: { repos: ["acme/*"] } } } } };
  const broker = createCodehost({
    grants: () => Object.entries(modules.modules).map(([module, d]) => ({ ...d.codehost, module })), repos: () => ({}),
    kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${codehost.url}/aidenhq/v1/executor`, auth_secret: "codehost_github_token" } }),
    secret: (n) => secrets[n] ?? "", resolver: { resolve: async (u) => { const x = new URL(u); return { host: x.hostname, port: Number(x.port), path: x.pathname }; }, forget: () => {} },
    workspace: async () => { throw new Error("no clones here"); },
  });
  const call = async (route, body) => (await fetch(`${launcher.url}${route}`, { method: "POST", headers: { authorization: `Bearer ${secrets.launcher_kernel_key}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const checkJobs = checkJobsFrom({
    db: new DatabaseSync(":memory:"), secret: (n) => secrets[n] ?? "", recipes, ask: broker.ask, call, docker, log: () => {},
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
  const box = checkBoxes({ call, docker: async () => ({ exit: 0, out: "ok", timedOut: false }), sleep: async () => void slept++ });
  const run = { check: "c-0000000000000000", image: "engineer", workspace: "/w", out: "/o", cwd: ".", argv: ["true"], env: {}, timeoutMs: 1000 };
  assert.deepEqual(await box.run(run), { exit: 0, out: "ok", timedOut: false });
  assert.equal(asks, 3);
  assert.equal(slept, 2);
  const refused = checkBoxes({ call: async () => { throw Object.assign(new Error("no image"), { status: 400 }); }, sleep: async () => assert.fail("a 400 isn't waited on") });
  await assert.rejects(refused.run(run), /no image/);
});

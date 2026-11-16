// The apply as one generation (spec §5.7.2): validate before anything restarts, health after the switch, one auto-revert
// to the last known good, and the failed pair held off until main moves. Each test builds a product and an instance repo
// (local bare origins) whose product carries the real apply scripts and fakes for everything they call: compile, the
// health check, compose, the units. `docker`, `systemctl`, `systemd-run`, `curl` and `npm` are fakes on PATH, HOME and the
// generations' state dir are temporary, so nothing here reaches a real host. Linux only, like the apply lock it runs under
// (/proc, flock, stat -c): CI's runners.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REAL = ["ops/apply-config.sh", "ops/apply-config-work.sh", "ops/lib/apply-lock.sh", "ops/lib/generations.sh"];

const exe = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, 0o755); };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();

// The product's fakes. compile writes what the instance and the product's VERSION say (staged or not) and fails on
// `broken: true`; the health check fails the kernel line while the applied product has BAD_HEALTH and the test set `break`.
const FAKES = {
  "scripts/compile.mjs": `import fs from "node:fs";
const stage = process.argv.includes("--stage") || process.env.AIDENHQ_COMPILE_STAGE === "1";
const inst = fs.readFileSync(process.env.AIDENHQ_INSTANCE_DIR + "/instance.yaml", "utf8");
if (/broken: true/.test(inst)) { console.error("compile: broken"); process.exit(1); }
const v = fs.readFileSync("VERSION", "utf8");
const out = stage ? "config.next" : "config";
fs.mkdirSync(out + "/kernel", { recursive: true });
fs.writeFileSync(out + "/paperclip.yaml", inst + v);
fs.writeFileSync(out + "/kernel/connections.json", "{}\\n");
fs.writeFileSync(stage ? "compose.modules.next.yaml" : "compose.modules.yaml", "services: {}\\n# " + v);
if (!stage) fs.appendFileSync(process.env.CALLS, "compile\\n");
`,
  "scripts/edge.mjs": "",
  "scripts/host-serve.mjs": "",
  "scripts/agent-check.mjs": "",
  "scripts/paperclip-setup.mjs": `import fs from "node:fs"; fs.appendFileSync(process.env.CALLS, "setup\\n");\n`,
  "services/runner/src/apply.ts": `import { readFileSync } from "node:fs";
if (process.argv[2] === "product-pin") process.stdout.write(/^product:\\s*([0-9a-f]{40})\\s*$/m.exec(readFileSync(process.argv[3], "utf8"))?.[1] ?? "");
`,
};
const SCRIPTS = {
  "scripts/healthcheck.sh": `#!/usr/bin/env bash
echo "AidenHQ health"
echo "  ok    paperclip http (127.0.0.1:3100)"
[ -f "$CTRL/flaky" ] && echo "  FAIL  flaky probe  red before the apply too"
echo "  skip  ops-mcp (meetings module not installed)"
# What is applied decides (data/applied-product), as on a host the running services do, never the checkout alone.
if [ -f "$CTRL/break" ] && git cat-file -e "$(cat data/applied-product 2>/dev/null)":BAD_HEALTH 2>/dev/null; then echo "  FAIL  kernel (10.231.0.1:3130)  down"; exit 1; fi
echo "  ok    kernel (10.231.0.1:3130)"
`,
  "ops/compose-recreate.sh": `#!/usr/bin/env bash\necho recreate >> "$CALLS"\necho "compose: recreated what moved"\n`,
  "ops/computer-images.sh": "#!/usr/bin/env bash\n",
  "ops/warehouse-sources.sh": "#!/usr/bin/env bash\n",
  "ops/ci-runner-units.sh": "#!/usr/bin/env bash\n",
};
const BINS = {
  docker: `#!/usr/bin/env bash\nprintf 'docker %s\\n' "$*" >> "$CALLS"\ncase "$*" in *"config -q"*) grep -q badcompose compose.modules.next.yaml && exit 1 ;; esac\nexit 0\n`,
  systemctl: `#!/usr/bin/env bash\nprintf 'systemctl %s\\n' "$*" >> "$CALLS"\ncase "$*" in *is-enabled*) exit 1 ;; esac\nexit 0\n`,
  "systemd-run": `#!/usr/bin/env bash\nprintf 'systemd-run %s\\n' "$*" >> "$CALLS"\n`,
  curl: `#!/usr/bin/env bash\n[ -f "$CTRL/kernel-down" ] && exit 7\necho ok\n`,
  npm: `#!/usr/bin/env bash\nprintf 'npm %s\\n' "$*" >> "$CALLS"\n`,
};

/** A host: product and instance repos with bare origins, the product at P1 and the instance at I1 (pinning P1). */
function world() {
  const root = mkdtempSync(join(tmpdir(), "apply-atomic-"));
  const d = (...p) => join(root, ...p);
  for (const x of ["ctrl", "home", "state", "bin"]) mkdirSync(d(x));
  writeFileSync(d("calls"), "");
  for (const [n, t] of Object.entries(BINS)) exe(d("bin", n), t);
  // The product.
  git(root, "init", "-q", "--bare", "-b", "main", "p.git");
  git(root, "clone", "-q", d("p.git"), "pw");
  for (const f of REAL) exe(d("pw", f), readFileSync(join(repo, f), "utf8"));
  for (const [f, t] of Object.entries(FAKES)) { mkdirSync(dirname(d("pw", f)), { recursive: true }); writeFileSync(d("pw", f), t); }
  for (const [f, t] of Object.entries(SCRIPTS)) exe(d("pw", f), t);
  for (const u of ["aidenhq-kernel.service", "aidenhq-runner.service", "aidenhq-backup.service", "aidenhq-backup.timer", "aidenhq-host-metrics.service", "aidenhq-host-metrics.timer"]) {
    mkdirSync(d("pw", "ops/units"), { recursive: true });
    writeFileSync(d("pw", "ops/units", u), `[Unit]\nDescription=${u}\n`);
  }
  writeFileSync(d("pw", ".gitignore"), "config/\ndata/\nconfig.next/\ncompose.modules.yaml\ncompose.modules.next.yaml\nnode_modules/\n");
  const commitProduct = (version, extra = {}, remove = []) => {
    writeFileSync(d("pw", "VERSION"), `${version}\n`);
    for (const [f, t] of Object.entries(extra)) writeFileSync(d("pw", f), t);
    for (const f of remove) rmSync(d("pw", f), { force: true });
    git(d("pw"), "add", "-A");
    git(d("pw"), "commit", "-q", "-m", `product ${version}`);
    git(d("pw"), "push", "-q", "origin", "HEAD:main");
    return git(d("pw"), "rev-parse", "HEAD");
  };
  const p1 = commitProduct("1");
  git(root, "clone", "-q", d("p.git"), "prod");
  for (const x of ["scripts/node_modules", "services/runner/node_modules"]) mkdirSync(d("prod", x), { recursive: true });
  // The instance.
  git(root, "init", "-q", "--bare", "-b", "main", "i.git");
  git(root, "clone", "-q", d("i.git"), "iw");
  const commitInstance = (product, extra = "") => {
    writeFileSync(d("iw", "instance.yaml"), `product: ${product}\n${extra}`);
    git(d("iw"), "add", "-A");
    git(d("iw"), "commit", "-q", "-m", `pin ${product.slice(0, 7)}`);
    git(d("iw"), "push", "-q", "origin", "HEAD:main");
    return git(d("iw"), "rev-parse", "HEAD");
  };
  const i1 = commitInstance(p1);
  git(root, "clone", "-q", d("i.git"), "inst");
  const run = (...args) => new Promise((resolve) => {
    execFile("bash", ["ops/apply-config.sh", ...args], {
      cwd: d("prod"),
      env: {
        PATH: `${d("bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: d("home"), AIDENHQ_STATE_DIR: d("state"), AIDENHQ_INSTANCE_DIR: d("inst"),
        CTRL: d("ctrl"), CALLS: d("calls"), AIDENHQ_HEALTH_DEADLINE_S: "2", AIDENHQ_KERNEL_DEADLINE_S: "2", AIDENHQ_HEALTH_INTERVAL_S: "1",
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  const gens = () => (existsSync(d("state/generations.jsonl")) ? readFileSync(d("state/generations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const head = (r) => git(d(r), "rev-parse", "HEAD");
  return { d, p1, i1, commitProduct, commitInstance, run, gens, head, calls: () => readFileSync(d("calls"), "utf8") };
}

test("a first apply seeds the running pair as the last known good, validates, switches and marks itself good", async () => {
  const w = world();
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.gens().map((g) => [g.n, g.health, g.product, g.instance]), [[1, "good", w.p1, w.i1], [2, "good", w.p1, w.i1]]);
  assert.ok(r.out.indexOf("apply timing: validate") < r.out.indexOf("apply timing: compose"), r.out);
  assert.match(readFileSync(w.d("state/apply-2.log"), "utf8"), /generation 2 is good/);
  assert.ok(!existsSync(w.d("prod/config.next")), "the staged copy is cleaned up after the switch");
});

test("a staged compile failure leaves the running config byte-identical, both checkouts restored and nothing restarted", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  const files = ["config/paperclip.yaml", "config/kernel/connections.json", "compose.modules.yaml"].map((f) => [f, readFileSync(w.d("prod", f), "utf8")]);
  const callsBefore = w.calls();
  const p2 = w.commitProduct("2");
  w.commitInstance(p2, "broken: true\n");
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /refusing: the staged compile failed; nothing was switched or restarted/);
  for (const [f, text] of files) assert.equal(readFileSync(w.d("prod", f), "utf8"), text, `${f} is untouched`);
  assert.equal(w.head("prod"), w.p1, "the product checkout is back at the running product");
  assert.equal(w.head("inst"), w.i1, "the instance checkout is back at the running instance");
  const after = w.calls().slice(callsBefore.length);
  assert.doesNotMatch(after, /^(compile|recreate|setup)$|systemctl --user (restart|kill)|up -d/m, after);
  assert.equal(w.gens().at(-1).health, "refused");
});

test("A14: a post-apply health failure reverts to the LKG and marks the generation failed; the pair is held until --retry", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  const i2 = w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens();
  assert.deepEqual(g.map((x) => [x.n, x.health]), [[1, "good"], [2, "good"], [3, "failed"], [4, "good"]]);
  assert.match(g[2].reason, /checks that passed before the apply fail now: kernel \(10\.231\.0\.1:3130\)/);
  assert.equal(g[2].log, w.d("state/apply-3.log"));
  assert.deepEqual([g[3].product, g[3].instance, g[3].revert_of, g[3].lkg], [w.p1, w.i1, 3, 2]);
  assert.equal(w.head("prod"), w.p1, "the product is back at the last known good");
  assert.equal(w.head("inst"), w.i1, "the instance checkout is back at the last known good");
  assert.throws(() => git(w.d("inst"), "symbolic-ref", "-q", "HEAD"), "detached");
  assert.equal(git(w.d("inst"), "rev-parse", "origin/main"), i2, "the instance's origin/main is not moved");
  assert.equal(readFileSync(w.d("prod/data/applied-product"), "utf8").trim(), w.p1);
  assert.match(readFileSync(w.d("state/apply-3.log"), "utf8"), /apply alert: generation 3 failed its health check .* reverted to generation 2/);
  // The owner's alert: the monitoring textfile the ApplyFailed rule reads.
  mkdirSync(w.d("data/modules/monitoring/textfile"), { recursive: true });
  execFileSync("bash", [join(repo, "ops/host-metrics.sh")], { env: { PATH: `${w.d("bin")}:/usr/bin:/bin`, HOME: w.d("home"), AIDENHQ_DATA_DIR: w.d("data"), AIDENHQ_STATE_DIR: w.d("state") } });
  assert.match(readFileSync(w.d("data/modules/monitoring/textfile/generations.prom"), "utf8"), /^aidenhq_apply_failed\{n="3",health="failed",.*log=".*apply-3\.log"\} 1$/m);

  // Held: main still resolves to the failed pair, so a plain apply (the runner's) is refused and changes nothing.
  const held = await w.run();
  assert.equal(held.status, 1, held.out);
  assert.match(held.out, /failed its health check as generation 3 .* --retry/);
  assert.equal(w.gens().length, 4, "no new generation");
  assert.equal(w.head("prod"), w.p1);
  assert.equal(w.head("inst"), w.i1);

  // --retry from the owner's shell, with the fault gone: it applies, and the instance is back on main.
  rmSync(w.d("ctrl/break"));
  const retry = await w.run("--retry");
  assert.equal(retry.status, 0, retry.out);
  assert.deepEqual(w.gens().at(-1), { ...w.gens().at(-1), product: p2, instance: i2, health: "good" });
  assert.equal(w.head("prod"), p2);
  assert.equal(git(w.d("inst"), "symbolic-ref", "--short", "HEAD"), "main");
});

test("a check failing in the baseline does not count", async () => {
  const w = world();
  writeFileSync(w.d("ctrl/flaky"), "");
  assert.equal((await w.run()).status, 0);
  const p2 = w.commitProduct("2");
  w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /health baseline: 2 ok, 1 failing \(not counted\)/);
  assert.equal(w.gens().at(-1).health, "good");
  assert.equal(w.head("prod"), p2);
});

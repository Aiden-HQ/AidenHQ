// The apply as one generation (spec §5.7.2): validate before anything restarts, snapshot the touched modules' data (§6.4.1),
// health after the switch, one auto-revert to the last known good with that data put back, the failed pair held off until
// main moves, and ops/rollback.sh restoring the data an older generation needs. Each test builds a product and an instance repo
// (local bare origins) whose product carries the real apply scripts and fakes for everything they call: compile, the
// health check, compose, the units. `docker` (its `run` executes the container's command on the host, volumes mapped),
// `systemctl`, `systemd-run`, `curl`, `df` and `npm` are fakes on PATH, HOME and the
// generations' state dir are temporary, so nothing here reaches a real host. Linux only, like the apply lock it runs under
// (/proc, flock, stat -c): CI's runners.
import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const NOT_LINUX = process.platform !== "linux" && "needs flock(1), absent on macOS";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REAL = ["ops/apply-config.sh", "ops/apply-config-work.sh", "ops/host-metrics.sh", "ops/lib/apply-lock.sh", "ops/lib/generations.sh", "ops/lib/progress.sh", "ops/rollback.sh", "scripts/compiler/data-version.ts", "scripts/imports.ts"];

const exe = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, 0o755); };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();

// The product's fakes. compile writes what the instance and the product's VERSION say (staged or not) and fails on
// `broken: true`; the health check fails the kernel line while the applied product has BAD_HEALTH and the test set `break`.
// Module acme has a data dir at the product's DATA_VERSION (0 without one): compile keeps its marker as the real one does,
// and at 1 its data migrates (a line added).
const FAKES = {
  "scripts/compile.ts": `import fs from "node:fs";
import { checkDataVersion } from "../scripts/compiler/data-version.ts";
const stage = process.argv.includes("--stage") || process.env.AIDENHQ_COMPILE_STAGE === "1";
const inst = fs.readFileSync(process.env.AIDENHQ_INSTANCE_DIR + "/instance.yaml", "utf8");
if (/broken: true/.test(inst)) { console.error("compile: broken"); process.exit(1); }
const v = fs.readFileSync("VERSION", "utf8");
const out = stage ? "config.next" : "config";
fs.mkdirSync(out + "/kernel", { recursive: true });
fs.writeFileSync(out + "/paperclip.yaml", inst + v);
fs.writeFileSync(out + "/kernel/connections.json", "{}\\n");
fs.writeFileSync(out + "/modules.json", JSON.stringify({ modules: /^modules: (.*)$/m.exec(inst)?.[1] ?? "" }) + "\\n");
fs.writeFileSync(stage ? "compose.modules.next.yaml" : "compose.modules.yaml",
  "services:\\n" + (inst.includes("monitoring") ? "  monitoring-node-exporter:\\n    image: x\\n" : "")
    + (inst.includes("security") ? "  security-scanner:\\n    image: x\\n" : "") + "# " + v);
const dv = fs.existsSync("DATA_VERSION") ? Number(fs.readFileSync("DATA_VERSION", "utf8")) : 0;
fs.writeFileSync(out + "/module-data.json", JSON.stringify({ acme: { data_version: dv } }));
const acme = "data/modules/acme";
if (fs.existsSync(acme)) {
  try { checkDataVersion("acme", dv, acme, !stage); } catch (e) { console.error("compile: " + e.message); process.exit(1); }
  if (!stage && dv === 1 && !fs.readFileSync(acme + "/state/db.txt", "utf8").includes("v1")) fs.appendFileSync(acme + "/state/db.txt", "v1 migrated\\n");
}
if (!stage) fs.appendFileSync(process.env.CALLS, "compile\\n");
`,
  "scripts/edge.ts": "",
  "scripts/host-serve.ts": "",
  "scripts/agent-check.ts": "",
  "scripts/paperclip-setup.ts": `import fs from "node:fs"; fs.appendFileSync(process.env.CALLS, "setup\\n");\n`,
  // The real one imports the kernel's packages: only an installed kernel/node_modules (npm's fake below) lets it run.
  "kernel/src/apply.ts": `import "kernel-dep";
import { readFileSync } from "node:fs";
if (process.argv[2] === "product-pin") process.stdout.write(/^product:\\s*([0-9a-f]{40})\\s*$/m.exec(readFileSync(process.argv[3], "utf8"))?.[1] ?? "");
if (process.argv[2] === "product-fork") process.stdout.write(/^product_fork: (\\S+ [0-9a-f]{40})$/m.exec(readFileSync(process.argv[3], "utf8"))?.[1] ?? "");
`,
};
const SCRIPTS = {
  "scripts/healthcheck.sh": `#!/usr/bin/env bash
echo "AidenHQ health"
echo "  ok    paperclip http (127.0.0.1:3100)"
[ -f "$CTRL/flaky" ] && echo "  FAIL  flaky probe  red before the apply too"
# What scripts/healthcheck.sh says when the unit's ExecStart names another checkout (scripts/test/healthcheck.test.ts).
[ -f "$CTRL/mismatch" ] && echo "  FAIL  host metrics timer runs the applied checkout  the unit runs /old/ops/host-metrics.sh, not $PWD/ops/host-metrics.sh"
echo "  skip  ops-mcp (meetings module not installed)"
# What is applied decides (data/applied-product), as on a host the running services do, never the checkout alone.
if [ -f "$CTRL/break" ] && git cat-file -e "$(cat data/applied-product 2>/dev/null || echo none)":BAD_HEALTH 2>/dev/null; then
  echo "  FAIL  kernel (10.231.0.1:3130)  down"
  # Arms the auto-revert's switch to fail after this health check: between the failed generation's switch and its revert.
  [ -f "$CTRL/arm-badrevert" ] && touch "$CTRL/badrevert"
  exit 1
fi
echo "  ok    kernel (10.231.0.1:3130)"
`,
  // With ctrl/block the step waits (blocked) until ctrl/release, then lets later applies through: an apply to kill mid-compose.
  "ops/compose-recreate.sh": `#!/usr/bin/env bash
echo recreate >> "$CALLS"
[ -f "$CTRL/badrevert" ] && { echo "compose: recreate failed in the revert"; exit 1; }
if [ -f "$CTRL/block" ]; then touch "$CTRL/blocked"; while [ ! -f "$CTRL/release" ]; do sleep 0.1; done; rm -f "$CTRL/block"; fi
echo "compose: recreated what moved"
`,
  "ops/computer-images.sh": "#!/usr/bin/env bash\n",
  "ops/warehouse-sources.sh": "#!/usr/bin/env bash\n",
  "ops/ci-runner-units.sh": "#!/usr/bin/env bash\n",
};
const BINS = {
  docker: `#!/usr/bin/env bash\nprintf 'docker %s\\n' "$*" >> "$CALLS"\n[ "$1" = run ] && exec node "$(dirname "$0")/docker-run.mjs" "\${@:2}"\ncase "$*" in *"config -q"*) grep -q badcompose compose.modules.next.yaml && exit 1 ;; "compose build") [ -f "$CTRL/badbuild" ] && exit 1 ;; *"config --format json"*) printf '{"services":{"svc":{"image":"svc:local","build":{"context":"%s/svc","dockerfile":"Dockerfile"}}}}\\n' "$PWD" ;; esac\nexit 0\n`,
  // docker run [--rm] [-i] [--network x] [-v host:ctr[:ro]]... [-e K=V]... image cmd...: cmd on the host, container paths mapped.
  "docker-run.mjs": `import { spawnSync } from "node:child_process";
const a = process.argv.slice(2), vols = [], env = {};
let i = 0;
for (; i < a.length; i++) {
  if (a[i] === "--rm" || a[i] === "-i") continue;
  if (a[i] === "--network") i++;
  else if (a[i] === "-v") { const [h, c] = a[++i].split(":"); vols.push([c, h]); }
  else if (a[i] === "-e") { const [k, ...v] = a[++i].split("="); env[k] = v.join("="); }
  else break;
}
const map = (s) => vols.sort((x, y) => y[0].length - x[0].length).reduce((t, [c, h]) => t.replace(new RegExp("(^|[\\\\s\\"'=])" + c + "(?=/|$|[\\\\s\\"'])", "g"), "$1" + h), s);
const [cmd, ...rest] = a.slice(i + 1);
process.exit(spawnSync(cmd, rest.map(map), { stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1);
`,
  df: `#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfake 1 1 999999999 1%% /\\n'\n`,
  // list-unit-files is empty unless ctrl/runners names a count: then the CI runner template is enabled (the apply keeps it in
  // step with the checkout).
  systemctl: `#!/usr/bin/env bash\nprintf 'systemctl %s\\n' "$*" >> "$CALLS"\ncase "$*" in *is-enabled*) exit 1 ;; *list-unit-files*) [ -f "$CTRL/runners" ] && echo "aidenhq-ci-runner@.service enabled" ; exit 0 ;; esac\nexit 0\n`,
  "systemd-run": `#!/usr/bin/env bash\nprintf 'systemd-run %s\\n' "$*" >> "$CALLS"\n`,
  curl: `#!/usr/bin/env bash\n[ -f "$CTRL/kernel-down" ] && exit 7\necho ok\n`,
  // npm ci --prefix <dir> installs the one package the fake kernel/src/apply.ts imports.
  npm: `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$CALLS"
while [ $# -gt 0 ]; do
  if [ "$1" = --prefix ]; then mkdir -p "$2/node_modules/kernel-dep"; echo '{"name":"kernel-dep","main":"index.js"}' > "$2/node_modules/kernel-dep/package.json"; : > "$2/node_modules/kernel-dep/index.js"; fi
  shift
done
`,
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
  for (const u of ["aidenhq-kernel.service", "aidenhq-apply-recover.service", "aidenhq-backup.service", "aidenhq-backup.timer", "aidenhq-host-metrics.service", "aidenhq-host-metrics.timer", "aidenhq-security-sbom.service", "aidenhq-security-sbom.timer", "aidenhq-ci-runner@.service"]) {
    mkdirSync(d("pw", "ops/units"), { recursive: true });
    // The host-metrics, security-sbom and CI runner units are the product's own: the apply compares the installed copy with them.
    writeFileSync(d("pw", "ops/units", u), /^aidenhq-(host-metrics|security-sbom|ci-runner@?)\./.test(u) ? readFileSync(join(repo, "ops/units", u), "utf8") : `[Unit]\nDescription=${u}\n`);
  }
  // The one service image the product builds, from svc/ (the fake compose config names it as the build context).
  mkdirSync(d("pw", "svc"));
  writeFileSync(d("pw", "svc/Dockerfile"), "FROM scratch\n");
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
  mkdirSync(d("prod", "scripts/node_modules"), { recursive: true });
  // A host that has applied P1 before (a first install has no applied-product: see the fresh-install test).
  mkdirSync(d("prod", "data"), { recursive: true });
  writeFileSync(d("prod", "data/applied-product"), `${p1}\n`);
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
  const env = () => ({
    PATH: `${d("bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: d("home"), AIDENHQ_STATE_DIR: d("state"), AIDENHQ_INSTANCE_DIR: d("inst"),
    CTRL: d("ctrl"), CALLS: d("calls"), AIDENHQ_HEALTH_DEADLINE_S: "2", AIDENHQ_KERNEL_DEADLINE_S: "2", AIDENHQ_HEALTH_INTERVAL_S: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  const sh = (script, ...args) => new Promise((resolve) => {
    execFile("bash", [script, ...args], { cwd: d("prod"), env: env() }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  const run = (...args) => sh("ops/apply-config.sh", ...args);
  // An apply in its own process group, to kill: the group (SIGKILL, as a host loses it) or just its shell.
  const start = (...args) => {
    const child = spawn("bash", ["ops/apply-config.sh", ...args], { cwd: d("prod"), env: env(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    const done = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, out })));
    return { child, done };
  };
  const gens = () => (existsSync(d("state/generations.jsonl")) ? readFileSync(d("state/generations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const head = (r) => git(d(r), "rev-parse", "HEAD");
  // What an auto-revert of a product move leaves: the failed generation's instance (the instance's main, not moved) with the
  // last known good's pin, as a local commit on it, detached, and recorded on the revert's generation.
  const revertedTo = (product) => {
    assert.equal(git(d("inst"), "rev-parse", "HEAD^"), git(d("inst"), "rev-parse", "origin/main"), "built on the instance's main");
    assert.equal(git(d("inst"), "show", "HEAD:instance.yaml"), `product: ${product}`);
    assert.equal(gens().at(-1).instance, head("inst"));
    assert.throws(() => git(d("inst"), "symbolic-ref", "-q", "HEAD"), "detached");
  };
  return { d, p1, i1, commitProduct, commitInstance, run, start, sh, gens, head, revertedTo, calls: () => readFileSync(d("calls"), "utf8") };
}

// Each test builds its own world (temp repos, HOME, state dir, apply lock and env), so they run side by side.
describe("the apply as one generation", { concurrency: true, skip: NOT_LINUX }, () => {
test("a first apply seeds the running pair as the last known good, validates, switches and marks itself good", async () => {
  const w = world();
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.gens().map((g) => [g.n, g.health, g.product, g.instance]), [[1, "good", w.p1, w.i1], [2, "good", w.p1, w.i1]]);
  assert.ok(r.out.indexOf("apply timing: validate") < r.out.indexOf("apply timing: compose"), r.out);
  assert.match(readFileSync(w.d("state/apply-2.log"), "utf8"), /generation 2 is good/);
  assert.ok(!existsSync(w.d("prod/config.next")), "the staged copy is cleaned up after the switch");
  // The board mounts this mirror, and it must match the real file after an append and after a mark (which replaces it by
  // rename). The board mounts its directory, never the file: a bind mount of the file would keep the inode a rename replaces.
  assert.equal(readFileSync(w.d("state/board/generations.jsonl"), "utf8"), readFileSync(w.d("state/generations.jsonl"), "utf8"));
  const board = YAML.parse(readFileSync(join(repo, "compose.yaml"), "utf8")).services.board.volumes.find((v) => String(v).endsWith(":/generations:ro"));
  assert.ok(board, "the board mounts the generations mirror");
  assert.match(board, /\/board:\/generations:ro$/, `the mirror's directory, not the file: ${board}`);
});

// Nothing changed = nothing rebuilt and no setup; an instance-only change sets up (its handbooks and config) without a build;
// a product change builds only when it touches a build context and sets up only when it touches what setup reads; a missing
// image builds again.
test("an apply builds and sets up only what its inputs changed", async () => {
  const w = world();
  const ran = (what) => w.calls().split("\n").filter((l) => l === what).length;
  const apply = async (...args) => { writeFileSync(w.d("calls"), ""); const r = await w.run(...args); assert.equal(r.status, 0, r.out); return r; };
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [1, 1], "a fresh host sets up, and builds once: nothing records what its images were built from");
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [0, 0], "no change: neither");
  w.commitInstance(w.p1, "settings: {x: 1}\n");
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [1, 0], "an instance change sets up, and builds nothing");
  w.commitInstance(w.commitProduct("2"));
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [1, 0], "a product change to the compiled config sets up, and builds nothing");
  w.commitInstance(w.commitProduct("2", { "kernel/x.ts": "export {};\n" }));
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [0, 0], "a kernel-only product change: neither");
  w.commitInstance(w.commitProduct("2", { "svc/app.js": "1;\n" }));
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [0, 1], "a change inside a build context builds, and sets nothing up");
  // A failed build refuses the generation and records nothing, so the next apply builds again.
  writeFileSync(w.d("ctrl/badbuild"), "");
  w.commitInstance(w.commitProduct("2", { "svc/app.js": "2;\n" }));
  const bad = await w.run();
  assert.match(bad.out, /an image failed to build/, bad.out);
  assert.ok(!existsSync(w.d("state/steps/images")), "no record of a failed build");
  rmSync(w.d("ctrl/badbuild"));
  await apply();
  assert.equal(ran("docker compose build"), 1, "built again");
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [0, 0], "and then nothing again");
  // A service image the compose files need but this host lacks: built again, though the product is the same.
  writeFileSync(w.d("bin/docker"), readFileSync(w.d("bin/docker"), "utf8").replace("case \"$*\" in", "case \"$*\" in *\"config --images\"*) echo missing/image ;; *\"image inspect\"*) exit 1 ;; "));
  await apply("--force");
  assert.equal(ran("docker compose build"), 1, "a missing image is built");
});

test("a second apply of the pair already applied is a no-op; --force runs it in full", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  const n = w.gens().length, before = w.calls();
  const again = await w.run();
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, new RegExp(`already applied: generation ${n} \\(product ${w.p1.slice(0, 12)}, instance ${w.i1.slice(0, 12)}\\)`));
  assert.match(again.out, /apply timing: total/);
  assert.equal(w.gens().length, n, "no new generation");
  assert.equal(w.calls(), before, "nothing ran");
  const forced = await w.run("--force");
  assert.equal(forced.status, 0, forced.out);
  assert.doesNotMatch(forced.out, /already applied/);
  assert.equal(w.gens().length, n + 1, "--force adds a generation");
});

// A fresh host has no kernel/node_modules: the pin is read with the kernel's own parser, so its deps are installed first.
test("a fresh host with no kernel/node_modules installs the kernel's deps before it reads the pin", async () => {
  const w = world();
  assert.ok(!existsSync(w.d("prod/kernel/node_modules")));
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.equal(w.calls().split("\n").filter((l) => l.startsWith("npm ci --prefix kernel")).length, 1, w.calls());
  assert.equal(w.gens().at(-1).health, "good");
});

// Lean-core 5e: the kernel the instance runs is its own fork (product_fork:) when that descends from the pin; else refused.
test("a product_fork on top of the pin is what runs (and is recorded); one off the pin is refused", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  git(w.d(), "clone", "-q", w.d("p.git"), "fw");
  writeFileSync(w.d("fw", "VERSION"), "1-fork\n");
  git(w.d("fw"), "commit", "-qam", "patch");
  const fork = git(w.d("fw"), "rev-parse", "HEAD");
  // The fork is fetched over https only (a local path is refused); its commit is already here, as a fetch would leave it.
  git(w.d("prod"), "fetch", "-q", w.d("fw"), "main");
  const i2 = w.commitInstance(w.p1, `product_fork: https://example.com/acme-bot/fork.git ${fork}\n`);
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /kernel: running the instance's fork \w{12} .* on top of product \w{12}/);
  assert.equal(w.head("prod"), fork);
  assert.deepEqual([w.gens().at(-1).product, w.gens().at(-1).instance, w.gens().at(-1).health], [fork, i2, "good"]);
  git(w.d("fw"), "checkout", "-q", "--orphan", "elsewhere");
  git(w.d("fw"), "commit", "-qm", "unrelated");
  git(w.d("prod"), "fetch", "-q", w.d("fw"), "elsewhere");
  w.commitInstance(w.p1, `product_fork: https://example.com/acme-bot/fork.git ${git(w.d("fw"), "rev-parse", "HEAD")}\n`);
  const bad = await w.run();
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /refusing: product_fork \w{12} does not descend from product \w{12}/);
  assert.equal(w.head("prod"), fork, "still the fork that ran");
  // A fork named by a local path is never fetched (https only).
  git(w.d("fw"), "checkout", "-q", "main");
  writeFileSync(w.d("fw", "VERSION"), "1-fork-2\n");
  git(w.d("fw"), "commit", "-qam", "patch 2");
  w.commitInstance(w.p1, `product_fork: ${w.d("fw")} ${git(w.d("fw"), "rev-parse", "HEAD")}\n`);
  const local = await w.run();
  assert.equal(local.status, 1, local.out);
  assert.match(local.out, /refusing: couldn't fetch product_fork/);
});

// The security module's SBOM timer runs the checkout this apply applied, not the one setup recorded: every apply writes the
// unit's last EnvironmentFile= (AIDENHQ_DIR=realpath of the applied checkout) and installs/enables the timer; a module the
// instance no longer has removes it. The unit's AIDENHQ_DIR is therefore the applied checkout even while
// ~/.config/aidenhq-checkout.env still names the one setup installed from.
// A unit's AIDENHQ_DIR as systemd resolves it: Environment= first, then each EnvironmentFile= in order (a later one wins).
function resolvedAidenhqDir(unit, home) {
  let dir;
  for (const line of readFileSync(unit, "utf8").split("\n")) {
    const m = /^(Environment|EnvironmentFile)=(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].replaceAll("%h", home);
    if (m[1] === "Environment") {
      for (const kv of value.split(/\s+/)) if (kv.startsWith("AIDENHQ_DIR=")) dir = kv.slice("AIDENHQ_DIR=".length);
    } else {
      const file = value.replace(/^-/, "");
      if (!existsSync(file)) continue;
      const v = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("AIDENHQ_DIR=")).at(-1);
      if (v) dir = v.slice("AIDENHQ_DIR=".length);
    }
  }
  return dir;
}

test("the security sbom timer follows the applied checkout and is removed when the security module is off", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  mkdirSync(units, { recursive: true });
  // Setup's record from another checkout, and the timer already installed the way setup leaves it (no per-apply file).
  const old = w.d("old-checkout");
  mkdirSync(old, { recursive: true });
  writeFileSync(w.d("home/.config/aidenhq-checkout.env"), `AIDENHQ_DIR=${old}\n`);
  copyFileSync(join(repo, "ops/units/aidenhq-security-sbom.service"), join(units, "aidenhq-security-sbom.service"));
  writeFileSync(join(units, "aidenhq-security-sbom.timer"), "[Timer]\n");
  w.commitInstance(w.p1, "modules: [security]\n");
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  // The per-apply file names this checkout, realpath'd; the unit and timer are the product's own.
  assert.equal(readFileSync(w.d("home/.config/aidenhq-security-sbom.env"), "utf8"), `AIDENHQ_DIR=${realpathSync(w.d("prod"))}\n`);
  assert.equal(readFileSync(join(units, "aidenhq-security-sbom.service"), "utf8"), readFileSync(join(repo, "ops/units/aidenhq-security-sbom.service"), "utf8"));
  assert.equal(readFileSync(join(units, "aidenhq-security-sbom.timer"), "utf8"), readFileSync(join(repo, "ops/units/aidenhq-security-sbom.timer"), "utf8"));
  assert.match(w.calls(), /systemctl --user enable --now --quiet aidenhq-security-sbom\.timer/);
  // Resolved the way systemd does: the per-apply file is read after ~/.config/aidenhq-checkout.env, so it wins.
  assert.equal(resolvedAidenhqDir(join(units, "aidenhq-security-sbom.service"), w.d("home")), realpathSync(w.d("prod")));
  // The module off: the timer is disabled and removed, and so is the per-apply file.
  w.commitInstance(w.p1, "modules: []\n");
  const off = await w.run();
  assert.equal(off.status, 0, off.out);
  assert.match(w.calls(), /systemctl --user disable --now --quiet aidenhq-security-sbom\.timer/);
  assert.ok(!existsSync(join(units, "aidenhq-security-sbom.service")) && !existsSync(join(units, "aidenhq-security-sbom.timer")));
  assert.ok(!existsSync(w.d("home/.config/aidenhq-security-sbom.env")));
});

// The runner template the enabled units run is the checkout's, kept in step by the apply: a rollout lands the ExecStartPre
// backoff with the scripts it calls, and an installed copy from another product is replaced (rollback included) rather than
// left calling a helper this checkout may not have. A host with no runner unit enabled keeps the template it has.
test("the CI runner unit template follows the applied checkout, only while runner units are declared", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  mkdirSync(units, { recursive: true });
  // An enabled runner instance (queue) and a template an older product installed.
  writeFileSync(w.d("ctrl/runners"), "");
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=old\nExecStart=/usr/bin/env bash ${AIDENHQ_DIR}/ops/ci-runner.sh %i\n");
  writeFileSync(join(units, "aidenhq-ci-runner@1.service"), "[Unit]\n");
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), readFileSync(join(repo, "ops/units/aidenhq-ci-runner@.service"), "utf8"), "the template is the product's");
  assert.match(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), /ops\/ci-runner-backoff\.sh %i/, "and carries the ExecStartPre backoff");
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@1.service"), "utf8"), "[Unit]\n", "the instance's own unit is untouched");
  // The data dir the unit's scripts resolve (they read no .env themselves) comes from this env file, which the apply writes
  // from the host's settings; the template reads it last, so it wins.
  assert.match(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), /EnvironmentFile=-%h\/\.config\/aidenhq-ci-runner\.env/, "the template reads the per-apply data dir");
  assert.match(readFileSync(w.d("home/.config/aidenhq-ci-runner.env"), "utf8"), /^AIDENHQ_DATA_DIR=\/.*\/data$/m, "an absolute data dir, from the apply's .env");
  // Nothing changed: no rewrite, no reload.
  const before = w.calls();
  assert.equal((await w.run()).status, 0);
  assert.doesNotMatch(w.calls().slice(before.length), /ci runner unit template installed\/updated/, "an unchanged template is not rewritten");
  // Runners retired from the config: the installed template stays as the operator left it.
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=kept\n");
  rmSync(w.d("ctrl/runners"));
  assert.equal((await w.run()).status, 0);
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), "[Unit]\nDescription=kept\n", "no runner units declared: the apply leaves the template alone");
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

test("a first install's failed health check isn't re-applied as its own last known good", async () => {
  const w = world();
  rmSync(w.d("prod/data/applied-product"));
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /nothing applied on this host yet: this apply can't auto-revert/);
  assert.doesNotMatch(r.out, /auto-revert: re-applying/);
  assert.deepEqual(w.gens().map((x) => [x.n, x.health]), [[1, "failed"]]);
});

// An older release's updater unit ran the apply as its child: the apply removes that unit only after its health verdict.
test("the retired update units are removed once the generation is good, never while a failed one is being reverted", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  const units = w.d("home/.config/systemd/user");
  mkdirSync(units, { recursive: true });
  for (const u of ["aidenhq-update.service", "aidenhq-update.timer"]) writeFileSync(join(units, u), "[Unit]\n");
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  w.commitInstance(p2);
  assert.equal((await w.run()).status, 1);
  assert.ok(existsSync(join(units, "aidenhq-update.service")), "a failed generation leaves them");
  rmSync(w.d("ctrl/break"));
  w.commitInstance(w.p1, "x: 1\n");
  assert.equal((await w.run()).status, 0);
  assert.ok(!existsSync(join(units, "aidenhq-update.service")) && !existsSync(join(units, "aidenhq-update.timer")), "a good one removes them");
});

test("A14: a post-apply health failure reverts to the LKG's product, keeps what the instance gained since, and holds the pair until --force", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  // An app registered after the last known good (apps-mcp commits apps.yaml straight to the instance's main).
  writeFileSync(w.d("iw", "apps.yaml"), "apps:\n  - name: hello\n");
  git(w.d("iw"), "add", "apps.yaml");
  git(w.d("iw"), "commit", "-q", "-m", "apps: add hello");
  git(w.d("iw"), "push", "-q", "origin", "HEAD:main");
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  const i2 = w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens();
  assert.deepEqual(g.map((x) => [x.n, x.health]), [[1, "good"], [2, "good"], [3, "failed"], [4, "good"]]);
  assert.match(g[2].reason, /checks that passed before the apply fail now: kernel \(10\.231\.0\.1:3130\)/);
  assert.equal(g[2].log, w.d("state/apply-3.log"));
  assert.deepEqual([g[3].product, g[3].revert_of, g[3].lkg], [w.p1, 3, 2]);
  assert.equal(w.head("prod"), w.p1, "the product is back at the last known good");
  w.revertedTo(w.p1);
  assert.equal(readFileSync(w.d("inst/apps.yaml"), "utf8"), "apps:\n  - name: hello\n", "the app registered since the last known good is kept");
  assert.equal(git(w.d("inst"), "rev-parse", "origin/main"), i2, "the instance's origin/main is not moved");
  const reverted = w.head("inst");
  assert.equal(readFileSync(w.d("prod/data/applied-product"), "utf8").trim(), w.p1);
  assert.match(readFileSync(w.d("state/apply-3.log"), "utf8"), /apply alert: generation 3 failed \(checks that passed .*\) and was reverted to generation 2/);
  // The owner's alert: the monitoring textfile the ApplyFailed rule reads.
  mkdirSync(w.d("data/modules/monitoring/textfile"), { recursive: true });
  execFileSync("bash", [join(repo, "ops/host-metrics.sh")], { env: { PATH: `${w.d("bin")}:/usr/bin:/bin`, HOME: w.d("home"), AIDENHQ_DATA_DIR: w.d("data"), AIDENHQ_STATE_DIR: w.d("state") } });
  assert.match(readFileSync(w.d("data/modules/monitoring/textfile/generations.prom"), "utf8"), /^aidenhq_apply_failed\{n="3",health="failed",.*log=".*apply-3\.log"\} 1$/m);

  // Held: main still resolves to the failed pair, so a plain apply (the runner's) is refused and changes nothing.
  const held = await w.run();
  assert.equal(held.status, 1, held.out);
  assert.match(held.out, /failed its health check as generation 3 .* --force/);
  assert.equal(w.gens().length, 4, "no new generation");
  assert.equal(w.head("prod"), w.p1);
  assert.equal(w.head("inst"), reverted);

  // --force from the owner's shell, with the fault gone: it applies, and the instance is back on main.
  rmSync(w.d("ctrl/break"));
  const retry = await w.run("--force");
  assert.equal(retry.status, 0, retry.out);
  assert.deepEqual(w.gens().at(-1), { ...w.gens().at(-1), product: p2, instance: i2, health: "good" });
  assert.equal(w.head("prod"), p2);
  assert.equal(git(w.d("inst"), "symbolic-ref", "--short", "HEAD"), "main");
});

// A failed auto-revert writes its own log: when the revert's switch fails, its generation names the file that holds the
// failing step's output, not the log of the generation it reverted.
test("a failed auto-revert records its own log naming the step that failed", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  writeFileSync(w.d("ctrl/break"), "");
  writeFileSync(w.d("ctrl/arm-badrevert"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  const i2 = w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens();
  assert.deepEqual(g.map((x) => [x.n, x.health]), [[1, "good"], [2, "good"], [3, "failed"], [4, "failed"]]);
  assert.deepEqual([g[3].product, g[3].revert_of, g[3].lkg], [w.p1, 3, 2]);
  assert.equal(g[2].log, w.d("state/apply-3.log"), "the failed generation keeps its own log");
  assert.equal(g[3].log, w.d("state/apply-4.log"), "the failed revert names its own log");
  const revert = readFileSync(g[3].log, "utf8");
  assert.match(revert, /generation 4: re-applying generation 2/);
  assert.match(revert, /compose: recreate failed in the revert/);
  assert.match(revert, /generation 4 failed: the switch failed \(exit 1\)/);
  assert.equal(w.head("prod"), w.p1, "the product is back at the last known good");
  w.revertedTo(w.p1);

  // The failed pair is still held.
  const held = await w.run();
  assert.equal(held.status, 1, held.out);
  assert.match(held.out, /failed its health check as generation 3 .* --force/);
  assert.equal(w.gens().length, 4, "no new generation");
});

test("a module whose data migrates (marker 0 -> 1) and fails health comes back at marker 0 with its old files, on the LKG code; ops/rollback.sh puts it back later", async () => {
  const w = world();
  const acme = (f) => readFileSync(w.d("prod/data/modules/acme", f), "utf8");
  mkdirSync(w.d("prod/data/modules/acme/state"), { recursive: true });
  writeFileSync(w.d("prod/data/modules/acme/state/db.txt"), "v0 rows\n");
  const first = await w.run();
  assert.equal(first.status, 0, first.out);
  assert.equal(acme(".data_version"), "0\n");
  assert.match(first.out, /generation 2 snapshot: acme \(.*\) in .*\/checkpoints\/gen-2\/acme\.tar/);

  // Generation 3 migrates acme to 1, then fails its health check: the auto-revert puts the data back before p1 starts.
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "", DATA_VERSION: "1\n" });
  w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /generation 3 snapshot: acme/);
  assert.match(r.out, /auto-revert: acme's data is back to/);
  assert.ok(r.out.indexOf("auto-revert: acme") < r.out.indexOf("re-applying generation 2"), r.out);
  assert.equal(acme(".data_version"), "0\n");
  assert.equal(acme("state/db.txt"), "v0 rows\n");
  assert.equal(w.head("prod"), w.p1);
  assert.deepEqual(w.gens().map((g) => [g.n, g.health, g.data_versions?.acme]), [[1, "good", undefined], [2, "good", 0], [3, "failed", 1], [4, "good", 0]]);

  // Fixed and retried, it migrates for good; a rollback to generation 2 restores acme from the first snapshot after it.
  rmSync(w.d("ctrl/break"));
  assert.equal((await w.run("--force")).status, 0);
  assert.equal(acme(".data_version"), "1\n");
  assert.equal(acme("state/db.txt"), "v0 rows\nv1 migrated\n");
  const plan = await w.sh("ops/rollback.sh", "2", "--plan");
  assert.equal(plan.status, 0, plan.out);
  assert.match(plan.out, new RegExp(`generation 2: product ${w.p1}, instance ${w.i1}\n  acme: data back to \\S+ \\(the snapshot before generation 3\\)`));
  const back = await w.sh("ops/rollback.sh", "2");
  assert.equal(back.status, 0, back.out);
  assert.equal(acme(".data_version"), "0\n");
  assert.equal(acme("state/db.txt"), "v0 rows\n");
  assert.equal(w.head("prod"), w.p1);
  assert.equal((await w.sh("ops/rollback.sh", "2", "--plan")).out.split("\n")[1], "  no module data to restore");

  // A pruned snapshot refuses: every snapshot after generation 2 that holds acme is gone.
  for (const g of ["gen-3", "gen-5"]) rmSync(w.d("home/checkpoints", g), { recursive: true });
  writeFileSync(w.d("prod/data/modules/acme/.data_version"), "1\n");
  const refused = await w.sh("ops/rollback.sh", "2");
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /refusing: acme: data newer than generation 2 declared, and no snapshot taken after it is kept/);
});

const until = async (ok, ms = 20000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

/** Applies p2 and kills it mid-compose: the whole process group with SIGKILL (no trap runs, nothing is left holding the lock). */
async function killedMidCompose(w) {
  assert.equal((await w.run()).status, 0);
  const p2 = w.commitProduct("2");
  const i2 = w.commitInstance(p2);
  writeFileSync(w.d("ctrl/block"), "");
  const { child, done } = w.start();
  await until(() => existsSync(w.d("ctrl/blocked")));
  process.kill(-child.pid, "SIGKILL");
  await done;
  rmSync(w.d("ctrl/block"));
  assert.deepEqual(w.gens().map((g) => [g.n, g.health]), [[1, "good"], [2, "good"], [3, "pending"]]);
  assert.equal(w.head("prod"), p2, "the checkout sits on the new product, half switched");
  return { p2, i2 };
}

const reverted = (w) => {
  const g = w.gens();
  assert.deepEqual(g.map((x) => [x.n, x.health]), [[1, "good"], [2, "good"], [3, "failed"], [4, "good"]]);
  assert.equal(g[2].reason, "the apply died mid-run");
  assert.ok(g[2].recovered_at);
  assert.deepEqual([g[3].product, g[3].revert_of, g[3].lkg], [w.p1, 3, 2]);
  assert.equal(w.head("prod"), w.p1);
  w.revertedTo(w.p1);
  assert.equal(readFileSync(w.d("prod/data/applied-product"), "utf8").trim(), w.p1);
  assert.match(readFileSync(w.d("state/apply-3.log"), "utf8"), /generation 3: the apply died mid-run, and no apply is finishing it: reverting[\s\S]*apply alert: generation 3 failed \(the apply died mid-run\) and was reverted to generation 2/);
  assert.match(readFileSync(w.d("state/apply-4.log"), "utf8"), /generation 4: re-applying generation 2[\s\S]*compose: recreated what moved[\s\S]*generation 4 is good/);
};

test("an apply SIGKILLed mid-compose is reverted to the last known good by the next apply, which then holds the dead pair", async () => {
  const w = world();
  const { p2, i2 } = await killedMidCompose(w);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  reverted(w);
  assert.match(r.out, /reverted to generation 2/);
  assert.match(r.out, /refusing: product .* failed its health check as generation 3 .* --force/);
  const retry = await w.run("--force");
  assert.equal(retry.status, 0, retry.out);
  assert.deepEqual([w.gens().at(-1).product, w.gens().at(-1).instance, w.gens().at(-1).health], [p2, i2, "good"]);
});

test("at boot, --recover finishes a dead apply and applies nothing else; with nothing dead it does nothing", async () => {
  const w = world();
  await killedMidCompose(w);
  const r = await w.run("--recover");
  assert.equal(r.status, 0, r.out);
  reverted(w);
  const again = await w.run("--recover");
  assert.equal(again.status, 0, again.out);
  assert.equal(w.gens().length, 4, "nothing more ran");
});

test("an apply whose shell is killed mid-compose (SIGTERM) reverts itself on the way out", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  w.commitInstance(w.commitProduct("2"));
  writeFileSync(w.d("ctrl/block"), "");
  const { child, done } = w.start();
  await until(() => existsSync(w.d("ctrl/blocked")));
  child.kill("SIGTERM");
  writeFileSync(w.d("ctrl/release"), "");
  const r = await done;
  assert.notEqual(r.code, 0, r.out);
  reverted(w);
});

// The switch-over from the retired GitHub App's helper (#1104): while the org's OAuth App restriction keeps the owner's token
// from the instance repo, the new script stops after the hand-over and puts both checkouts back where the running generation
// has them; once GitHub lets the token read the repo, the next apply switches the helper and goes on.
test("the switch-over off the App helper waits, checkouts put back, until the sign-in can read the instance repo", async () => {
  const w = world();
  const work = readFileSync(join(repo, "ops/apply-config-work.sh"), "utf8");
  // The script before #1104 had no helper step: the App helper was the instance checkout's own.
  const old = work.replace(/  # The instance checkout fetches with the owner's GitHub sign-in[\s\S]*?(?=  progress_line APPLY_PHASES instance\n)/, "");
  assert.ok(old !== work && !old.includes("have_helper"), "the old script has no helper step");
  const p1 = w.commitProduct("1", { "ops/apply-config-work.sh": old });
  const i1 = w.commitInstance(p1);
  assert.equal((await w.run()).status, 0);
  const helpers = () => git(w.d("inst"), "config", "--local", "--get-all", "credential.helper");
  git(w.d("inst"), "config", "--add", "credential.helper", "");
  git(w.d("inst"), "config", "--add", "credential.helper", "!node /retired/ops/git-credential-app.mjs");
  const p2 = w.commitProduct("2", { "ops/apply-config-work.sh": work, "ops/git-credential-github.mjs": readFileSync(join(repo, "ops/git-credential-github.mjs"), "utf8") });
  w.commitInstance(p2);
  let readable = false;
  const api = createServer((_q, res) => void res.writeHead(readable ? 200 : 403, { "content-type": "application/json" }).end(JSON.stringify({ message: "the `acme` organization has enabled OAuth App access restrictions" })));
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  mkdirSync(w.d("secrets/modules/github"), { recursive: true });
  writeFileSync(w.d("secrets/modules/github/token.json"), JSON.stringify({ access_token: "gho_x", client_id: "Ov23test" }));
  writeFileSync(w.d("prod/.env"), `AIDENHQ_INSTANCE_REPO=acme/inst\nAIDENHQ_SECRETS_DIR=${w.d("secrets")}\nAIDENHQ_GITHUB_API=http://127.0.0.1:${(api.address() as AddressInfo).port}\nAIDENHQ_KERNEL_BACKPLANE=127.0.0.1:9\n`);
  try {
    const stopped = await w.run();
    assert.equal(stopped.status, 1, stopped.out);
    assert.match(stopped.out, /apply stopped: The acme organization restricts OAuth apps.*settings\/connections\/applications\/Ov23test/, stopped.out);
    assert.deepEqual([w.head("prod"), w.head("inst")], [p1, i1], "both checkouts back where the running generation has them");
    assert.match(helpers(), /git-credential-app\.mjs/, "the App helper stays");
    readable = true;
    const r = await w.run();
    assert.equal(r.status, 0, r.out);
    assert.equal(w.gens().at(-1).product, p2);
    assert.match(helpers(), /git-credential-github\.mjs$/);
  } finally { api.close(); }
});
});

// The host-metrics timer runs the script of the checkout the apply applied, not the one ops/setup.sh recorded at install
// time: the unit's last EnvironmentFile= (written every apply) names the applied checkout, and systemd reads it after
// ~/.config/aidenhq-checkout.env.
const OLD_HOST_METRICS_UNIT = `[Unit]
Description=AidenHQ host metrics for the monitoring module: unit and container states as node-exporter textfiles (ops/host-metrics.sh)

[Service]
# The product checkout: ~/aidenhq, or where ops/setup.sh recorded it (~/.config/aidenhq-checkout.env).
Environment=AIDENHQ_DIR=%h/aidenhq
EnvironmentFile=-%h/.config/aidenhq-checkout.env
Type=oneshot
ExecStart=/usr/bin/env bash \${AIDENHQ_DIR}/ops/host-metrics.sh
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
`;

// What systemd does with the unit's environment: Environment= first, then each EnvironmentFile= in order (a later one
// wins), then expand ${AIDENHQ_DIR} in ExecStart.
function hostMetricsScript(unit, home) {
  const env = {};
  for (const line of readFileSync(unit, "utf8").split("\n")) {
    const m = /^(Environment|EnvironmentFile)=(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].replaceAll("%h", home);
    if (m[1] === "Environment") {
      for (const kv of value.split(/\s+/)) { const [k, ...v] = kv.split("="); env[k] = v.join("="); }
    } else {
      const file = value.replace(/^-/, "");
      if (!existsSync(file)) continue;
      for (const l of readFileSync(file, "utf8").split("\n")) {
        if (!l || l.startsWith("#")) continue;
        const [k, ...v] = l.split("="); env[k] = v.join("=");
      }
    }
  }
  const exec = /^ExecStart=(.*)$/m.exec(readFileSync(unit, "utf8"))[1];
  return exec.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? "").split(/\s+/).at(-1);
}

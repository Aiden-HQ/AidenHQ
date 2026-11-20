// The host apply-atomic.test.ts and apply-atomic-recover.test.ts run an apply on. The apply as one generation (spec §5.7.2): validate before anything restarts, snapshot the touched modules' data (§6.4.1),
// health after the switch, one auto-revert to the last known good with that data put back, the failed pair held off until
// main moves, and ops/rollback.sh restoring the data an older generation needs. Each test builds a product and an instance repo
// (local bare origins) whose product carries the real apply scripts and fakes for everything they call: compile, the
// health check, compose, the units. `docker` (its `run` executes the container's command on the host, volumes mapped),
// `systemctl`, `systemd-run`, `curl`, `df` and `npm` are fakes on PATH, HOME and the
// generations' state dir are temporary, so nothing here reaches a real host. Linux only, like the apply lock it runs under
// (/proc, flock, stat -c): CI's runners.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REAL = ["ops/apply-config.sh", "ops/apply-config-work.sh", "ops/host-metrics.sh", "ops/lib/apply-lock.sh", "ops/lib/generations.sh", "ops/lib/progress.sh", "ops/rollback.sh", "scripts/compiler/data-version.ts"];

const exe = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, 0o755); };
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();

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
  (inst.includes("monitoring") ? "services:\\n  monitoring-node-exporter:\\n    image: x\\n" : "services: {}\\n") + "# " + v);
const dv = fs.existsSync("DATA_VERSION") ? Number(fs.readFileSync("DATA_VERSION", "utf8")) : 0;
fs.writeFileSync(out + "/module-data.json", JSON.stringify({ acme: { data_version: dv, services: "s" } }));
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
  docker: `#!/usr/bin/env bash\nprintf 'docker %s\\n' "$*" >> "$CALLS"\n[ "$1" = run ] && exec node "$(dirname "$0")/docker-run.mjs" "\${@:2}"\ncase "$*" in *"config -q"*) grep -q badcompose compose.modules.next.yaml && exit 1 ;; esac\nexit 0\n`,
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
  systemctl: `#!/usr/bin/env bash\nprintf 'systemctl %s\\n' "$*" >> "$CALLS"\ncase "$*" in *is-enabled*) exit 1 ;; esac\nexit 0\n`,
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
export function world() {
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
  for (const u of ["aidenhq-kernel.service", "aidenhq-apply-recover.service", "aidenhq-backup.service", "aidenhq-backup.timer", "aidenhq-host-metrics.service", "aidenhq-host-metrics.timer"]) {
    mkdirSync(d("pw", "ops/units"), { recursive: true });
    // The host-metrics unit is the product's own: the apply compares the installed copy with it.
    writeFileSync(d("pw", "ops/units", u), u.startsWith("aidenhq-host-metrics.") ? readFileSync(join(repo, "ops/units", u), "utf8") : `[Unit]\nDescription=${u}\n`);
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


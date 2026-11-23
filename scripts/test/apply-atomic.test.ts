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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const NOT_LINUX = process.platform !== "linux" && "needs flock(1), absent on macOS";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REAL = ["ops/apply-config.sh", "ops/apply-config-work.sh", "ops/host-metrics.sh", "ops/lib/apply-lock.sh", "ops/lib/ci-runner-enabled.sh", "ops/lib/generations.sh", "ops/lib/progress.sh", "ops/rollback.sh", "scripts/compiler/data-version.ts", "scripts/imports.ts"];

const exe = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, 0o755); };
/** A product tree from before this change also has no restoreRunnerTemplate: drop the function and both calls, as the real
 * historical script has neither. */
const withoutRunnerRestore = (text) => {
  const start = text.indexOf("restoreRunnerTemplate() {");
  const end = text.indexOf("# Generation n failed (marked so already)", start);
  assert.ok(start > 0 && end > start, "the function is found");
  return text.slice(0, start) + text.slice(end)
    .replace(/^  restoreRunnerTemplate .*\n(?:    .*\n)?/gm, "")
    // The generation path sources the helper before its checkout; a tree without the helper has neither.
    .replace(/^  \. ops\/lib\/ci-runner-enabled\.sh\n/gm, "");
};

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
  // With ctrl/badrestore a module data restore (genRestore's container) fails.
  docker: `#!/usr/bin/env bash\nprintf 'docker %s\\n' "$*" >> "$CALLS"\ncase "$*" in run*.restore-*) [ -f "$CTRL/badrestore" ] && exit 1 ;; esac\n[ "$1" = run ] && exec node "$(dirname "$0")/docker-run.mjs" "\${@:2}"\ncase "$*" in *"config -q"*) grep -q badcompose compose.modules.next.yaml && exit 1 ;; "compose build") [ -f "$CTRL/badbuild" ] && exit 1 ;; *"config --format json"*) printf '{"services":{"svc":{"image":"svc:local","build":{"context":"%s/svc","dockerfile":"Dockerfile"}}}}\\n' "$PWD" ;; esac\nexit 0\n`,
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
  // systemd's shape for the runner template: `list-unit-files` lists only the template, whose state is `indirect` (the
  // preset column says `enabled`, which is not the state), so even `--state=enabled` leaves it out; an enabled instance is
  // an install link in a target's .wants dir (the tests write it) and only `is-enabled` names it. ctrl/runners lists the
  // instance names is-enabled reports enabled; ctrl/masked the ones it reports masked. `show` is what health() reads on a
  // /healthz timeout; journalctl tails the journal.
  systemctl: `#!/usr/bin/env bash\nprintf 'systemctl %s\\n' "$*" >> "$CALLS"\ncase "$*" in\n  *is-enabled*aidenhq-ci-runner@*)\n    for a in "$@"; do unit="$a"; done\n    if [ -f "$CTRL/masked" ] && grep -qxF -- "$unit" "$CTRL/masked"; then echo masked; exit 1; fi
    if [ -f "$CTRL/masked-runtime" ] && grep -qxF -- "$unit" "$CTRL/masked-runtime"; then echo masked-runtime; exit 1; fi\n    [ -f "$CTRL/runners" ] && grep -qxF -- "$unit" "$CTRL/runners"; exit ;;\n  *is-enabled*aidenhq-apply-recover*) exit 0 ;;\n  *is-enabled*) exit 1 ;;\n  *daemon-reload*)\n    [ -f "$CTRL/runner-reload-fails" ] && grep -q ExecStartPre "$HOME/.config/systemd/user/aidenhq-ci-runner@.service" 2>/dev/null && { echo "Failed to reload daemon: Access denied" >&2; exit 1; }\n    [ -f "$CTRL/runner-reload-fails-desc" ] && grep -qF -- "$(cat "$CTRL/runner-reload-fails-desc")" "$HOME/.config/systemd/user/aidenhq-ci-runner@.service" 2>/dev/null && { echo "Failed to reload daemon: Access denied" >&2; exit 1; }\n    [ -f "$CTRL/runner-reload-fails-once-desc" ] && grep -qF -- "$(cat "$CTRL/runner-reload-fails-once-desc")" "$HOME/.config/systemd/user/aidenhq-ci-runner@.service" 2>/dev/null && { rm -f "$CTRL/runner-reload-fails-once-desc"; echo "Failed to reload daemon: Access denied" >&2; exit 1; }\n    exit 0 ;;\n  *"show aidenhq-kernel.service"*)\n    [ -f "$CTRL/no-unit-state" ] && { echo "Failed to connect to bus: No medium found" >&2; exit 1; }\n    [ -f "$CTRL/unit-state-exit" ] && exit "$(cat "$CTRL/unit-state-exit")"\n    printf 'ActiveState=activating\\nResult=exit-code\\nNRestarts=2\\n' ;;\n  *"list-unit-files"*aidenhq-ci-runner@*)\n    case "$*" in *--state=enabled*) ;; *) echo "aidenhq-ci-runner@.service indirect enabled" ;; esac\n    exit 0 ;;\n  *list-unit-files*) exit 0 ;; esac\nexit 0\n`,
  // The user unit dir systemd loads, where enablement links live: HOME is the world's temporary home.\n  "systemd-analyze": `#!/usr/bin/env bash\nprintf 'systemd-analyze %s\\n' "$*" >> "$CALLS"\ncase "$*" in *--user*unit-paths*) echo "$HOME/.config/systemd/user" ;; esac\nexit 0\n`,
  // The kernel's journal, oldest first as journalctl prints it. ctrl/big-journal prefixes enough routine startup lines to
  // push the error line past the reason's size limit; ctrl/stuck-journal ignores SIGTERM, so only the apply's own bound ends
  // it (the read's inner `timeout -k` would kill it a second later).
  journalctl: `#!/usr/bin/env bash
printf 'journalctl %s\\n' "$*" >> "$CALLS"
[ -e /proc/self/fd/9 ] && echo "journalctl inherited fd 9" >> "$CALLS" || echo "journalctl holds no fd 9" >> "$CALLS"
[ -f "$CTRL/fail-journal" ] && { echo "Failed to open journal: Permission denied" >&2; exit 1; }
[ -f "$CTRL/stuck-journal" ] && { trap '' TERM; sleep 30; exit 124; }
if [ -f "$CTRL/big-journal" ]; then
  for i in $(seq 1 20); do echo "Nov 22 06:19:0$((i % 10)) acme-host aidenhq-kernel[812]: kernel: routine startup line $i $(printf 'x%.0s' $(seq 1 40))"; done
fi
printf 'Nov 22 06:19:31 acme-host aidenhq-kernel[812]: kernel: binding 10.231.0.1:3130\\nNov 22 06:19:41 acme-host aidenhq-kernel[812]: kernel: healthz not ready: EACCES mkdir /srv/aidenhq/data/kernel-scratch\\n'
`,
  "systemd-run": `#!/usr/bin/env bash\nprintf 'systemd-run %s\\n' "$*" >> "$CALLS"\n`,
  // mktemp fails only once a test has dropped ctrl/no-mktemp (the curl fake drops it for ctrl/read-tmp-fails), so the
  // apply's own scratch files before the read still work and only the diagnostic read cannot start.
  mktemp: `#!/usr/bin/env bash
[ -f "$CTRL/no-mktemp" ] && { echo "mktemp: failed to create file: No space left on device" >&2; exit 1; }
exec /usr/bin/mktemp "$@"
`,
  // ctrl/read-tmp-fails drops ctrl/no-mktemp at the first health probe, so only the diagnostic reads (which run after the
  // probe) cannot create their scratch file, not the apply's own earlier mktemp calls.
  curl: `#!/usr/bin/env bash\n[ -f "$CTRL/kernel-down" ] && [ -f "$CTRL/read-tmp-fails" ] && : > "$CTRL/no-mktemp"\n[ -f "$CTRL/kernel-down" ] && exit 7\n[ -f "$CTRL/kernel-hang" ] && exit 28\necho ok\n`,
  // A timeout whose kill cannot land: it waits on a reader stuck past any signal, as one in uninterruptible I/O does, so only
  // the apply's own bound can end the read.
  // ctrl/unkillable-timeout makes the supervisor that bounds a journalctl read unkillable (a timeout loading from a failing
  // disk keeps even SIGKILL pending): the apply must not wait on it after its own deadline, or it blocks exactly as on the
  // read it bounded. Every other call is the real timeout.
  timeout: `#!/usr/bin/env bash
j=0
for a in "$@"; do [ "$a" = journalctl ] && j=1; done
[ "$j" = 1 ] && [ -f "$CTRL/unkillable-timeout" ] && { trap '' TERM HUP INT; while :; do sleep 1; done; }
exec /usr/bin/timeout "$@"
`,
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
  // The user unit dir the fake systemd-analyze names, with the default target the runner tests' `.wants` dir belongs to: a
  // dependency dir of a target that has no unit file is not loaded, so every target they use must exist.
  mkdirSync(d("home", ".config/systemd/user"), { recursive: true });
  for (const t of ["default.target", "timers.target"]) writeFileSync(d("home", ".config/systemd/user", t), `[Unit]\nDescription=${t}\n`);
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
  return { d, p1, i1, commitProduct, commitInstance, run, start, sh, gens, head, revertedTo, env, calls: () => readFileSync(d("calls"), "utf8") };
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

// The runner template the enabled units run is the checkout's, kept in step by the apply: a rollout lands the ExecStartPre
// backoff with the scripts it calls, and an installed copy from another product is replaced (rollback included) rather than
// left calling a helper this checkout may not have. An enabled instance has no unit file: systemd records it only as an
// install link in a target's .wants dir, and list-unit-files lists only the template (as indirect), so the gate must read
// the links. A host with no enabled runner instance keeps the template it has.
test("the CI runner unit template follows the applied checkout, only while runner units are declared", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  // The template an older product installed, plus an instance's own unit file (nothing systemd installs, never touched).
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=old\nExecStart=/usr/bin/env bash ${AIDENHQ_DIR}/ops/ci-runner.sh %i\n");
  writeFileSync(join(units, "aidenhq-ci-runner@1.service"), "[Unit]\n");
  const enable = (name) => {
    symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, `${name}.service`));
    writeFileSync(w.d("ctrl/runners"), `${name}.service\n`);
  };
  const retired = () => rmSync(w.d("ctrl/runners"), { force: true });
  const template = () => readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8");
  const product = readFileSync(join(repo, "ops/units/aidenhq-ci-runner@.service"), "utf8");
  const old = () => writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=old\n");

  // Only the template in list-unit-files (as `indirect enabled`, which --state=enabled filters out) and an install link:
  // the old gate saw neither and never installed the template, so this fails on main and passes here.
  enable("aidenhq-ci-runner@3");
  let r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.equal(template(), product, "an enabled instance's install link makes the apply install the template");
  assert.match(template(), /ops\/ci-runner-backoff\.sh %i/, "and it carries the ExecStartPre backoff");
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@1.service"), "utf8"), "[Unit]\n", "the instance's own unit is untouched");
  // The data dir the unit's scripts resolve (they read no .env themselves) comes from this env file, which the apply writes
  // from the host's settings; the template reads it last, so it wins.
  assert.match(template(), /EnvironmentFile=-%h\/\.config\/aidenhq-ci-runner\.env/, "the template reads the per-apply data dir");
  assert.match(readFileSync(w.d("home/.config/aidenhq-ci-runner.env"), "utf8"), /^AIDENHQ_DATA_DIR=\/.*\/data$/m, "an absolute data dir, from the apply's .env");
  // Nothing changed: no rewrite, no reload. The second apply's template copy and reload are already recorded (the first
  // apply wrote the stamp), so this one skips both.
  assert.match(readFileSync(w.d("state/ci-runner-template.reloaded"), "utf8").trim(), /^[0-9a-f]{40}$/, "the loaded template's sha is recorded");
  const before = w.calls();
  const unchanged = await w.run("--force");
  assert.equal(unchanged.status, 0, unchanged.out);
  const seg = w.calls().slice(before.length);
  assert.doesNotMatch(seg, /ci runner unit template installed\/updated/, "an unchanged template is not rewritten");
  assert.doesNotMatch(seg, /daemon-reload/, "and systemd is not reloaded for it");

  // A rerun is forced: a plain rerun of an applied pair returns "already applied" before the switch, so nothing below
  // would exercise the gate at all.
  const again = async () => {
    const r = await w.run("--force");
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.out.includes("already applied"), "the forced rerun reaches the switch");
    return r;
  };
  await again();
  // A masked instance keeps its link but systemd will not start it: it declares no runner.
  writeFileSync(w.d("ctrl/masked"), "aidenhq-ci-runner@3.service\n");
  old();
  await again();
  assert.equal(template(), "[Unit]\nDescription=old\n", "a masked instance's link installs nothing");
  rmSync(w.d("ctrl/masked"));

  // A plain file in .wants is not a link systemd reads.
  rmSync(join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(join(wants, "aidenhq-ci-runner@3.service"), "");
  old();
  await again();
  assert.equal(template(), "[Unit]\nDescription=old\n", "a plain file under .wants is not an enablement link");
  rmSync(join(wants, "aidenhq-ci-runner@3.service"));

  // Dangling: systemd resolves the dependency by name, so with the template still in a unit dir the link declares the
  // instance even though its destination is gone (is-enabled reads `enabled` on systemd 262 with --root). It installs.
  symlinkSync(join(units, "gone@.service"), join(wants, "aidenhq-ci-runner@4.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@4.service\n");
  const dangling = await again();
  assert.match(dangling.out, /ci runner unit template installed\/updated/, "a link whose name resolves still enables the unit");
  // ...and with no template left in any unit dir, the name resolves nowhere: systemd reads the instance not-found, it
  // declares nothing, and no template is installed.
  rmSync(join(units, "aidenhq-ci-runner@.service"));
  await again();
  assert.ok(!existsSync(join(units, "aidenhq-ci-runner@.service")), "with the template gone the instance's name resolves nowhere");
  old();

  // A disabled instance (its link removed) leaves the template as the operator has it.
  rmSync(join(wants, "aidenhq-ci-runner@4.service"));
  retired();
  old();
  await again();
  assert.equal(template(), "[Unit]\nDescription=old\n", "no enabled runner instance: the apply leaves the template alone");
});

// The gate calls ops/lib/ci-runner-enabled.sh, which a product from before this change does not have. A rollback
// (`--generation`, and the auto-revert that runs it) checks out such a product and then re-runs switchOver in this same
// shell, so the helper must already be loaded: sourcing it after the checkout would abort on a missing file (a failed
// source under errexit) and the rollback would never land. That ordering is what this pins; it cannot be observed end to
// end without building a pre-change product, which would itself need the old script.
test("the runner helper is loaded before any checkout, so a rollback to a product without it still applies", () => {
  const text = readFileSync(join(repo, "ops/apply-config-work.sh"), "utf8");
  const main = text.slice(text.indexOf("\nmain() {"), text.indexOf("\n# Step 3:", text.indexOf("\nmain() {")));
  const source = main.indexOf(". ops/lib/ci-runner-enabled.sh");
  const checkout = main.indexOf("git checkout");
  assert.ok(source > 0, "main() loads the runner helper");
  assert.ok(checkout > 0, "main() checks out the product");
  assert.ok(source < checkout, "and does so before the checkout");
});

// A pin rollback ("revert the pin and apply") also reaches the hand-over: an older product that predates the helper but
// supports AIDENHQ_APPLY_BEFORE would be re-exec'd, and its list-unit-files gate never fires, so the newer template would
// stay installed and the next runner start would name an ExecStartPre script that product removed. The hand-over is
// therefore guarded on the target carrying the helper.
test("the apply hand-over requires the target to carry the runner helper", () => {
  const text = readFileSync(join(repo, "ops/apply-config-work.sh"), "utf8");
  const line = text.split("\n").find((l) => l.includes("git diff --quiet \"$before\" \"$product\" -- ops/apply-config.sh"));
  assert.ok(line, "the hand-over list is found");
  assert.ok(line.includes("ops/lib/ci-runner-enabled.sh"), "the helper is in it, so a change to it alone hands over");
  assert.ok(line.includes("ops/apply-config-work.sh"), "this script is still in it, so its own change hands over");
  const guard = text.split("\n").find((l) => l.includes("git cat-file -e \"$product:ops/lib/ci-runner-enabled.sh\""));
  assert.ok(guard, "and the hand-over is guarded on the target having the helper");
});

// A pin rollback ("revert the pin and apply") reaches the hand-over with this script still running: the product checked
// out is the older one, whose own apply-config-work.sh differs, so without a guard it would be re-exec'd — and a product
// from before the helper gates with list-unit-files, which never fires, leaving the newer runner template installed and
// the next start naming an ExecStartPre script that product may not have. The hand-over therefore requires the target to
// carry the helper; an older product stays in this apply, which installs its own template.
test("a pin rollback to a product without the runner helper runs this apply, not the older worker", async () => {
  const w = world();
  const script = w.d("pw/ops/apply-config-work.sh");
  const current = readFileSync(join(repo, "ops/apply-config-work.sh"), "utf8");
  const templateFile = w.d("pw/ops/units/aidenhq-ci-runner@.service");
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  // An enabled runner instance, as `systemctl --user enable` leaves one.
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");

  // P2: the product from before the helper, with its own template.
  const old = withoutRunnerRestore(current
    .replace("  . ops/lib/ci-runner-enabled.sh\n", "")
    .replace('  if [ -n "$(ci_runner_enabled_units)" ]; then', "  if systemctl --user list-unit-files --state=enabled --plain --no-legend 'aidenhq-ci-runner@*' 2>/dev/null | grep -q '^aidenhq-ci-runner@'; then"));
  assert.ok(!old.includes(". ops/lib/ci-runner-enabled.sh"), "the old product does not source the helper");
  assert.ok(old.includes("list-unit-files --state=enabled"), "and gates with the dead list-unit-files form");
  assert.notEqual(old, current, "and its script differs from this product's");
  writeFileSync(script, old);
  rmSync(w.d("pw/ops/lib/ci-runner-enabled.sh"));
  writeFileSync(templateFile, "[Unit]\nDescription=p2\n");
  const p2 = w.commitProduct("2");
  w.commitInstance(p2);
  // P3: this change, with a newer template.
  writeFileSync(script, current);
  writeFileSync(w.d("pw/ops/lib/ci-runner-enabled.sh"), readFileSync(join(repo, "ops/lib/ci-runner-enabled.sh"), "utf8"));
  writeFileSync(templateFile, "[Unit]\nDescription=p3\n");
  const p3 = w.commitProduct("3");
  w.commitInstance(p3);
  // The host runs P3 with its template installed.
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=p3\n");
  assert.equal((await w.run("--force")).status, 0);

  // The pin rollback: the instance's main goes back to P2, and an apply runs from the P3 checkout.
  w.commitInstance(p2);
  const rolled = await w.run();
  assert.equal(rolled.status, 0, rolled.out);
  assert.equal(git(w.d("prod"), "rev-parse", "HEAD"), p2, "P2 is what runs");
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), "[Unit]\nDescription=p2\n", "P2's own template is installed, not left at P3's");
});

// A pin rollback that fails its health check is re-applied by the generation's own product, and that product may predate
// the runner helper: its gate then reads list-unit-files (never true on a live host) and leaves the failed generation's
// template installed, on the units it is bringing back and whose ExecStartPre may name a script it doesn't have. The auto-
// revert puts the template of the generation it returns to back before that child runs, so a rollback that fails ends up
// with the template of the product the host actually stays on.
test("a failed pin rollback to a product without the runner helper puts that product's template back", async () => {
  const w = world();
  const script = w.d("pw/ops/apply-config-work.sh");
  const current = readFileSync(join(repo, "ops/apply-config-work.sh"), "utf8");
  const templateFile = w.d("pw/ops/units/aidenhq-ci-runner@.service");
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");

  // P2: the product from before the helper, with its own template, and a health check that fails.
  const old = withoutRunnerRestore(current
    .replace("  . ops/lib/ci-runner-enabled.sh\n", "")
    .replace('  if [ -n "$(ci_runner_enabled_units)" ]; then', "  if systemctl --user list-unit-files --state=enabled --plain --no-legend 'aidenhq-ci-runner@*' 2>/dev/null | grep -q '^aidenhq-ci-runner@'; then"));
  assert.ok(!old.includes(". ops/lib/ci-runner-enabled.sh"), "the old product does not source the helper");
  assert.ok(old.includes("list-unit-files --state=enabled"), "and gates with the dead list-unit-files form");
  writeFileSync(script, old);
  rmSync(w.d("pw/ops/lib/ci-runner-enabled.sh"));
  writeFileSync(templateFile, "[Unit]\nDescription=p2\nExecStartPre=/bin/true\n");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  w.commitInstance(p2);
  // P3: this change, healthy, with a newer template.
  writeFileSync(script, current);
  writeFileSync(w.d("pw/ops/lib/ci-runner-enabled.sh"), readFileSync(join(repo, "ops/lib/ci-runner-enabled.sh"), "utf8"));
  writeFileSync(templateFile, "[Unit]\nDescription=p3\n");
  const p3 = w.commitProduct("3", {}, ["BAD_HEALTH"]);
  w.commitInstance(p3);
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=p3\n");
  assert.equal((await w.run("--force")).status, 0);

  // The pin goes back to P2 and that apply fails its health check, so the auto-revert returns to the P3 generation.
  writeFileSync(w.d("ctrl/break"), "");
  w.commitInstance(p2);
  const rolled = await w.run();
  assert.equal(rolled.status, 1, rolled.out);
  const g = w.gens();
  assert.equal(g[2].health, "failed");
  assert.match(g[2].reason, /checks that passed before the apply fail now/);
  assert.equal(g[3].revert_of, 3, "the failed pin rollback was reverted");
  assert.equal(w.head("prod"), g[3].product, "the product is back at the last known good");
  // The failing worker put P3's template back before starting the revert, because the re-applied generation's own script
  // predates the restore: P2's ExecStartPre is not left on units that P3's scripts don't serve. A revert whose template
  // cannot be put back (a failed reload here) is not reported as a good revert.
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), "[Unit]\nDescription=p3\n", "the template is the one the hosted product carries, not P2's");
});

// A revert's own line is recorded good only by the parent, after it has seen the template systemd ends with: the child that
// re-applies the last known good leaves the line pending when the parent asked it to verify (AIDENHQ_REVERT_VERIFY), so an
// apply that dies between the two is found unsettled by the next one rather than read as a good revert.
test("a revert whose parent asked to verify leaves its generation pending", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  const shipped = readFileSync(join(repo, "ops/units/aidenhq-ci-runner@.service"), "utf8");
  mkdirSync(wants, { recursive: true });
  // The install link points at the unit-dir template, which must exist for the name to resolve (an enabled instance).
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=old\n");
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  // The world starts with P1 already applied (data/applied-product), so apply it again: the template is what this switch installs.
  const first = await w.run("--force");
  assert.equal(first.status, 0, first.out);
  const good = w.gens().at(-1);
  assert.equal(good.health, "good");
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), shipped, "the switch installed P1's template");
  // The parent's child: the same re-apply, told to leave the verdict to the parent.
  // The work script is the locked entry point's body: hand it fd 9 on data/apply.lock as ops/apply-config.sh does.
  const child = await new Promise<{ status: number; out: string }>((resolve) => {
    execFile("bash", ["-c", `exec 9>>data/apply.lock; flock 9; exec bash ops/apply-config-work.sh --generation ${good.n}`],
      { cwd: w.d("prod"), env: { ...w.env(), AIDENHQ_APPLY_LOCKED: "1", AIDENHQ_REVERT_VERIFY: "1", AIDENHQ_REVERT_OF: String(good.n) } },
      (error, stdout, stderr) => resolve({ status: error ? (error.code as number) : 0, out: `${stdout}${stderr}` }));
  });
  assert.equal(child.status, 0, child.out);
  const revert = w.gens().at(-1);
  assert.notEqual(revert.n, good.n, "the child recorded its own generation");
  assert.equal(revert.health, "pending", "not good until the parent checks the template");
  assert.equal(revert.revert_of, good.n);
  assert.match(child.out, /the revert's template check decides it/);
  // The template is that generation's, so the parent's check would have passed it: nothing here rewrote it.
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), shipped);
});

// The revert's restore follows the same decision as a normal install: a host that has disabled every runner instance
// keeps its template as it is. Without that gate the revert would rewrite a template no enablement points at (one the
// operator customized, say) on an apply that failed for an unrelated reason.
test("a failed apply on a host with no enabled runner instance does not rewrite the template", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=custom\n");
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens();
  assert.equal(g[1].health, "failed", "the generation failed");
  assert.equal(g[2].revert_of, 2, "and was reverted to the last known good");
  assert.equal(w.head("prod"), g[2].product, "the product is back at the last known good");
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), "[Unit]\nDescription=custom\n", "the operator's template is untouched by the failed apply and its revert");
});

// A masked instance keeps its install link (that is what `systemctl --user mask` leaves) but will not start. The revert's
// restore must read that mask like the normal install does, or it would write a plain file over the operator's /dev/null
// mask and silently unmask the runner.
test("a failed revert does not unmask a masked runner instance", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  writeFileSync(w.d("ctrl/masked"), "aidenhq-ci-runner@3.service\n");
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.equal(w.gens()[1].health, "failed");
  // The instance is masked: nothing counts as enabled, so the template is exactly as the host had it (absent here).
  assert.ok(!existsSync(join(units, "aidenhq-ci-runner@.service")), "a masked runner never makes the revert write a template");
});

// A host whose installed template is a symlink to a file since removed: `cp` refuses to write through a dangling link, so
// the install removes it first rather than failing an apply that only means to put its own template in place. The runner
// resolves here through its own instance unit file, so the gate is on and the copy runs.
test("a dangling template symlink in the unit dir does not fail the install", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  symlinkSync(join(units, "gone@.service"), join(units, "aidenhq-ci-runner@.service"));
  writeFileSync(join(units, "aidenhq-ci-runner@3.service"), "[Unit]\nDescription=instance\n");
  symlinkSync(join(units, "aidenhq-ci-runner@3.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ci runner unit template installed\/updated/);
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), readFileSync(join(repo, "ops/units/aidenhq-ci-runner@.service"), "utf8"), "the dangling symlink is replaced by the product's template");
  assert.ok(!existsSync(join(units, ".aidenhq-ci-runner@.service.tmp")), "the replacement left no temp file");
});

// `mv` treats a directory destination as "move inside": a template path that is a directory would take the temp file and
// report success, and the switch would reload systemd and record a template that was never installed. The rename is exact
// (-T), so the install fails the switch instead. The runner is enabled through its own instance unit file (a directory named
// after the template resolves nothing), which is the only way this path is reached.
test("a template path that is a directory fails the install instead of swallowing the copy", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@3.service"), "[Unit]\nDescription=instance\n");
  symlinkSync(join(units, "aidenhq-ci-runner@3.service"), join(wants, "aidenhq-ci-runner@3.service"));
  mkdirSync(join(units, "aidenhq-ci-runner@.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ci runner unit template: could not be written to/, "the install reported the failed write");
  assert.deepEqual(readdirSync(join(units, "aidenhq-ci-runner@.service")), [], "nothing was moved into the directory");
  assert.ok(!readdirSync(units).some((n) => n.startsWith(".aidenhq-ci-runner@.service.")), "the staging file is cleaned up");
  assert.ok(!existsSync(w.d("state/ci-runner-template.reloaded")), "and no loaded template was recorded");
});

// The operator masks the template itself (`systemctl --user mask aidenhq-ci-runner@`, a /dev/null link on the template) while
// an instance has a unit file of its own: that instance is enabled, so the gate is on, but the mask is still their decision.
// Writing the template over /dev/null would let every retained install link start again.
test("an apply never writes over a masked runner template", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@3.service"), "[Unit]\nDescription=instance\n");
  symlinkSync(join(units, "aidenhq-ci-runner@3.service"), join(wants, "aidenhq-ci-runner@3.service"));
  symlinkSync("/dev/null", join(units, "aidenhq-ci-runner@.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ci runner unit template is masked: left as it is/);
  assert.equal(readlinkSync(join(units, "aidenhq-ci-runner@.service")), "/dev/null", "the mask is kept");
});

// systemd reads a zero-length unit file as masked too, not only a /dev/null link. The installer must keep that mask: writing
// over it would let every retained install link start again.
test("an empty-file mask on the runner template is kept", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@3.service"), "[Unit]\nDescription=instance\n");
  symlinkSync(join(units, "aidenhq-ci-runner@3.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "");
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ci runner unit template is masked: left as it is/);
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), "", "the empty mask is kept");
});

// A runtime mask (`systemctl --user mask --runtime`) lives outside the install dir and hides the template there after a
// reload: writing our file into this dir would shadow it, so the template is left alone while that mask is in effect.
test("a runtime-masked runner template is left alone", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=operator\n");
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  writeFileSync(w.d("ctrl/masked-runtime"), "aidenhq-ci-runner@.service\n");
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ci runner unit template is masked: left as it is/);
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), "[Unit]\nDescription=operator\n", "the runtime mask is not shadowed");
});

// A copied runner template systemd never reloaded is not what runs: a failed daemon-reload fails the switch, so the
// generation is not marked good (the `cp && systemctl && echo` form would swallow it under errexit). And the copy must not
// look installed to the next apply: the file already matches, so without the reload stamp `cmp` alone would skip the
// reload forever and systemd would keep the old template.
test("a failed runner daemon-reload fails the switch instead of marking the generation good", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=old\n");
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  writeFileSync(w.d("ctrl/runner-reload-fails"), "");
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ci runner unit template: daemon-reload or its reload stamp failed/);
  assert.match(r.out, /generation 2 failed: the switch failed \(exit 1\)/, "the switch reported the reload failure");
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), readFileSync(join(repo, "ops/units/aidenhq-ci-runner@.service"), "utf8"), "the template was copied");
  assert.ok(!existsSync(w.d("state/ci-runner-template.reloaded")), "a failed reload leaves no stamp");
  // The file now matches, but systemd never loaded it: the next apply forces the reload again.
  rmSync(w.d("ctrl/runner-reload-fails"));
  const retry = await w.run("--force");
  assert.equal(retry.status, 0, retry.out);
  assert.match(retry.out, /ci runner unit template installed\/updated/, "the retry reloads the copied template");
  assert.match(readFileSync(w.d("state/ci-runner-template.reloaded"), "utf8").trim(), /^[0-9a-f]{40}$/, "and then records it");
});

// The stamp can be stale while systemd has the right template: the failed generation's switch reloads for a unit of its own,
// which loads the restored runner template too, then fails. The child's health check passes. The parent must redo the checked
// reload (file already in place) rather than mark a good revert failed.
test("a revert whose stamp is stale but whose template systemd loaded is recorded as good", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  const templateFile = w.d("pw/ops/units/aidenhq-ci-runner@.service");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=p2\nExecStartPre=/bin/true\n");
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  writeFileSync(templateFile, "[Unit]\nDescription=p2\nExecStartPre=/bin/true\n");
  const p2 = w.commitProduct("2");
  w.commitInstance(p2);
  assert.equal((await w.run()).status, 0);
  writeFileSync(templateFile, "[Unit]\nDescription=p3\nExecStartPre=/bin/false\n");
  const p3 = w.commitProduct("3", { BAD_HEALTH: "" });
  w.commitInstance(p3);
  writeFileSync(w.d("ctrl/break"), "");
  writeFileSync(w.d("ctrl/runner-reload-fails-once-desc"), "Description=p2");
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const revert = w.gens().at(-1);
  assert.equal(revert.revert_of, 3);
  assert.equal(revert.health, "good", "the template is the returning generation's");
  assert.match(readFileSync(w.d("state/ci-runner-template.reloaded"), "utf8").trim(), /^[0-9a-f]{40}$/, "a stamp is recorded");
});

// The revert is judged by what systemd has at the end, not by one attempt: a parent restore whose reload failed, retried by
// the returning tree's own switch, is a good revert (no false alarm, and no checkpoint restore the operator does not need).
test("a revert whose template reload is retried by its own switch is recorded as good", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  const templateFile = w.d("pw/ops/units/aidenhq-ci-runner@.service");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=p2\nExecStartPre=/bin/true\n");
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  writeFileSync(templateFile, "[Unit]\nDescription=p2\nExecStartPre=/bin/true\n");
  const p2 = w.commitProduct("2");
  w.commitInstance(p2);
  assert.equal((await w.run()).status, 0);
  writeFileSync(templateFile, "[Unit]\nDescription=p3\nExecStartPre=/bin/false\n");
  const p3 = w.commitProduct("3", { BAD_HEALTH: "" });
  w.commitInstance(p3);
  writeFileSync(w.d("ctrl/break"), "");
  // The apply's own reload of P3's template is fine; putting P2's back fails once, and the revert's switch retries it.
  writeFileSync(w.d("ctrl/runner-reload-fails-once-desc"), "Description=p2");
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const revert = w.gens().at(-1);
  assert.equal(revert.revert_of, 3);
  assert.equal(revert.health, "good", "the returning tree reloaded the template itself, so the revert is good");
  assert.equal(readFileSync(join(units, "aidenhq-ci-runner@.service"), "utf8"), "[Unit]\nDescription=p2\nExecStartPre=/bin/true\n", "and the template is the last known good's");
  assert.doesNotMatch(r.out, /the runner template is still not generation/, "no false alarm");
});

// The last known good predates the helper, so the worker that re-applies it cannot gate or reload the runner template: only
// the parent's restore can put that template back, and if it cannot, the child's switch (that old tree's own) fails the
// revert. The parent must not let it read as good on a health check alone.
test("a revert whose runner template is still not back is not recorded as good", async () => {
  const w = world();
  const script = w.d("pw/ops/apply-config-work.sh");
  const current = readFileSync(join(repo, "ops/apply-config-work.sh"), "utf8");
  const templateFile = w.d("pw/ops/units/aidenhq-ci-runner@.service");
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  // P2: the last known good, from before the helper, with its own runner template.
  const old = withoutRunnerRestore(current
    .replace("  . ops/lib/ci-runner-enabled.sh\n", "")
    .replace('  if [ -n "$(ci_runner_enabled_units)" ]; then', "  if systemctl --user list-unit-files --state=enabled --plain --no-legend 'aidenhq-ci-runner@*' 2>/dev/null | grep -q '^aidenhq-ci-runner@'; then"));
  writeFileSync(script, old);
  rmSync(w.d("pw/ops/lib/ci-runner-enabled.sh"));
  writeFileSync(templateFile, "[Unit]\nDescription=p2\nExecStartPre=/bin/true\n");
  const p2 = w.commitProduct("2");
  w.commitInstance(p2);
  // The host runs P2, with P2's template installed.
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=p2\nExecStartPre=/bin/true\n");
  assert.equal((await w.run("--force")).status, 0);
  // P3: this change, with a newer template and a failing health check.
  writeFileSync(script, current);
  writeFileSync(w.d("pw/ops/lib/ci-runner-enabled.sh"), readFileSync(join(repo, "ops/lib/ci-runner-enabled.sh"), "utf8"));
  writeFileSync(templateFile, "[Unit]\nDescription=p3\nExecStartPre=/bin/false\n");
  const p3 = w.commitProduct("3", { BAD_HEALTH: "" });
  w.commitInstance(p3);

  writeFileSync(w.d("ctrl/break"), "");
  // The runner is enabled through an instance file of its own, and the template path is a directory: the parent's restore
  // (with -T) cannot put P2's template back, and P2's worker never tries. The revert must not read as good then.
  writeFileSync(join(units, "aidenhq-ci-runner@3.service"), "[Unit]\nDescription=instance\n");
  rmSync(join(units, "aidenhq-ci-runner@.service"));
  rmSync(join(wants, "aidenhq-ci-runner@3.service"));
  symlinkSync(join(units, "aidenhq-ci-runner@3.service"), join(wants, "aidenhq-ci-runner@3.service"));
  mkdirSync(join(units, "aidenhq-ci-runner@.service"));
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens();
  assert.equal(g.at(-2).health, "failed", "the failed generation is recorded");
  const revert = g.at(-1);
  assert.equal(revert.revert_of, g.at(-2).n, "the failed apply was reverted");
  assert.equal(revert.health, "failed", "the revert is not recorded as good with no template put back");
  assert.match(r.out, /the revert to generation .* failed too/, "the alert says the revert failed");
});

// A reload whose stamp cannot be written leaves no record of what systemd loaded: the switch fails rather than report the
// template installed, so the next apply reloads again (and a revert is judged by the stamp that exists).
// A template replaced but not yet reloaded is not what systemd has: the stamp from the previous one is dropped before the
// rename, so a kill in between cannot leave a stamp claiming systemd loaded the new file. A later apply reloads it.
test("a replaced template drops the previous reload stamp", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=old\n");
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  // A stamp from some other template the host once loaded.
  mkdirSync(w.d("state"), { recursive: true });
  writeFileSync(w.d("state/ci-runner-template.reloaded"), "0000000000000000000000000000000000000000\n");
  const calls = w.calls().length;
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.match(w.calls().slice(calls), /daemon-reload/, "the reload happened");
  assert.match(readFileSync(w.d("state/ci-runner-template.reloaded"), "utf8").trim(), /^[0-9a-f]{40}$/);
  assert.notEqual(readFileSync(w.d("state/ci-runner-template.reloaded"), "utf8").trim(), "0000000000000000000000000000000000000000", "the stale stamp was replaced");
});

test("a reload stamp that cannot be written fails the switch", async () => {
  const w = world();
  const units = w.d("home/.config/systemd/user");
  const wants = join(units, "default.target.wants");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(units, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=old\n");
  symlinkSync(join(units, "aidenhq-ci-runner@.service"), join(wants, "aidenhq-ci-runner@3.service"));
  writeFileSync(w.d("ctrl/runners"), "aidenhq-ci-runner@3.service\n");
  // The stamp cannot be written: a directory sits where its temporary file goes.
  mkdirSync(join(w.d("state/ci-runner-template.reloaded.tmp")), { recursive: true });
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ci runner unit template: daemon-reload or its reload stamp failed/);
  assert.match(r.out, /generation 2 failed: the switch failed \(exit 1\)/, "the switch reported it");
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

test("an auto-revert whose data restore fails stops there: the older code never starts on that data", async () => {
  const w = world();
  // Module acme's data at data_version 0, then a product that migrates it to 1 and fails its health check.
  mkdirSync(w.d("prod/data/modules/acme/state"), { recursive: true });
  writeFileSync(w.d("prod/data/modules/acme/state/db.txt"), "v0\n");
  assert.equal((await w.run()).status, 0);
  writeFileSync(w.d("ctrl/break"), "");
  writeFileSync(w.d("ctrl/badrestore"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "", DATA_VERSION: "1" });
  w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens();
  assert.deepEqual(g.map((x) => [x.n, x.health]), [[1, "good"], [2, "good"], [3, "failed"]], "no revert generation, nothing marked good");
  assert.ok(g[2].snapshot, "the failed generation took a snapshot");
  assert.equal(w.head("prod"), p2, "the last known good's product was not re-applied");
  assert.equal(readFileSync(w.d("prod/data/applied-product"), "utf8").trim(), p2);
  assert.match(readFileSync(w.d("state/apply-3.log"), "utf8"), /apply alert: generation 3 failed .* putting acme's data back from .* failed, so generation 2 was not re-applied/);
  assert.doesNotMatch(readFileSync(w.d("state/apply-3.log"), "utf8"), /was reverted to generation 2/);
});

// A /healthz timeout names what blocked the kernel: the curl exit (7 = nothing listening, 28 = request timed out) and the
// unit's ActiveState/Result/NRestarts with its journal tail, so an environmental stall reads on the generation itself.
// A first install (no applied-product) fails the generation without reverting, so each case is one apply.
const timedOut = async (w) => {
  rmSync(w.d("prod/data/applied-product"), { force: true });
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens().at(-1);
  assert.equal(g.health, "failed");
  assert.match(readFileSync(g.log, "utf8"), new RegExp(`generation ${g.n} failed: the kernel did not answer`));
  return g;
};

test("a /healthz timeout names the curl exit, the unit's state and its journal tail", async () => {
  const w = world();
  writeFileSync(w.d("ctrl/kernel-down"), "");
  const g = await timedOut(w);
  assert.match(g.reason, /^the kernel did not answer \/healthz within 2s \(curl exit 7: could not connect/);
  assert.match(g.reason, /unit ActiveState=activating Result=exit-code NRestarts=2/);
  assert.match(g.reason, /last journal: .*healthz not ready: EACCES mkdir \/srv\/aidenhq\/data\/kernel-scratch/);
  assert.ok(!g.reason.includes("\n"), "one line");
  assert.match(w.calls(), /systemctl --user show aidenhq-kernel\.service --property=ActiveState,Result,NRestarts/);
  // The unit is named by its field, which the owner's systemd-journal group can read after a full disk, not only by --user.
  assert.match(w.calls(), /journalctl _SYSTEMD_USER_UNIT=aidenhq-kernel\.service _UID=\d+ -n 20 --no-pager -o cat/);

  // 28 is a request timeout, not a claim that anything accepted the connection (a dropped SYN times out the same way).
  const hangs = world();
  writeFileSync(hangs.d("ctrl/kernel-hang"), "");
  const hangReason = (await timedOut(hangs)).reason;
  assert.match(hangReason, /\(curl exit 28: the health request timed out after 5s without an answer;/);
  assert.doesNotMatch(hangReason, /connected/);
});

// The diagnostic never becomes the failure: a systemctl that cannot reach the bus and no journal of its own still leave the
// timeout line, with the two parts marked unavailable.
test("a /healthz timeout still records a reason when the unit state and journal are unavailable", async () => {
  const w = world();
  writeFileSync(w.d("ctrl/kernel-down"), "");
  writeFileSync(w.d("ctrl/no-unit-state"), "");
  writeFileSync(w.d("ctrl/fail-journal"), "");
  const g = await timedOut(w);
  assert.match(g.reason, /^the kernel did not answer \/healthz within 2s \(curl exit 7/);
  assert.match(g.reason, /unit state unavailable, systemctl exit 1/);
  assert.match(g.reason, /last journal empty or unavailable/);
  assert.ok(!g.reason.includes("\n"), "one line");
});

// The reason names what blocked the kernel, and what blocks it is the newest line: a start-up stall prints its error last.
// Reading a bounded amount must keep that end of the journal.
test("a /healthz timeout keeps the newest journal lines when the journal is long", async () => {
  const w = world();
  writeFileSync(w.d("ctrl/kernel-down"), "");
  writeFileSync(w.d("ctrl/big-journal"), "");
  const g = await timedOut(w);
  // health() wraps the diagnostic in "(...)", so the excerpt is everything after "last journal: " up to that ")".
  const excerpt = /; last journal: (.*)\)$/.exec(g.reason)?.[1] ?? "";
  assert.ok(excerpt.length <= 400, `the excerpt is bounded: ${excerpt.length}`);
  // health() frames the diagnostic in "(...)", after the fixed timeout sentence; the diagnostic itself stays within 400.
  assert.ok((g.reason.slice(g.reason.indexOf("(") + 1, -1)).length <= 400, `the diagnostic is bounded: ${g.reason.length}`);
  assert.match(excerpt, /healthz not ready: EACCES mkdir \/srv\/aidenhq\/data\/kernel-scratch/, "the newest line is kept");
  assert.ok(!excerpt.includes("routine startup line 1 "), "the oldest lines give way");
});

// A journal read stalled on storage must not hold the apply lock or delay the rollback: the apply bounds the read itself
// and the timeout reason still records the unit state and says the journal read timed out.
test("a /healthz timeout bounds a stalled journal read and still records the reason", async () => {
  const w = world();
  writeFileSync(w.d("ctrl/kernel-down"), "");
  writeFileSync(w.d("ctrl/stuck-journal"), "");
  const started = Date.now();
  const g = await timedOut(w);
  // The fake ignores SIGTERM, so it outlives timeout's own 5s and only the apply's own bound ends the wait.
  assert.ok(Date.now() - started < 25000, "the bounded read did not wait out the stall");
  assert.match(g.reason, /unit ActiveState=activating Result=exit-code NRestarts=2/);
  assert.match(g.reason, /last journal unavailable, journalctl timed out/);
  // The reader runs with the apply lock's descriptor closed: one that never dies cannot keep the lock from the rollback.
  assert.match(w.calls(), /journalctl holds no fd 9/);
});

// A read that cannot create its scratch file (a full or inode-exhausted /tmp) must fail as that read, not fall through and
// run against an empty name, and the timeout still records the line with that part marked unavailable.
test("a /healthz timeout still records the reason when the diagnostic scratch file cannot be created", async () => {
  const w = world();
  writeFileSync(w.d("ctrl/kernel-down"), "");
  writeFileSync(w.d("ctrl/read-tmp-fails"), "");
  const g = await timedOut(w);
  assert.match(g.reason, /^the kernel did not answer \/healthz within 2s \(curl exit 7/);
  assert.match(g.reason, /unit state unavailable, could not start the read/);
  assert.match(g.reason, /last journal unavailable, could not start the read/);
  assert.ok(!g.reason.includes("\n"), "one line");
});

// A status the apply does not read back from a second file: the command's own exit is what wait returns, so a query that
// succeeds is never reported as its exit code (0 must not become an argument error or a timeout).
test("a /healthz timeout reads the diagnostic command's own exit code", async () => {
  const w = world();
  writeFileSync(w.d("ctrl/kernel-down"), "");
  writeFileSync(w.d("ctrl/unit-state-exit"), "0");
  const g = await timedOut(w);
  assert.match(g.reason, /unit state unavailable, systemctl printed nothing/);
  assert.doesNotMatch(g.reason, /systemctl exit/);
  assert.doesNotMatch(g.reason, /systemctl timed out/);
});

// A supervisor that outlives the deadline must not hold the apply: the read is bounded by the apply's own deadline, the
// reason is recorded, and the apply moves on. (A real SIGKILL that stays pending, as in uninterruptible I/O, cannot be
// staged in a test; the code's guarantee is that the deadline branch neither waits on nor reaps the reader.)
test("a /healthz timeout does not wait for a diagnostic supervisor past the deadline", async () => {
  const w = world();
  writeFileSync(w.d("ctrl/kernel-down"), "");
  writeFileSync(w.d("ctrl/unkillable-timeout"), "");
  const started = Date.now();
  const g = await timedOut(w);
  assert.ok(Date.now() - started < 40000, "the apply did not wait on the supervisor");
  assert.match(g.reason, /^the kernel did not answer \/healthz within 2s \(curl exit 7/);
  assert.match(g.reason, /unit ActiveState=activating Result=exit-code NRestarts=2/);
  assert.match(g.reason, /last journal unavailable, journalctl timed out/);
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
  // The revert's own line is finalized by the parent, after it checks the template systemd ends with: an apply killed
  // between the child's health check and that check leaves it pending, so the next recovery reverts again.
  assert.match(readFileSync(w.d("state/apply-4.log"), "utf8"), /generation 4: re-applying generation 2[\s\S]*compose: recreated what moved[\s\S]*generation 4 passed its health check; the revert's template check decides it/);
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

// ops/apply-config.sh is the host's locked entry point: it opens data/apply.lock at that fixed path, holds it on fd 9
// and execs ops/apply-config-work.sh, which takes no lock of its own. The hand-over marker alone proves nothing, so the
// work script checks the descriptor itself: fd 9 must be data/apply.lock (device and inode) and this process must hold
// its lock. Each test builds a checkout with both scripts in it and a fake `docker` that records every call, so "compose
// never ran" is read from the log rather than inferred.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NOT_LINUX = process.platform !== "linux" && "needs flock(1), absent on macOS";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../../ops/apply-config.sh");
const work = join(here, "../../ops/apply-config-work.sh");
const lockLib = join(here, "../../ops/lib/apply-lock.sh");
const genLib = join(here, "../../ops/lib/generations.sh");

const dirs = [];
const until = async (ok) => { const end = Date.now() + 20000; while (!ok()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A checkout with the apply's scripts, a data dir, and a fake docker that records its calls. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "apply-lock-"));
  dirs.push(dir);
  // kernel/node_modules: the kernel's deps are installed (the apply installs them on a fresh host, apply-atomic.test.ts).
  for (const d of ["ops/lib", "data", "bin", "kernel/node_modules"]) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(entry, join(dir, "ops/apply-config.sh"));
  copyFileSync(work, join(dir, "ops/apply-config-work.sh"));
  copyFileSync(lockLib, join(dir, "ops/lib/apply-lock.sh"));
  copyFileSync(genLib, join(dir, "ops/lib/generations.sh"));
  copyFileSync(join(here, "../../ops/lib/progress.sh"), join(dir, "ops/lib/progress.sh"));
  copyFileSync(join(here, "../../ops/lib/ci-runner-enabled.sh"), join(dir, "ops/lib/ci-runner-enabled.sh"));
  for (const f of ["ops/apply-config.sh", "ops/apply-config-work.sh"]) chmodSync(join(dir, f), 0o755);
  writeFileSync(join(dir, "bin/docker"), "#!/usr/bin/env bash\nprintf 'docker %s\\n' \"$*\" >> \"$DOCKER_LOG\"\nexit 0\n");
  chmodSync(join(dir, "bin/docker"), 0o755);
  return dir;
}

/** Runs a shell snippet with the checkout's fake docker first on PATH, and returns its output and exit code. The env is
 * built from scratch, HOME and the state dir inside the checkout: these are the real apply scripts, and a run on a host
 * would otherwise read that host's generations and finish its in-flight apply as dead. */
function run(dir, script, { env = {} } = {}) {
  const log = join(dir, "docker.log");
  writeFileSync(log, "");
  let child;
  const done = new Promise((resolve) => {
    child = execFile("bash", ["-c", script], {
      cwd: dir,
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: join(dir, "home"), AIDENHQ_STATE_DIR: join(dir, "state"), DOCKER_LOG: log, AIDENHQ_INSTANCE_DIR: "", ...env },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, docker: readFileSync(log, "utf8") }));
  });
  return Object.assign(done, { child });
}

test("with no marker the entry point takes data/apply.lock at its fixed path and proceeds", { skip: NOT_LINUX }, async () => {
  const dir = checkout();
  // No marker: this is the process that takes the lock. It opens the fixed path onto fd 9 and proceeds, whatever fd 9
  // happened to be before.
  const r = await run(dir, `exec 9>>other.lock; flock 9; bash ops/apply-config.sh`);
  assert.doesNotMatch(r.out, /refusing: data\/apply\.lock/, r.out);
  assert.match(r.out, /AIDENHQ_INSTANCE_DIR/, `it got past the lock:\n${r.out}`);
});

test("a second apply waits for the first, then runs: never refused for being second", { skip: NOT_LINUX }, async () => {
  const dir = checkout();
  // The first apply gets a checkout to work on and a `git` whose first call holds it inside the apply (holding the lock) until
  // the second one is queued on the lock. Both go through the real entry point.
  mkdirSync(join(dir, "inst"), { recursive: true });
  writeFileSync(join(dir, ".env"), `AIDENHQ_INSTANCE_DIR=${join(dir, "inst")}\n`);
  writeFileSync(join(dir, "bin/git"), "#!/usr/bin/env bash\n[ -e \"$0.ran\" ] || { : > \"$0.ran\"; until [ -e \"$0.release\" ]; do sleep 0.05; done; }\nexit 0\n");
  chmodSync(join(dir, "bin/git"), 0o755);
  const first = run(dir, `bash ops/apply-config.sh`).then((r) => ({ ...r, end: Date.now() }));
  await until(() => existsSync(join(dir, "bin/git.ran")));
  const queued = run(dir, `bash ops/apply-config.sh`);
  const second = queued.then((r) => ({ ...r, end: Date.now() }));
  let said = "";
  queued.child.stdout.on("data", (d) => { said += d; });
  await until(() => said.includes("waits its turn")); // it says so just before it blocks on the lock
  writeFileSync(join(dir, "bin/git.release"), "");
  const [a, b] = [await first, await second];
  assert.match(b.out, /another apply is running: this one waits its turn/, b.out);
  assert.doesNotMatch(b.out, /refusing/, b.out);
  // It ran the apply only once the first had let the lock go: with no git wait of its own, it could not end after the first otherwise.
  assert.ok(b.end >= a.end, "the second apply ended before the first: it did not wait");
  assert.match(b.out, /apply timing: instance/, `the second ran the apply:\n${b.out}`);
  assert.match(a.out, /apply timing: instance/, `the holder ran the apply:\n${a.out}`);
});

test("an apply in a test checkout never touches the host's generations, even while the host has one in flight", async () => {
  // 2026-11-20: this file ran on a host mid-apply; the fixture's apply read the host's generations through the inherited
  // HOME, took the pending one for a dead apply and "reverted" it from the fixture (MODULE_NOT_FOUND under /tmp).
  const host = mkdtempSync(join(tmpdir(), "apply-lock-host-"));
  dirs.push(host);
  const gens = join(host, ".local/state/aidenhq/generations.jsonl");
  mkdirSync(dirname(gens), { recursive: true });
  const p = "a".repeat(40), i = "b".repeat(40);
  writeFileSync(gens, `{"n":1,"product":"${p}","instance":"${i}","health":"good"}\n{"n":2,"product":"${p}","instance":"${i}","health":"pending"}\n`);
  const before = readFileSync(gens, "utf8");
  const dir = checkout();
  mkdirSync(join(dir, "inst"));
  writeFileSync(join(dir, ".env"), `AIDENHQ_INSTANCE_DIR=${join(dir, "inst")}\n`);
  writeFileSync(join(dir, "bin/git"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(dir, "bin/git"), 0o755);
  const saved = { HOME: process.env.HOME, AIDENHQ_STATE_DIR: process.env.AIDENHQ_STATE_DIR };
  process.env.HOME = host;
  delete process.env.AIDENHQ_STATE_DIR;
  try {
    // node on PATH, as on a host: the generations are read with it.
    const r = await run(dir, `bash ops/apply-config.sh`, { env: { PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.doesNotMatch(r.out, /no apply is finishing it/, r.out);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  assert.equal(readFileSync(gens, "utf8"), before, "the host's generations are untouched");
});

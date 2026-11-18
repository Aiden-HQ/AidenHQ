// ops/apply-config.sh is the host's locked entry point: it opens data/apply.lock at that fixed path, holds it on fd 9
// and execs ops/apply-config-work.sh, which takes no lock of its own. The hand-over marker alone proves nothing, so the
// work script checks the descriptor itself: fd 9 must be data/apply.lock (device and inode) and this process must hold
// its lock. Each test builds a checkout with both scripts in it and a fake `docker` that records every call, so "compose
// never ran" is read from the log rather than inferred.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../../ops/apply-config.sh");
const work = join(here, "../../ops/apply-config-work.sh");
const lockLib = join(here, "../../ops/lib/apply-lock.sh");
const genLib = join(here, "../../ops/lib/generations.sh");

/** A checkout with the apply's scripts, a data dir, and a fake docker that records its calls. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "apply-lock-"));
  // kernel/node_modules: the kernel's deps are installed (the apply installs them on a fresh host, apply-atomic.test.mjs).
  for (const d of ["ops/lib", "data", "bin", "kernel/node_modules"]) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(entry, join(dir, "ops/apply-config.sh"));
  copyFileSync(work, join(dir, "ops/apply-config-work.sh"));
  copyFileSync(lockLib, join(dir, "ops/lib/apply-lock.sh"));
  copyFileSync(genLib, join(dir, "ops/lib/generations.sh"));
  copyFileSync(join(here, "../../ops/lib/progress.sh"), join(dir, "ops/lib/progress.sh"));
  for (const f of ["ops/apply-config.sh", "ops/apply-config-work.sh"]) chmodSync(join(dir, f), 0o755);
  writeFileSync(join(dir, "bin/docker"), "#!/usr/bin/env bash\nprintf 'docker %s\\n' \"$*\" >> \"$DOCKER_LOG\"\nexit 0\n");
  chmodSync(join(dir, "bin/docker"), 0o755);
  return dir;
}

/** Runs a shell snippet with the checkout's fake docker first on PATH, and returns its output and exit code. */
function run(dir, script, { env = {} } = {}) {
  const log = join(dir, "docker.log");
  writeFileSync(log, "");
  return new Promise((resolve) => {
    execFile("bash", ["-c", script], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, DOCKER_LOG: log, AIDENHQ_INSTANCE_DIR: "", ...env },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, docker: readFileSync(log, "utf8") }));
  });
}

const composeRan = (r) => /docker compose/.test(r.docker);

// The work script's own guard, reached as the entry point reaches it: fd 9 open on some file, the marker set.
const workWith = (fd9) => `
  exec 9>>${fd9}
  export AIDENHQ_APPLY_LOCKED=9
  bash ops/apply-config-work.sh
`;

// The marker is never trusted on its own. fd 9 must be data/apply.lock and this process must hold it, whether or not
// another process holds the real lock: recovering by taking the lock anyway is exactly the hole, because the apply would
// then go on to compose on the strength of a descriptor that was never the lock.
test("a marker over a locked descriptor on another file is refused while data/apply.lock is held elsewhere", async () => {
  const dir = checkout();
  const holder = run(dir, `exec 9>>data/apply.lock; flock 9; sleep 2`);
  await new Promise((r) => setTimeout(r, 200));
  const r = await run(dir, `exec 9>>other.lock; flock 9; export AIDENHQ_APPLY_LOCKED=9; bash ops/apply-config-work.sh`);
  await holder;
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /data\/apply\.lock/, "the refusal names the lock");
  assert.equal(composeRan(r), false, `compose never ran:\n${r.docker}`);
});

test("a marker over a locked descriptor on another file is refused with data/apply.lock free, and the lock is not taken", async () => {
  const dir = checkout();
  // The real lock is free, so taking it here would succeed -- and would be the hole. The apply must refuse instead.
  const r = await run(dir, `exec 9>>other.lock; flock 9; export AIDENHQ_APPLY_LOCKED=9; bash ops/apply-config-work.sh`);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /data\/apply\.lock/, "the refusal names the lock");
  assert.equal(composeRan(r), false, `compose never ran:\n${r.docker}`);
});

test("the entry point refuses a marker over an unrelated locked descriptor instead of taking the real lock", async () => {
  const dir = checkout();
  // The same claim, reaching the entry point: it must not fall through and open data/apply.lock for itself.
  const r = await run(dir, `exec 9>>other.lock; flock 9; export AIDENHQ_APPLY_LOCKED=9; bash ops/apply-config.sh`);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /data\/apply\.lock/);
  assert.equal(composeRan(r), false, `compose never ran:\n${r.docker}`);
});

test("with no marker the entry point takes data/apply.lock at its fixed path and proceeds", async () => {
  const dir = checkout();
  // No marker: this is the process that takes the lock. It opens the fixed path onto fd 9 and proceeds, whatever fd 9
  // happened to be before.
  const r = await run(dir, `exec 9>>other.lock; flock 9; bash ops/apply-config.sh`);
  assert.doesNotMatch(r.out, /refusing: data\/apply\.lock/, r.out);
  assert.match(r.out, /AIDENHQ_INSTANCE_DIR/, `it got past the lock:\n${r.out}`);
});

test("a caller-set marker with no lock held exits naming the lock and runs no compose", async () => {
  const dir = checkout();
  const r = await run(dir, `export AIDENHQ_APPLY_LOCKED=9; bash ops/apply-config-work.sh`);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /data\/apply\.lock/);
  assert.equal(composeRan(r), false, `compose never ran:\n${r.docker}`);
});

test("the entry point takes the lock before .env is read, and a second apply exits at once", async () => {
  const dir = checkout();
  // .env names a marker the fake flock would see if it were sourced first; the entry point locks before reading it.
  writeFileSync(join(dir, ".env"), "AIDENHQ_INSTANCE_DIR=/nonexistent-instance\n");
  const holder = run(dir, `exec 9>>data/apply.lock; flock 9; sleep 2`);
  await new Promise((r) => setTimeout(r, 200));
  const start = Date.now();
  const r = await run(dir, `bash ops/apply-config.sh`);
  const waited = Date.now() - start;
  await holder;
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /another apply is running/);
  assert.ok(waited < 1500, `it did not queue behind the holder (waited ${waited}ms)`);
  assert.equal(composeRan(r), false, `compose never ran:\n${r.docker}`);
});

test("two applies serialise: the second exits `another apply is running` without touching compose", async () => {
  const dir = checkout();
  // The first apply gets a checkout to work on and a `git` that takes a moment, so it is still inside the apply (holding
  // the lock) when the second one starts. Both go through the real entry point.
  mkdirSync(join(dir, "inst"), { recursive: true });
  writeFileSync(join(dir, ".env"), `AIDENHQ_INSTANCE_DIR=${join(dir, "inst")}\n`);
  writeFileSync(join(dir, "bin/git"), "#!/usr/bin/env bash\nsleep 1.5\nexit 0\n");
  chmodSync(join(dir, "bin/git"), 0o755);
  const first = run(dir, `bash ops/apply-config.sh`);
  await new Promise((r) => setTimeout(r, 300));
  const second = await run(dir, `bash ops/apply-config.sh`);
  const a = await first;
  assert.equal(second.status, 1, second.out);
  assert.match(second.out, /another apply is running/, second.out);
  assert.equal(composeRan(second), false, `the second apply never ran compose:\n${second.docker}`);
  // The first got past the lock (it was the holder) and stopped on the apply's own checks, not on the lock.
  assert.doesNotMatch(a.out, /another apply is running/, a.out);
  assert.match(a.out, /apply timing: instance/, `the holder ran the apply:\n${a.out}`);
});

test("the work script is not a second entry point: a marker with no lock on fd 9 is refused", async () => {
  const dir = checkout();
  const r = await run(dir, `exec 9>>data/apply.lock; export AIDENHQ_APPLY_LOCKED=9; bash ops/apply-config-work.sh`);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /data\/apply\.lock/);
  assert.equal(composeRan(r), false, `compose never ran:\n${r.docker}`);
});

test("every script the apply runs from ops/ is 100755 in git, so a checkout runs it", () => {
  // The apply runs these by path, so a lost mode bit is an apply that stops halfway.
  const scripts = ["ops/apply-config.sh", "ops/apply-config-work.sh", "ops/compose-recreate.sh", "ops/ci-runner-units.sh"];
  const out = execFileSync("git", ["ls-files", "-s", ...scripts], { cwd: join(here, "../.."), encoding: "utf8" });
  const modes = Object.fromEntries(out.trim().split("\n").map((l) => { const [mode, , , file] = l.split(/\s+/); return [file, mode]; }));
  for (const f of scripts) assert.equal(modes[f], "100755", `${f} is ${modes[f]}`);
});

test("a hand-over keeps the lock: the entry point reuses a held fd 9 instead of dropping and retaking it", async () => {
  const dir = checkout();
  // As ops/apply-config-work.sh hands over when the product changed the scripts: fd 9 already holds the lock, and the
  // entry point is exec'd again. It must not release the lock (another apply could take it in the gap) or refuse itself.
  const r = await run(dir, `
    exec 9>>data/apply.lock
    flock 9
    export AIDENHQ_APPLY_LOCKED=9 AIDENHQ_APPLY_BEFORE=deadbeef
    bash ops/apply-config.sh
  `);
  assert.doesNotMatch(r.out, /another apply is running/, r.out);
  assert.match(r.out, /AIDENHQ_INSTANCE_DIR/, `the hand-over kept the lock and ran the apply:\n${r.out}`);
});

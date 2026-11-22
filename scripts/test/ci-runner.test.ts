// ops/ci-runner.sh + ops/ci-runner-backoff.sh: a refused registration token writes a per-unit delay (1s doubling to a
// minute) and the unit's ExecStartPre waits it out, while a token that mints clears the delay and runs the job's container
// at once: RestartSec=1 stays the job-to-job path.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The unit's scripts and the helper both source, at the paths they use in a checkout.
const scripts = ["ci-runner.sh", "ci-runner-backoff.sh", "lib/ci-runner-backoff.sh"].map((name) => join(here, "../../ops", name));

// Every checkout goes when the file's tests do, so a run leaves no /tmp trees behind.
const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A checkout whose node, docker and sleep are fakes recording each call; `token` fails while the fixture file says so. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "ci-runner-"));
  made.push(dir);
  mkdirSync(join(dir, "bin"));
  for (const script of scripts) {
    const into = join(dir, "ops", script.slice(script.lastIndexOf("/ops/") + 5));
    mkdirSync(dirname(into), { recursive: true });
    writeFileSync(into, readFileSync(script, "utf8"));
  }
  const fake = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$LOG"\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  fake("node", '[ -f "$FAIL_TOKEN" ] && { echo "registration token for acme: the kernel said 403" >&2; exit 1; }\necho TOK');
  fake("docker", "exit 0");
  fake("sleep", "exit 0");
  return dir;
}

/** One unit start: ExecStartPre (the backoff wait), then ExecStart, as aidenhq-ci-runner@.service runs them. */
function run(dir, arg = "1", env: Record<string, string> = {}) {
  const log = join(dir, "log");
  writeFileSync(log, "");
  const unit = [join(dir, "ops/ci-runner-backoff.sh"), join(dir, "ops/ci-runner.sh")]
    .map((script) => `bash ${JSON.stringify(script)} ${JSON.stringify(arg)}; status=$?; [ "$status" -eq 0 ] || exit "$status"`)
    .join("\n");
  return new Promise<{ status: number; out: string; calls: string[] }>((resolve) => {
    execFile("bash", ["-c", unit], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, LOG: log, FAIL_TOKEN: join(dir, "fail"), AIDENHQ_DATA_DIR: join(dir, "data"), ...env },
    }, (error, stdout, stderr) => {
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      resolve({ status: error ? (error.code as number) : 0, out: `${stdout}${stderr}`, calls });
    });
  });
}

const retries = (calls: string[]) => calls.filter((c) => c.startsWith("sleep ")).map((c) => Number(c.slice(6)));
const marker = (dir, id = "1") => join(dir, "data/ci-runner", `${id}.backoff`);

test("a refused token waits 1s, 2s, 4s before the next attempt; a token that mints clears the delay", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "fail"), "");
  // The first refusal has no delay behind it (ExecStartPre writes nothing), and it leaves a second's wait.
  const first = await run(dir);
  assert.equal(first.status, 1, first.out);
  assert.deepEqual(retries(first.calls), [], "the first attempt does not wait");
  assert.match(first.out, /the next attempt waits 1s/);
  assert.equal(readFileSync(marker(dir), "utf8").trim(), "1");
  for (const [delay, next] of [[1, 2], [2, 4], [4, 8]] as const) {
    const r = await run(dir);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(retries(r.calls), [delay], "the wait comes from the last refusal");
    assert.equal(readFileSync(marker(dir), "utf8").trim(), String(next), "the next refusal doubles the delay");
  }
  writeFileSync(marker(dir), "60\n");
  const capped = await run(dir);
  assert.deepEqual(retries(capped.calls), [60], "the wait owed is served before the next attempt");
  assert.equal(readFileSync(marker(dir), "utf8").trim(), "60", "and the delay stays at its cap");
  // A minted token: the wait owed is served, the job's container runs, and the delay is gone.
  rmSync(join(dir, "fail"));
  const minted = await run(dir);
  assert.equal(minted.status, 0, minted.out);
  assert.deepEqual(retries(minted.calls), [60], "the wait the last refusal wrote still runs first");
  assert.ok(minted.calls.some((c) => c.startsWith("docker compose run")), minted.calls.join("\n"));
  assert.equal(existsSync(marker(dir)), false, "the next refusal starts again at 1s");
  // A clean job exit leaves no delay, so the next runner starts at once.
  const clean = await run(dir);
  assert.equal(clean.status, 0, clean.out);
  assert.deepEqual(retries(clean.calls), [], "a clean start does not sleep");
});

// A host that names its data dir in the checkout's .env (every install's .env.example does) gets the marker there, not under a
// default `data` the unit never reads: the unit's environment carries no AIDENHQ_DATA_DIR, only the file names one.
test("the checkout's .env names the data dir, and the marker goes there", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "fail"), "");
  writeFileSync(join(dir, ".env"), "# the fleet's settings\nAIDENHQ_DATA_DIR=\"moved\"  # beside the checkout\nOTHER=1\n");
  const first = await run(dir, "1", { AIDENHQ_DATA_DIR: "" });
  assert.equal(first.status, 1, first.out);
  const moved = join(dir, "moved/ci-runner/1.backoff");
  assert.ok(existsSync(moved), `${first.out}\nexpected the marker under the .env data dir`);
  assert.equal(readFileSync(moved, "utf8").trim(), "1");
  assert.equal(existsSync(marker(dir)), false, "nothing under the default data dir");
  rmSync(join(dir, "fail"));
  const minted = await run(dir, "1", { AIDENHQ_DATA_DIR: "" });
  assert.equal(minted.status, 0, minted.out);
  assert.deepEqual(retries(minted.calls), [1], "the wait is served from the .env marker");
  assert.equal(existsSync(moved), false, "and clearing it removes that marker");
});

// A marker left before a drain or an outage is not a refusal that is still looping: once it is old, the runner starts at once
// rather than serving a stale wait (the owner may have fixed the sign-in while the units were stopped).
test("a stale marker does not delay a runner brought back after a drain", async () => {
  const dir = checkout();
  mkdirSync(join(dir, "data/ci-runner"), { recursive: true });
  writeFileSync(marker(dir), "60\n");
  const long_ago = new Date(Date.now() - 60 * 60_000);
  utimesSync(marker(dir), long_ago, long_ago);
  const r = await run(dir);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(retries(r.calls), [], "the stale wait is not served");
  assert.ok(r.calls.some((c) => c.startsWith("docker compose run")), r.calls.join("\n"));
});

// A data dir that can't take the marker must not turn the refusal into a clean exit (the unit would then look healthy): the
// script reports it and exits non-zero, so the unit keeps restarting and CiRunnerRestartLooping sees the loop.
test("a marker that can't be written still ends the attempt as a refusal", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "fail"), "");
  writeFileSync(join(dir, "data"), "not a directory");
  const r = await run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not record the 1s backoff/);
  assert.ok(!r.calls.some((c) => c.startsWith("docker compose run")), "the job's container never runs without a token");
});

// The same unwritable data dir must not keep the runner down once GitHub mints again: clearing the marker is best effort
// (rm -f fails with ENOTDIR under a file where the dir should be), so the token that mints still starts the job's container.
test("after the token service recovers, an unwritable state dir does not stop the runner", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "fail"), "");
  writeFileSync(join(dir, "data"), "not a directory");
  assert.equal((await run(dir)).status, 1, "a refusal is still a refusal while the marker cannot be written");
  rmSync(join(dir, "fail")); // GitHub mints again; the broken data dir is unchanged
  const minted = await run(dir);
  assert.equal(minted.status, 0, minted.out);
  assert.ok(minted.calls.some((c) => c.startsWith("docker compose run")), "the job's container runs once the token mints");
});

// The scripts keep the marker through one helper, so its path and sanitisation live in one place: an org id with a slash
// (impossible in a unit name, possible in an argument) never writes outside the data dir.
test("one marker per unit, under the data dir, from both scripts", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "fail"), "");
  const r = await run(dir, "acme/../x");
  assert.equal(r.status, 1, r.out);
  assert.ok(existsSync(join(dir, "data/ci-runner/acme_.._x.backoff")), "the id is reduced to filename characters");
  assert.ok(!existsSync(join(dir, "data/x.backoff")));
});

test("each unit has its own delay", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "fail"), "");
  await run(dir, "1");
  await run(dir, "1");
  const other = await run(dir, "acme-2");
  assert.deepEqual(retries(other.calls), [], "unit acme-2 has its own marker");
  assert.equal(readFileSync(marker(dir, "acme-2"), "utf8").trim(), "1");
  assert.equal(readFileSync(marker(dir, "1"), "utf8").trim(), "2");
});

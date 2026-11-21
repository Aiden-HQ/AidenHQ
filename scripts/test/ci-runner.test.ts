// ops/ci-runner.sh: a refused registration token backs off (1s doubling to 5 minutes) before the unit restarts it, while a
// token that mints runs the job's container at once and forgets the delay: RestartSec=1 stays the job-to-job path.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../ops/ci-runner.sh");

/** A checkout whose node, docker and sleep are fakes recording each call; `token` fails while the fixture file says so. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "ci-runner-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "ops"));
  writeFileSync(join(dir, "ops/ci-runner.sh"), readFileSync(script, "utf8"));
  const fake = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$LOG"\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  fake("node", '[ -f "$FAIL_TOKEN" ] && { echo "registration token for acme: the kernel said 403" >&2; exit 1; }\necho TOK');
  fake("docker", "exit 0");
  fake("sleep", "exit 0");
  return dir;
}

function run(dir, arg = "1") {
  const log = join(dir, "log");
  writeFileSync(log, "");
  return new Promise<{ status: number; out: string; calls: string[] }>((resolve) => {
    execFile("bash", [join(dir, "ops/ci-runner.sh"), arg], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, LOG: log, FAIL_TOKEN: join(dir, "fail"), AIDENHQ_DATA_DIR: join(dir, "data") },
    }, (error, stdout, stderr) => {
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      resolve({ status: error ? (error.code as number) : 0, out: `${stdout}${stderr}`, calls });
    });
  });
}

const retries = (calls: string[]) => calls.filter((c) => c.startsWith("sleep ")).map((c) => Number(c.slice(6)));
const marker = (dir, id = "1") => join(dir, "data/ci-runner", `${id}.backoff`);

test("a refused token backs off 1s, 2s, 4s; a token that mints clears it and runs the job at once", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "fail"), "");
  for (const [n, delay] of [[1, 1], [2, 2], [3, 4]] as const) {
    const r = await run(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`retrying in ${delay}s`));
    assert.equal(retries(r.calls).at(-1), delay, `run ${n}`);
    assert.equal(readFileSync(marker(dir), "utf8").trim(), String(delay * 2), "the next refusal doubles the delay");
  }
  writeFileSync(marker(dir), "300\n");
  const capped = await run(dir);
  assert.equal(retries(capped.calls).at(-1), 300, "the delay is capped at 5 minutes");
  assert.equal(readFileSync(marker(dir), "utf8").trim(), "300", "and stays there");
  // A minted token: the marker is gone and the job's container starts now (no sleep).
  rmSync(join(dir, "fail"));
  const r = await run(dir);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(retries(r.calls), [], "a clean start does not sleep");
  assert.ok(r.calls.some((c) => c.startsWith("docker compose run")), r.calls.join("\n"));
  assert.equal(existsSync(marker(dir)), false, "the next refusal starts again at 1s");
});

test("each unit has its own delay", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "fail"), "");
  await run(dir, "1");
  await run(dir, "1");
  const other = await run(dir, "acme-2");
  assert.equal(retries(other.calls).at(-1), 1, "unit acme-2 has its own marker");
  assert.equal(readFileSync(marker(dir, "acme-2"), "utf8").trim(), "2");
  assert.equal(readFileSync(marker(dir, "1"), "utf8").trim(), "4");
});

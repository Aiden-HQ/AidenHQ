// ops/host-metrics.sh against a fake `systemctl` and `docker`: the unit snapshot's runner backoff series (the CI runner's own
// persisted wait after a refused registration token, which the alert reads instead of the sampled active bit). Every other
// textfile section runs on the same fakes, so this also pins that an empty runner state writes no backoff line at all.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** A host: a data dir with the monitoring textfile, and fakes for the systemctl and docker the script reads. */
function host() {
  const root = mkdtempSync(join(tmpdir(), "host-metrics-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // One running runner unit; every other read is empty.
  fake("systemctl", `case "$*" in *"list-units"*) echo "aidenhq-ci-runner@3.service active running" ;; *"list-unit-files"*) echo "aidenhq-ci-runner@.service enabled" ;; esac\nexit 0`);
  fake("docker", "exit 0");
  const data = join(root, "data");
  mkdirSync(join(data, "modules/monitoring/textfile"), { recursive: true });
  return { root, bin, data };
}

const run = (h, env = {}) => new Promise<string>((resolve, reject) => {
  execFile("bash", [join(repo, "ops/host-metrics.sh")], { env: { PATH: `${h.bin}:/usr/bin:/bin`, HOME: h.root, AIDENHQ_DATA_DIR: h.data, ...env } }, (e, out, err) => (e ? reject(new Error(`${out}${err}`)) : resolve(readFileSync(join(h.data, "modules/monitoring/textfile/units.prom"), "utf8"))));
});

test("a persisted runner backoff is a metric, and a stale or empty one is not", async () => {
  const h = host();
  const dir = join(h.data, "ci-runner");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "3.backoff"), "60\n");
  writeFileSync(join(dir, "4.backoff"), "1\n");
  // A stale marker a drain left behind: dropped rather than read as a loop.
  writeFileSync(join(dir, "6.backoff"), "60\n");
  const long_ago = new Date(Date.now() - 60 * 60_000);
  utimesSync(join(dir, "6.backoff"), long_ago, long_ago);
  // Not a delay at all: never a series.
  writeFileSync(join(dir, "7.backoff"), "soon\n");
  const text = await run(h);
  assert.match(text, /^aidenhq_unit_backoff\{scope="user",unit="aidenhq-ci-runner@3\.service"\} 60$/m);
  assert.match(text, /^aidenhq_unit_backoff\{scope="user",unit="aidenhq-ci-runner@4\.service"\} 1$/m);
  assert.doesNotMatch(text, /aidenhq-ci-runner@6\.service/, "a stale marker is not a loop");
  assert.doesNotMatch(text, /aidenhq-ci-runner@7\.service/, "a marker that is not a delay is not a series");
  // The unit's own state reads alongside it (the fake's third column is its sub-state, not "running": the snapshot's active
  // bit follows systemd's second column, so this pins only that the backoff sits next to the unit's series).
  assert.match(text, /^aidenhq_unit_active\{scope="user",unit="aidenhq-ci-runner@3\.service"\} /m);
});

// The resolver the runner's marker and this exporter share (ops/lib/data-dir.sh): a `.env` value reaches both the same way, so
// the marker a unit writes is the file this reads. `$HOME` expands as sourcing would, a trailing slash (even a lone `/`) is
// kept meaningful, and a relative value is the checkout's.
test("one data dir: the runner's marker and this exporter resolve a value the same way", async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-dir-"));
  mkdirSync(join(dir, "ops/lib"), { recursive: true });
  writeFileSync(join(dir, "ops/lib/data-dir.sh"), readFileSync(join(repo, "ops/lib/data-dir.sh"), "utf8"));
  const ask = (value: string, home: string) => new Promise<string>((resolve, reject) => {
    writeFileSync(join(dir, ".env"), `AIDENHQ_DATA_DIR=${value}\n`);
    execFile("bash", ["-c", `. "${dir}/ops/lib/data-dir.sh"; aidenhq_data_dir`], { env: { PATH: "/usr/bin:/bin", HOME: home } }, (e, out, err) => (e ? reject(new Error(`${out}${err}`)) : resolve(out.trim())));
  });
  const home = join(dir, "home");
  assert.equal(await ask('"$HOME/aiden-data"', home), `${home}/aiden-data`, "a variable expands as sourcing it would");
  assert.equal(await ask("./data", home), join(dir, "data"), "a relative value is the checkout's");
  assert.equal(await ask("/", home), "/", "a lone / stays the root");
  assert.equal(await ask("/srv/aidenhq/", home), "/srv/aidenhq", "a trailing slash is dropped, not the path");
});

test("no runner state writes a backoff metric with no series", async () => {
  const h = host();
  const text = await run(h);
  assert.match(text, /^# TYPE aidenhq_unit_backoff gauge$/m);
  assert.doesNotMatch(text, /^aidenhq_unit_backoff\{/m);
});

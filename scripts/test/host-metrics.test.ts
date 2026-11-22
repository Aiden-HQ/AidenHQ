// ops/host-metrics.sh against a fake `systemctl` and `docker`: the unit snapshot's runner backoff series (the CI runner's own
// persisted wait after a refused registration token, which the alert reads instead of the sampled active bit). Every other
// textfile section runs on the same fakes, so this also pins that an empty runner state writes no backoff line at all.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
  // One running runner unit; every other read is empty. The enabled runner instances can be narrowed with $DECLARED (one unit
  // per line), and the loaded units with $RUNNING, which pin that a retired runner's marker is not exported while a disabled
  // runner that is still running keeps its own; by default both runner instances are enabled and only 3 is running.
  // $UNIT_FILES is the general 'aidenhq-*' 'prune-*' listing, where systemd reports the runner template (indirectly enabled)
  // rather than the instance names; by default it holds that template and one non-runner unit.
  fake("systemctl", `case "$*" in
  *"list-units"*) if [ -f "$RUNNING" ]; then cat "$RUNNING"; else echo "aidenhq-ci-runner@3.service loaded active running AidenHQ CI runner"; fi ;;
  *"list-unit-files"*"aidenhq-ci-runner@*"*) if [ -f "$DECLARED" ]; then cat "$DECLARED"; else printf 'aidenhq-ci-runner@3.service enabled\naidenhq-ci-runner@4.service enabled\n'; fi ;;
  *"list-unit-files"*) if [ -f "$UNIT_FILES" ]; then cat "$UNIT_FILES"; else printf 'aidenhq-ci-runner@.service enabled\naidenhq-gateway.service enabled\n'; fi ;;
esac
exit 0`);
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

// The resolver the runner's marker and this exporter share (ops/lib/data-dir.sh) takes its value from the environment only:
// the apply puts the host's data dir in each unit's EnvironmentFile, so ordinary ops code never reads a settings file. A
// relative value is the checkout's, a leading `~` is the home directory, and a trailing slash (but a lone `/`) is dropped.
test("one data dir: the runner's marker and this exporter resolve a value the same way", async () => {
  const dir = mkdtempSync(join(tmpdir(), "data-dir-"));
  mkdirSync(join(dir, "ops/lib"), { recursive: true });
  writeFileSync(join(dir, "ops/lib/data-dir.sh"), readFileSync(join(repo, "ops/lib/data-dir.sh"), "utf8"));
  const ask = (value: string, home: string) => new Promise<string>((resolve, reject) => {
    execFile("bash", ["-c", `. "${dir}/ops/lib/data-dir.sh"; aidenhq_data_dir`], { env: { PATH: "/usr/bin:/bin", HOME: home, ...(value === "" ? {} : { AIDENHQ_DATA_DIR: value }) } }, (e, out, err) => (e ? reject(new Error(`${out}${err}`)) : resolve(out.trim())));
  });
  const home = join(dir, "home");
  assert.equal(await ask("", home), join(dir, "data"), "no setting in the environment is the checkout's ./data");
  assert.equal(await ask("/srv/aiden-data", home), "/srv/aiden-data", "an absolute value is used as given");
  assert.equal(await ask("./data", home), join(dir, "data"), "a relative value is the checkout's");
  assert.equal(await ask("~/aiden-data", home), `${home}/aiden-data`, "a leading ~ is the home directory");
  assert.equal(await ask("/", home), "/", "a lone / stays the root");
  assert.equal(await ask("/srv/aidenhq/", home), "/srv/aidenhq", "a trailing slash is dropped, not the path");
});

// The exporter takes its data dir from the environment its unit's EnvironmentFile gives it (the apply writes that file, and
// the CI runner's unit reads its own copy of the setting): ordinary ops code reads no `.env`, and a quoted value in one is
// simply not consulted. The textfiles land under the environment's path.
test("the exporter's data dir comes from the unit environment, not a checkout .env", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-env-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake("systemctl", "exit 0");
  fake("docker", "exit 0");
  mkdirSync(join(root, "ops/lib"), { recursive: true });
  writeFileSync(join(root, "ops/host-metrics.sh"), readFileSync(join(repo, "ops/host-metrics.sh"), "utf8"));
  writeFileSync(join(root, "ops/lib/data-dir.sh"), readFileSync(join(repo, "ops/lib/data-dir.sh"), "utf8"));
  // A .env that would point elsewhere: it must not be read.
  writeFileSync(join(root, ".env"), 'AIDENHQ_DATA_DIR=/srv/elsewhere\n');
  const home = join(root, "home");
  const data = join(home, "aiden-data");
  mkdirSync(join(data, "modules/monitoring/textfile"), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile("bash", [join(root, "ops/host-metrics.sh")], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, AIDENHQ_DATA_DIR: data } }, (e, out, err) => (e ? reject(new Error(`${out}${err}`)) : resolve()));
  });
  assert.match(readFileSync(join(data, "modules/monitoring/textfile/units.prom"), "utf8"), /^# TYPE aidenhq_unit_backoff gauge$/m, "written where the unit environment points");
  assert.ok(!existsSync(join(root, "srv/elsewhere")), "the checkout's .env is not read");
});

// A runner retired while its marker sat at the cap must not keep CiRunnerBackoff pending: a marker systemd no longer
// declares (the unit disabled and stopped) is not a loop that is still retrying.
test("a retired runner's marker is not exported", async () => {
  const h = host();
  const dir = join(h.data, "ci-runner");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "3.backoff"), "60\n");
  writeFileSync(join(dir, "4.backoff"), "60\n");
  // Only unit 3 is still declared: unit 4's marker is a leftover.
  writeFileSync(join(h.root, "declared"), "aidenhq-ci-runner@3.service enabled\n");
  const text = await run(h, { DECLARED: join(h.root, "declared") });
  assert.match(text, /^aidenhq_unit_backoff\{scope="user",unit="aidenhq-ci-runner@3\.service"\} 60$/m);
  assert.doesNotMatch(text, /aidenhq_unit_backoff\{scope="user",unit="aidenhq-ci-runner@4\.service"/, "a retired unit's marker is not a series");
});

// `systemctl --user disable` without `--now` leaves a runner running and retrying under its restart policy: a disabled unit
// that is still active (or activating, the state a backing-off unit is in) keeps its backoff series so the alert can fire.
test("a disabled runner that is still running keeps its backoff series", async () => {
  const h = host();
  const dir = join(h.data, "ci-runner");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "4.backoff"), "60\n");
  writeFileSync(join(dir, "5.backoff"), "60\n");
  // 3 stays the declared+enabled one; 4 is disabled but activating; 5 is disabled and stopped (a leftover).
  writeFileSync(join(h.root, "declared"), "aidenhq-ci-runner@3.service enabled\n");
  writeFileSync(join(h.root, "running"), [
    "aidenhq-ci-runner@3.service loaded active running AidenHQ CI runner",
    "aidenhq-ci-runner@4.service loaded activating start-pre AidenHQ CI runner",
    "aidenhq-ci-runner@5.service loaded inactive dead AidenHQ CI runner",
    "",
  ].join("\n"));
  const text = await run(h, { DECLARED: join(h.root, "declared"), RUNNING: join(h.root, "running") });
  assert.match(text, /^aidenhq_unit_backoff\{scope="user",unit="aidenhq-ci-runner@4\.service"\} 60$/m, "a disabled runner still activating is still retrying");
  assert.doesNotMatch(text, /aidenhq_unit_backoff\{scope="user",unit="aidenhq-ci-runner@5\.service"/, "a disabled and stopped runner's marker is a leftover");
});

test("no runner state writes a backoff metric with no series", async () => {
  const h = host();
  const text = await run(h);
  assert.match(text, /^# TYPE aidenhq_unit_backoff gauge$/m);
  assert.doesNotMatch(text, /^aidenhq_unit_backoff\{/m);
});

// The declared set is what an apply keeps running, and the runner alert joins it on (unit) with an instance's active series:
// systemd lists an enabled instance under the template name, so the instance names are read from the runner glob. A
// non-runner enabled unit still appears as before.
test("the declared set carries each enabled runner instance, not the template", async () => {
  const h = host();
  writeFileSync(join(h.root, "declared"), [
    "aidenhq-ci-runner@1.service enabled",
    "aidenhq-ci-runner@2.service enabled",
    "",
  ].join("\n"));
  const text = await run(h, { DECLARED: join(h.root, "declared") });
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@1\.service"\} 1$/m);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@2\.service"\} 1$/m);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-gateway\.service"\} 1$/m, "a non-runner enabled unit is still declared");
});

// A disabled runner instance is retired: it is absent from the runner glob's enabled listing and so from the declared set.
test("a retired runner instance is not declared", async () => {
  const h = host();
  writeFileSync(join(h.root, "declared"), "aidenhq-ci-runner@1.service enabled\n");
  const text = await run(h, { DECLARED: join(h.root, "declared") });
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@1\.service"\} 1$/m);
  assert.doesNotMatch(text, /aidenhq_unit_declared\{[^}]*unit="aidenhq-ci-runner@2\.service"\}/, "a disabled runner is not declared");
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-gateway\.service"\} 1$/m);
});

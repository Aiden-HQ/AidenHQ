// ops/host-metrics.sh against a fake `systemctl` and `docker`: the unit snapshot's runner backoff series (the CI runner's own
// persisted wait after a refused registration token, which the alert reads instead of the sampled active bit). Every other
// textfile section runs on the same fakes, so this also pins that an empty runner state writes no backoff line at all.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  // The user unit dir systemd loads, as `systemd-analyze --user unit-paths` names it.
  const unitDir = join(root, "systemd/user");
  mkdirSync(unitDir, { recursive: true });
  // One running runner unit; every other read is empty. The enabled runner instances are the install links `h.enable` writes
  // (as `systemctl --user enable` does), and the loaded units come from $RUNNING, which pin that a retired runner's marker is not exported
  // while a disabled runner that is still running keeps its own; by default instances 3 and 4 are enabled and only 3 is
  // running. $UNIT_FILES is the general 'aidenhq-*' 'prune-*' listing, where systemd reports an enabled instance only as the
  // runner template (indirectly enabled), never the instance names; by default it holds that template and one non-runner unit.
  fake("systemd-analyze", `case "$*" in *unit-paths*) echo "$UNIT_DIR" ;; esac\nexit 0`);
  fake("systemctl", `case "$*" in
  *"list-units"*) if [ -f "$RUNNING" ]; then cat "$RUNNING"; else echo "aidenhq-ci-runner@3.service loaded active running AidenHQ CI runner"; fi ;;
  *"is-enabled"*) { [ -f "$MASKED" ] && grep -qxF -- "\${@: -1}" "$MASKED"; } && { echo masked; exit 1; }; echo enabled ;;
  *"list-unit-files"*) if [ -f "$UNIT_FILES" ]; then cat "$UNIT_FILES"; else printf 'aidenhq-ci-runner@.service enabled\\naidenhq-gateway.service enabled\\n'; fi ;;
esac
exit 0`);
  fake("docker", "exit 0");
  const data = join(root, "data");
  mkdirSync(join(data, "modules/monitoring/textfile"), { recursive: true });
  const wants = join(unitDir, "default.target.wants");
  const requires = join(unitDir, "default.target.requires");
  mkdirSync(wants, { recursive: true });
  mkdirSync(requires, { recursive: true });
  // systemd enables an instance by linking the template into a target's .wants (or .requires) dir; the instance has no unit
  // file of its own. $MASKED names the instances the fake's is-enabled reports masked.
  // The template has real content: systemd reads an empty unit file as masked, and a dependency link onto an empty file is
  // one too (null_or_empty_path in src/core/load-dropin.c), so an empty file here would model a masked runner, not a live one.
  writeFileSync(join(unitDir, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=AidenHQ CI runner\n");
  // A target whose dependency dirs systemd reads: the target itself must be a unit file.
  writeFileSync(join(unitDir, "default.target"), "[Unit]\nDescription=default\n");
  const enable = (units) => {
    for (const entry of readdirSync(wants)) unlinkSync(join(wants, entry));
    for (const unit of units) symlinkSync(join(unitDir, "aidenhq-ci-runner@.service"), join(wants, `${unit}.service`));
  };
  enable(["aidenhq-ci-runner@3", "aidenhq-ci-runner@4"]);
  return { root, bin, data, unitDir, wants, requires, enable };
}

const run = (h, env = {}) => new Promise<string>((resolve, reject) => {
  execFile("bash", [join(repo, "ops/host-metrics.sh")], { env: { PATH: `${h.bin}:/usr/bin:/bin`, HOME: h.root, UNIT_DIR: h.unitDir, AIDENHQ_DATA_DIR: h.data, ...env } }, (e, out, err) => (e ? reject(new Error(`${out}${err}`)) : resolve(readFileSync(join(h.data, "modules/monitoring/textfile/units.prom"), "utf8"))));
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
  writeFileSync(join(root, "ops/lib/ci-runner-enabled.sh"), readFileSync(join(repo, "ops/lib/ci-runner-enabled.sh"), "utf8"));
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
  h.enable(["aidenhq-ci-runner@3"]);
  const text = await run(h);
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
  h.enable(["aidenhq-ci-runner@3"]);
  writeFileSync(join(h.root, "running"), [
    "aidenhq-ci-runner@3.service loaded active running AidenHQ CI runner",
    "aidenhq-ci-runner@4.service loaded activating start-pre AidenHQ CI runner",
    "aidenhq-ci-runner@5.service loaded inactive dead AidenHQ CI runner",
    "",
  ].join("\n"));
  const text = await run(h, { RUNNING: join(h.root, "running") });
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
// systemd lists an enabled instance only as the template, so the instance names are read from the enablement links. A
// non-runner enabled unit still appears as before, and the template is not declared.
test("the declared set carries each enabled runner instance, not the template", async () => {
  const h = host();
  h.enable(["aidenhq-ci-runner@1", "aidenhq-ci-runner@2"]);
  const text = await run(h);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@1\.service"\} 1$/m);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@2\.service"\} 1$/m);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-gateway\.service"\} 1$/m, "a non-runner enabled unit is still declared");
  assert.doesNotMatch(text, /^aidenhq_unit_declared\{[^}]*unit="aidenhq-ci-runner@\.service"\} 1$/m, "the template is not declared");
});

// A disabled runner instance is retired: its enablement link is gone and so is its declared series.
test("a retired runner instance is not declared", async () => {
  const h = host();
  h.enable(["aidenhq-ci-runner@1"]);
  const text = await run(h);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@1\.service"\} 1$/m);
  assert.doesNotMatch(text, /aidenhq_unit_declared\{[^}]*unit="aidenhq-ci-runner@2\.service"\}/, "a disabled runner is not declared");
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-gateway\.service"\} 1$/m);
});

// A cleanup that removes the runner template leaves its enablement links behind, dangling: systemd reads such an instance as
// not-found, so it declares nothing and must not be exported (a declared series is what lets CiRunnerUnitMissing fire).
test("a dangling runner enablement link is not declared", async () => {
  const h = host();
  h.enable(["aidenhq-ci-runner@1"]);
  const template = join(h.unitDir, "aidenhq-ci-runner@.service");
  unlinkSync(template);
  symlinkSync(join(h.unitDir, "gone.service"), join(h.wants, "aidenhq-ci-runner@2.service"));
  const text = await run(h);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-gateway\.service"\} 1$/m);
  assert.doesNotMatch(text, /aidenhq_unit_declared\{[^}]*unit="aidenhq-ci-runner@/, "a link with no template behind it declares no runner");
  assert.doesNotMatch(text, /^aidenhq_unit_backoff\{/m);
});

// Only a symlink under a target's .wants dir enables an instance: systemd ignores a plain file with a unit name there (a
// backup restored over the link, say) and reads that instance as disabled, so it must not be declared.
test("a plain file in the wants dir is not a runner enablement link", async () => {
  const h = host();
  h.enable(["aidenhq-ci-runner@1"]);
  writeFileSync(join(h.wants, "aidenhq-ci-runner@2.service"), "");
  const text = await run(h);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@1\.service"\} 1$/m);
  assert.doesNotMatch(text, /aidenhq_unit_declared\{[^}]*unit="aidenhq-ci-runner@2\.service"\}/, "a plain file does not enable an instance");
});

// `systemctl --user add-requires` enables an instance through a target's .requires dir instead of .wants, and systemd reads
// it as enabled, so it is declared too.
test("a runner enabled through a requires link is declared", async () => {
  const h = host();
  h.enable(["aidenhq-ci-runner@1"]);
  symlinkSync(join(h.unitDir, "aidenhq-ci-runner@.service"), join(h.requires, "aidenhq-ci-runner@2.service"));
  const text = await run(h);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@1\.service"\} 1$/m);
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@2\.service"\} 1$/m, "a requires link declares the instance");
});

// A masked instance keeps its enablement link but systemd will not start it, so it no longer counts as declared (and its
// backoff marker is not republished).
test("a masked runner instance is not declared", async () => {
  const h = host();
  h.enable(["aidenhq-ci-runner@1", "aidenhq-ci-runner@2"]);
  writeFileSync(join(h.root, "masked"), "aidenhq-ci-runner@2.service\n");
  const text = await run(h, { MASKED: join(h.root, "masked") });
  assert.match(text, /^aidenhq_unit_declared\{scope="user",unit="aidenhq-ci-runner@1\.service"\} 1$/m);
  assert.doesNotMatch(text, /aidenhq_unit_declared\{[^}]*unit="aidenhq-ci-runner@2\.service"\}/, "a masked instance is not declared");
});

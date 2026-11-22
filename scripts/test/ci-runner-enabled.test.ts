// The one definition of "is a runner instance enabled" that the apply (ops/apply-config-work.sh, the runner-template gate)
// and the exporter (ops/host-metrics.sh, the declared set) both call. It reads the install links systemd reads, never
// list-unit-files: an enabled instance of the template has no unit file, only a .wants/.requires symlink, and list-unit-files
// lists the template itself as `indirect`. Each case below is a host shape systemd 262 produced on a real system.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** A checkout with two user unit dirs (high, then low priority, as `unit-paths` lists them), each with the template, its
 * .wants/.requires dirs, and a fake systemctl. */
function host() {
  const root = mkdtempSync(join(tmpdir(), "runner-enabled-"));
  const bin = join(root, "bin");
  const high = join(root, "systemd/user");
  const low = join(root, "systemd/user.control");
  const unitDir = high;
  const wants = join(high, "default.target.wants");
  const requires = join(high, "default.target.requires");
  // Two targets, so precedence is exercised per dependency path (default.target vs timers.target).
  const timers = join(high, "timers.target.wants");
  const lowTimers = join(low, "timers.target.wants");
  for (const d of [bin, wants, requires, join(low, "default.target.wants"), join(low, "default.target.requires"), timers, lowTimers]) mkdirSync(d, { recursive: true });
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake("systemd-analyze", `case "$*" in *--user*unit-paths*) printf '%s\\n' "${high}" "${low}" ;; esac`);
  // list-unit-files lists only the template, as `indirect enabled`, so --state=enabled prints nothing; a masked instance
  // keeps its link but is-enabled says masked. ctrl/masked names the instances the fake reports masked.
  fake("systemctl", `case "$*" in
  *"list-unit-files"*) case "$*" in *--state=enabled*) ;; *) echo "aidenhq-ci-runner@.service indirect enabled" ;; esac ;;
  *"is-enabled"*) for a in "$@"; do unit="$a"; done; [ -f "${root}/masked" ] && grep -qxF -- "$unit" "${root}/masked" && { echo masked; exit 1; }; echo enabled ;;
esac
exit 0`);
  writeFileSync(join(unitDir, "aidenhq-ci-runner@.service"), "[Unit]\n");
  const link = (name, dir = wants) => symlinkSync(join(unitDir, "aidenhq-ci-runner@.service"), join(dir, `${name}.service`));
  return { root, bin, unitDir, low, wants, requires, timers, lowTimers, link };
}

/** The names ci_runner_enabled_units prints, through the real library. */
const enabled = (h) => new Promise<string[]>((resolve, reject) => {
  execFile("bash", ["-c", ". ops/lib/ci-runner-enabled.sh; ci_runner_enabled_units"], {
    cwd: repo, env: { PATH: `${h.bin}:/usr/bin:/bin`, HOME: h.root },
  }, (e, out, err) => (e ? reject(new Error(`${out}${err}`)) : resolve(out.split("\n").filter(Boolean))));
});

test("an enabled runner instance is the install link systemd reads, never a list-unit-files line", async () => {
  const h = host();
  h.link("aidenhq-ci-runner@3");
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "a .wants link alone declares the instance");
});

test("a host with no enabled runner instance declares none", async () => {
  const h = host();
  assert.deepEqual(await enabled(h), [], "the template alone is not a runner");
});

test("a disabled instance's link is gone and it is not declared", async () => {
  const h = host();
  h.link("aidenhq-ci-runner@1");
  unlinkSync(join(h.wants, "aidenhq-ci-runner@1.service"));
  assert.deepEqual(await enabled(h), [], "no link, no runner");
});

test("a plain file in .wants is not an enablement link", async () => {
  const h = host();
  writeFileSync(join(h.wants, "aidenhq-ci-runner@2.service"), "");
  assert.deepEqual(await enabled(h), [], "systemd ignores a plain file with a unit name");
});

test("a dangling link whose template is gone is not declared", async () => {
  const h = host();
  unlinkSync(join(h.unitDir, "aidenhq-ci-runner@.service"));
  symlinkSync(join(h.unitDir, "gone@.service"), join(h.wants, "aidenhq-ci-runner@2.service"));
  assert.deepEqual(await enabled(h), [], "is-enabled reads a dangling instance as not-found");
});

test("a masked instance keeps its link but is not declared", async () => {
  const h = host();
  h.link("aidenhq-ci-runner@2");
  writeFileSync(join(h.root, "masked"), "aidenhq-ci-runner@2.service\n");
  assert.deepEqual(await enabled(h), [], "a masked instance will not start");
});

test("a .requires link and a .wants link both declare their instances", async () => {
  const h = host();
  h.link("aidenhq-ci-runner@1");
  h.link("aidenhq-ci-runner@2", h.requires);
  assert.deepEqual((await enabled(h)).sort(), ["aidenhq-ci-runner@1.service", "aidenhq-ci-runner@2.service"]);
});

// systemd 262 with --root reads a .wants link to /dev/null as `enabled` (the mask sits on the dependency, not the unit),
// and a product that masks the template under the instance's name leaves such a link too. Either way the link enables
// nothing: it must not count.
test("a dependency link pointing at /dev/null is not an enabled instance", async () => {
  const h = host();
  symlinkSync("/dev/null", join(h.wants, "aidenhq-ci-runner@2.service"));
  assert.deepEqual(await enabled(h), [], "a link masked from its own file starts nothing");
});

// systemd lets a higher-priority dir cancel a lower-priority dependency: a same-named /dev/null link (or a plain file) in
// ~/.config/systemd/user/default.target.wants/ hides an install link in /etc/systemd/user/... while is-enabled still says
// `enabled` (systemd 262 with --root). The winning entry decides.
test("a higher-priority mask cancels a lower-priority install link", async () => {
  const h = host();
  h.link("aidenhq-ci-runner@3", join(h.low, "default.target.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the lower link declares it while nothing shadows it");
  symlinkSync("/dev/null", join(h.wants, "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "a /dev/null mask at a higher-priority dir wins");
});

// Precedence is per dependency file, not per instance: masking default.target's dependency leaves a valid timers.target
// dependency, which still enables the runner.
test("a mask of one target's dependency does not hide another target's link", async () => {
  const h = host();
  symlinkSync("/dev/null", join(h.wants, "aidenhq-ci-runner@3.service"));
  h.link("aidenhq-ci-runner@3", h.timers);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the instance is still enabled through timers.target");
});

test("a higher-priority plain file cancels a lower-priority install link", async () => {
  const h = host();
  h.link("aidenhq-ci-runner@3", join(h.low, "default.target.wants"));
  writeFileSync(join(h.wants, "aidenhq-ci-runner@3.service"), "[Unit]\n");
  assert.deepEqual(await enabled(h), [], "systemd reads the higher dir's plain file, not the lower link");
});

test("the bare template's own link is not an instance", async () => {
  const h = host();
  symlinkSync(join(h.unitDir, "aidenhq-ci-runner@.service"), join(h.wants, "aidenhq-ci-runner@.service"));
  assert.deepEqual(await enabled(h), []);
});

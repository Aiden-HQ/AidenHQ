// The one definition of "is a runner instance enabled" that the apply (ops/apply-config-work.sh, the runner-template gate)
// and the exporter (ops/host-metrics.sh, the declared set) both call. It reads the install links systemd reads, never
// list-unit-files: an enabled instance of the template has no unit file, only a .wants/.requires symlink, and list-unit-files
// lists the template itself as `indirect`. Each case below is a host shape systemd 262 produced on a real system.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, symlinkSync } from "node:fs";
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
  // The targets whose dependency dirs the tests write: systemd loads a unit only from its own file.
  writeFileSync(join(unitDir, "default.target"), "[Unit]\nDescription=default\n");
  writeFileSync(join(unitDir, "timers.target"), "[Unit]\nDescription=timers\n");
  const link = (name, dir = wants) => symlinkSync(join(unitDir, "aidenhq-ci-runner@.service"), join(dir, `${name}.service`));
  // A unit the host loads because a dependency names it (systemd reads the entry's file name as the unit id): how an
  // instance with no unit file of its own exists at all.
  const names = (unit, dir = wants) => symlinkSync(join(unitDir, unit), join(dir, unit));
  // An alias replaces a target's own file (systemd loads the alias under both names).
  const alias = (dest, at) => { try { unlinkSync(at); } catch {} symlinkSync(dest, at); };
  return { root, bin, unitDir, low, wants, requires, timers, lowTimers, link, names, alias };
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
  assert.deepEqual(await enabled(h), [], "with no template and no instance file, the name resolves nowhere");
});

// systemd reads a dependency by its file name, not by the link's destination: a link left over from a template that has
// since moved still enables the instance (`is-enabled` reads it `enabled` on systemd 262 with --root, the destination gone).
test("a link whose destination is stale still enables the unit its name resolves", async () => {
  const h = host();
  symlinkSync(join(h.low, "aidenhq-ci-runner@.service"), join(h.wants, "aidenhq-ci-runner@2.service"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@2.service"], "the name resolves through the template in another unit dir");
});

// A template that is itself a symlink to a file that was deleted resolves to nothing: systemd 262 with --root reads the
// instance `not-found`, and the apply's copy would refuse to write through the dangling symlink.
test("a template that is a dangling symlink enables no instance", async () => {
  const h = host();
  unlinkSync(join(h.unitDir, "aidenhq-ci-runner@.service"));
  symlinkSync(join(h.root, "gone@.service"), join(h.unitDir, "aidenhq-ci-runner@.service"));
  h.link("aidenhq-ci-runner@3");
  assert.deepEqual(await enabled(h), [], "a broken template enables nothing");
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
// A directory with a unit's name is not a unit file: systemd loads nothing from it, and a template path that is a directory
// cannot even be written. It declares no runner.
test("a directory with the template's name enables no instance", async () => {
  const h = host();
  unlinkSync(join(h.unitDir, "aidenhq-ci-runner@.service"));
  mkdirSync(join(h.unitDir, "aidenhq-ci-runner@.service"));
  h.link("aidenhq-ci-runner@3");
  assert.deepEqual(await enabled(h), [], "a directory is not a unit file");
});

// The generic dir is read last and keeps one entry per name with the named targets' dirs: a mask there cancels a generic
// link of the same name, so a loaded target that masks the dependency declares no runner even with a link in target.wants.
test("a named target's mask shadows the generic target.wants link", async () => {
  const h = host();
  // One target only: with a second loaded target the generic dir still serves that one (the next test).
  rmSync(h.timers, { recursive: true });
  rmSync(h.lowTimers, { recursive: true });
  rmSync(join(h.unitDir, "timers.target"));
  const generic = join(h.unitDir, "target.wants");
  mkdirSync(generic, { recursive: true });
  h.link("aidenhq-ci-runner@3", generic);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the generic link declares it while nothing shadows it");
  symlinkSync("/dev/null", join(h.wants, "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "the named target's mask wins over the generic dir's link");
});

// One target's mask does not hide the dependency from another unit the generic dir still serves: timers.target has no file
// of its own for the name, so it reads `target.wants`'s link even though default.target masks it.
test("another target still reads the generic link a mask does not cover", async () => {
  const h = host();
  const generic = join(h.unitDir, "target.wants");
  mkdirSync(generic, { recursive: true });
  h.link("aidenhq-ci-runner@3", generic);
  symlinkSync("/dev/null", join(h.wants, "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "timers.target still reads the generic dir's link");
});

// `target.wants` (a unit type, no name) is systemd's generic dependency dir: it is read after every named target's and
// alias's (unit_file_find_dirs), so a dependency declared only there still enables the instance.
test("a dependency in the generic target.wants dir declares the instance", async () => {
  const h = host();
  const generic = join(h.unitDir, "target.wants");
  mkdirSync(generic, { recursive: true });
  h.link("aidenhq-ci-runner@3", generic);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the generic dir is systemd's last, but it is read");
});

// `UpheldBy=default.target` (systemd 255+) lands a link in `default.target.upholds`, and systemd loads it, so it enables
// the instance like a .wants or .requires link does.
test("a dependency in a .upholds dir declares the instance", async () => {
  const h = host();
  const upholds = join(h.unitDir, "default.target.upholds");
  mkdirSync(upholds, { recursive: true });
  h.link("aidenhq-ci-runner@3", upholds);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "an .upholds link is a dependency systemd loads");
});

// systemd also reads a unit's dash-prefix dependency dirs (`workstation-ci.target` -> `workstation-.target`), most specific
// first: the unit's own dir masks the prefix dir's link.
test("a dash-prefix dependency dir shadows the unit's own mask", async () => {
  const h = host();
  const prefix = join(h.unitDir, "workstation-.target.wants");
  const specific = join(h.unitDir, "workstation-ci.target.wants");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(specific, { recursive: true });
  writeFileSync(join(h.unitDir, "workstation-ci.target"), "[Unit]\nDescription=ci\n");
  h.link("aidenhq-ci-runner@3", prefix);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the inherited prefix link enables it while nothing shadows it");
  symlinkSync("/dev/null", join(specific, "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "the unit's own mask cancels the prefix dir's link");
});

// A unit path is compared canonicalised: on a merged-/usr host /lib/systemd/user is /usr/lib/systemd/user, and an alias
// written with the /lib spelling still folds onto the dirs under /usr/lib.
test("a unit path reached through a symlink still folds the alias", async () => {
  const h = host();
  const lib = join(h.root, "lib/user");
  const usr = join(h.root, "usr/lib/user");
  mkdirSync(usr, { recursive: true });
  mkdirSync(dirname(lib), { recursive: true });
  symlinkSync(usr, lib);
  // The second unit path is spelled /lib, and the alias names the unit through /lib too.
  writeFileSync(join(h.bin, "systemd-analyze"), `#!/usr/bin/env bash\ncase "$*" in *--user*unit-paths*) printf '%s\\n' "${h.unitDir}" "${lib}" ;; esac\n`);
  chmodSync(join(h.bin, "systemd-analyze"), 0o755);
  writeFileSync(join(usr, "workstation.target"), "[Unit]\nDescription=ws\n");
  writeFileSync(join(usr, "aidenhq-ci-runner@.service"), "[Unit]\nDescription=runner\n");
  rmSync(join(h.unitDir, "default.target"));
  h.alias(join(lib, "workstation.target"), join(usr, "default.target"));
  mkdirSync(join(usr, "workstation.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", h.wants);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the link enables it while nothing shadows the name");
  symlinkSync("/dev/null", join(usr, "workstation.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "the /lib spelling of the alias folds onto the /usr/lib unit");
});

// A leftover `<name>.wants` dir is not a loaded unit: an operator who removed the target leaves the dir and its link behind,
// and systemd loads no dependency for a target with no unit file. The same for a masked or empty target file.
test("a link under a target that is not a unit declares nothing", async () => {
  const h = host();
  rmSync(join(h.unitDir, "default.target"));
  h.link("aidenhq-ci-runner@3", h.wants);
  assert.deepEqual(await enabled(h), [], "no unit file for the target: systemd loads nothing from its dirs");
  writeFileSync(join(h.unitDir, "default.target"), "");
  assert.deepEqual(await enabled(h), [], "an empty target file is a mask");
  rmSync(join(h.unitDir, "default.target"));
  symlinkSync("/dev/null", join(h.unitDir, "default.target"));
  assert.deepEqual(await enabled(h), [], "a /dev/null target is a mask");
});

// A masked target (a user-level /dev/null link over a vendor file) is not loaded: its dependency dirs declare nothing.
test("a link under a masked target declares nothing", async () => {
  const h = host();
  writeFileSync(join(h.low, "default.target"), "[Unit]\nDescription=vendor\n");
  unlinkSync(join(h.unitDir, "default.target"));
  symlinkSync("/dev/null", join(h.unitDir, "default.target"));
  writeFileSync(join(h.root, "masked"), "default.target\n");
  h.link("aidenhq-ci-runner@3");
  assert.deepEqual(await enabled(h), [], "a masked target loads no dependency");
});

// An instance with no file of its own loads from its template (`worker@.service`), so its own dependency dirs and the
// template's are both read. The template alone is no owner: with no concrete instance on the host, nothing loads it, so a
// link only under `worker@.service.wants` enables nothing.
test("an instance loaded from its template reads the template's dependency dirs", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  mkdirSync(join(h.unitDir, "worker@.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", join(h.unitDir, "worker@.service.wants"));
  assert.deepEqual(await enabled(h), [], "the template alone loads no instance");
  // A dependency entry names `worker@blue.service`, so the host loads it, and the template's link is read for it.
  h.names("worker@blue.service");
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the instance's own template is the unit that loads");
});

// A concrete instance also reads its template's dependency dirs (`worker@blue.service` reads `worker@.service`), and so does
// a dash-prefix instance (`workstation-worker@blue.service` reads `workstation-worker@.service` and
// `workstation-@blue.service`). The instance is in the unit set through its own dependency dir; the runner link lives one
// level up, in the template's.
test("a concrete instance reads its template's and its prefix template's dependency dirs", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  h.names("worker@blue.service");
  mkdirSync(join(h.unitDir, "worker@.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@4", join(h.unitDir, "worker@.service.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@4.service"], "the template's own wants dir is read for the instance");
  rmSync(join(h.unitDir, "worker@.service.wants"), { recursive: true });
  writeFileSync(join(h.unitDir, "workstation-worker@.service"), "[Unit]\nDescription=worker\n");
  h.names("workstation-worker@blue.service");
  mkdirSync(join(h.unitDir, "workstation-@blue.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@5", join(h.unitDir, "workstation-@blue.service.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@5.service"], "the prefix template is read for its instance");
});

// A masked instance is not loaded even when its template is: the mask is the mask whatever the template's file is.
test("a masked instance is not enabled by its template", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  h.names("worker@blue.service");
  mkdirSync(join(h.unitDir, "worker@blue.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@6", join(h.unitDir, "worker@blue.service.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@6.service"], "the instance's own dir declares it while unmasked");
  writeFileSync(join(h.root, "masked"), "worker@blue.service\n");
  assert.deepEqual(await enabled(h), [], "a masked instance loads nothing, template or not");
});

// Only the unit type is stripped before the prefix walk: a dot inside a name is part of it (`nightly.v2-ci.target` reads
// `nightly.v2-.target.wants`, not `nightly.wants`).
test("a name with a dot in it keeps its prefix chain", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "nightly.v2-ci.target"), "[Unit]\nDescription=nightly\n");
  mkdirSync(join(h.unitDir, "nightly.v2-.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@7", join(h.unitDir, "nightly.v2-.target.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@7.service"], "the dot is part of the prefix");
});

// A name with many dashes expands to each prefix once, not once per path to it.
test("a long prefix chain expands each name once", async () => {
  const h = host();
  const many = `${Array.from({ length: 30 }, (_, i) => `p${i}`).join("-")}.target`;
  writeFileSync(join(h.unitDir, many), "[Unit]\nDescription=many\n");
  mkdirSync(join(h.unitDir, "p0-.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@8", join(h.unitDir, "p0-.target.wants"));
  const started = Date.now();
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@8.service"], "a long chain still finds the link");
  assert.ok(Date.now() - started < 20000, "a long prefix chain does not multiply");
});

// An aliased template folds its instance too: `alias@.worker -> worker@.worker` makes `alias@blue.worker` the unit
// `worker@blue.worker`, so a mask under the canonical instance's dirs cancels the alias instance's link.
test("an aliased template folds onto the canonical instance", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.worker"), "[Unit]\nDescription=worker\n");
  symlinkSync("worker@.worker", join(h.unitDir, "alias@.worker"));
  h.names("alias@blue.worker");
  mkdirSync(join(h.unitDir, "alias@blue.worker.wants"), { recursive: true });
  mkdirSync(join(h.unitDir, "worker@blue.worker.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@9", join(h.unitDir, "alias@blue.worker.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@9.service"], "the alias instance's own dir declares it");
  symlinkSync("/dev/null", join(h.unitDir, "worker@blue.worker.wants", "aidenhq-ci-runner@9.service"));
  assert.deepEqual(await enabled(h), [], "the canonical instance's mask wins over the alias instance's link");
});

// A host with no runner link at all does no unit work: the exporter runs this every scrape.
test("a host with no runner link returns before resolving units", async () => {
  const h = host();
  const started = Date.now();
  assert.deepEqual(await enabled(h), [], "no link, no runners");
  assert.ok(Date.now() - started < 5000, "no unit resolution without a link");
});

// A dot inside an instance id or a template prefix is part of the name: only the final unit-type suffix is stripped.
test("a dotted instance and a dotted template prefix resolve through the template", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker.v2@.service"), "[Unit]\nDescription=worker\n");
  h.names("worker.v2@blue.v3.service");
  mkdirSync(join(h.unitDir, "worker.v2@blue.v3.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@11", join(h.unitDir, "worker.v2@blue.v3.service.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@11.service"], "the dotted template is the one that loads");
});

// A canonical instance reached only through an aliased template has no name of its own: the alias's dirs are still read
// for it, because systemd loads the canonical unit and reads them.
test("a canonical instance reached only through an aliased template is still the owner", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.worker"), "[Unit]\nDescription=worker\n");
  symlinkSync("worker@.worker", join(h.unitDir, "alias@.worker"));
  h.names("alias@blue.worker");
  mkdirSync(join(h.unitDir, "alias@blue.worker.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@12", join(h.unitDir, "alias@blue.worker.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@12.service"], "the canonical instance the alias folds to is loaded");
});

// A target that is a symlink to a deleted file outside the unit path is `not-found`: systemd loads nothing for it, so its
// leftover `.wants` dir declares no runner.
test("a target unit file that dangles outside the unit path declares nothing", async () => {
  const h = host();
  symlinkSync(join(h.root, "gone.target"), join(h.unitDir, "nightly.target"));
  mkdirSync(join(h.unitDir, "nightly.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@13", join(h.unitDir, "nightly.target.wants"));
  assert.deepEqual(await enabled(h), [], "a dangling unit file is not a unit systemd loads");
});

// An alias instance that points at a template keeps its instance id: `worker-alias@blue.service -> worker@.service` is the
// unit `worker@blue.service`, and its own `.wants` dir is read for it.
test("an alias instance that points at a template keeps its instance id", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  symlinkSync(join(h.unitDir, "worker@.service"), join(h.unitDir, "worker-alias@blue.service"));
  h.names("worker-alias@blue.service");
  mkdirSync(join(h.unitDir, "worker-alias@blue.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@14", join(h.unitDir, "worker-alias@blue.service.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@14.service"], "the alias's instance id is kept");
});

// An instance named only by a dependency entry is still a unit the host loads (`default.target.wants/worker@blue.service`
// starts it), so its template's dependency dirs are read for it.
test("an instance named only by a dependency entry owns its template's dirs", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  mkdirSync(join(h.unitDir, "worker@.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@15", join(h.unitDir, "worker@.service.wants"));
  h.names("worker@blue.service");
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@15.service"], "the named instance is the owner");
});

// A concrete instance file of its own is its own unit: an aliased template does not fold it onto the canonical name.
test("a concrete instance file is not folded through an aliased template", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  symlinkSync("worker@.service", join(h.unitDir, "alias@.service"));
  writeFileSync(join(h.unitDir, "alias@blue.service"), "[Unit]\nDescription=own\n");
  mkdirSync(join(h.unitDir, "alias@blue.service.wants"), { recursive: true });
  mkdirSync(join(h.unitDir, "worker@blue.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@16", join(h.unitDir, "alias@blue.service.wants"));
  symlinkSync("/dev/null", join(h.unitDir, "worker@blue.service.wants", "aidenhq-ci-runner@16.service"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@16.service"], "the concrete file's own link is not hidden");
});

// A leftover dependency dir names no unit: a disabled instance whose `.wants` dir is still there loads nothing, so the
// template's link is not read for it.
test("a leftover empty dependency dir declares no instance", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  mkdirSync(join(h.unitDir, "worker@blue.service.wants"), { recursive: true });
  mkdirSync(join(h.unitDir, "worker@.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@17", join(h.unitDir, "worker@.service.wants"));
  assert.deepEqual(await enabled(h), [], "no unit names worker@blue.service any more");
});

// A dependency entry masked to /dev/null names no unit: systemd loads nothing from it, so the template's runner link is not
// read for an instance only that entry mentions.
test("a /dev/null dependency entry names no unit", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  mkdirSync(join(h.unitDir, "worker@.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@18", join(h.unitDir, "worker@.service.wants"));
  symlinkSync("/dev/null", join(h.wants, "worker@blue.service"));
  assert.deepEqual(await enabled(h), [], "a masked entry declares no instance");
});

// A dependency entry masked in a higher-priority dir shadows the same entry lower down: systemd keeps one file per name for
// a target's dirs, so the lower link names no unit.
test("a higher-priority mask of a dependency entry names no unit", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  mkdirSync(join(h.unitDir, "worker@.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@19", join(h.unitDir, "worker@.service.wants"));
  symlinkSync(join(h.low, "worker@.service"), join(h.low, "default.target.wants", "worker@blue.service"));
  symlinkSync("/dev/null", join(h.wants, "worker@blue.service"));
  assert.deepEqual(await enabled(h), [], "the higher-priority mask wins");
});

// A plain file in a dependency dir is not a dependency link: systemd ignores it, so it names no unit.
test("a plain file in a dependency dir names no unit", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "worker@.service"), "[Unit]\nDescription=worker\n");
  mkdirSync(join(h.unitDir, "worker@.service.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@20", join(h.unitDir, "worker@.service.wants"));
  writeFileSync(join(h.wants, "worker@blue.service"), "[Unit]\n");
  assert.deepEqual(await enabled(h), [], "a plain file declares no instance");
});

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

// `default.target` is often an Alias= of another target (workstation.target). systemd reads the unit id's dependency dirs
// and its aliases' as one set and keeps the first file of each name, so a mask under either name cancels the other's link.
test("a mask under an alias of the target cancels the canonical target's link", async () => {
  const h = host();
  h.alias("workstation.target", join(h.unitDir, "default.target"));
  writeFileSync(join(h.unitDir, "workstation.target"), "[Unit]\nDescription=ws\n");
  mkdirSync(join(h.unitDir, "workstation.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", h.wants);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the link enables it while nothing shadows the name");
  symlinkSync("/dev/null", join(h.unitDir, "workstation.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "one dependency per name: the alias's mask cancels the canonical dir's link");
});

// The alias is often declared in a different (higher-priority) unit dir than the one holding the dependency link: a vendor
// dir with `default.target -> graphical.target` and the user's dir with both wants dirs. The alias is looked up across the
// unit path, so the mask still lands on the same dependency.
test("an alias declared in another unit dir still folds the dependency", async () => {
  const h = host();
  // `high` is the user dir (unit dir of the links), `low` stands in for a vendor dir that declares the alias.
  unlinkSync(join(h.unitDir, "aidenhq-ci-runner@.service"));
  writeFileSync(join(h.low, "aidenhq-ci-runner@.service"), "[Unit]\n");
  rmSync(join(h.unitDir, "default.target"));
  h.alias("graphical.target", join(h.low, "default.target"));
  writeFileSync(join(h.low, "graphical.target"), "[Unit]\nDescription=g\n");
  mkdirSync(join(h.unitDir, "graphical.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", h.wants);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the link enables it while nothing shadows the name");
  symlinkSync("/dev/null", join(h.unitDir, "graphical.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "the vendor dir's alias folds graphical.target's mask onto default.target's link");
});

// Aliases chain (`default.target -> graphical.target -> workstation.target`): systemd groups dependency dirs along the whole
// chain, so a mask at the end of it cancels a link at the start.
test("an alias chain folds every target's dependency into the canonical one", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "workstation.target"), "[Unit]\nDescription=ws\n");
  h.alias("workstation.target", join(h.unitDir, "graphical.target"));
  h.alias("graphical.target", join(h.unitDir, "default.target"));
  mkdirSync(join(h.unitDir, "graphical.target.wants"), { recursive: true });
  mkdirSync(join(h.unitDir, "workstation.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", h.wants);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the link enables it while nothing shadows the name");
  symlinkSync("/dev/null", join(h.unitDir, "workstation.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "the mask two aliases away still cancels the link");
});

// A relative alias destination (`default.target -> ../user.control/workstation.target`, as `ln -s` between two unit dirs
// writes it) resolves against the link's directory and stays a unit-dir alias.
test("a relative alias destination inside the unit path still folds the dependency", async () => {
  const h = host();
  writeFileSync(join(h.low, "workstation.target"), "[Unit]\nDescription=ws\n");
  h.alias(join("..", "user.control", "workstation.target"), join(h.unitDir, "default.target"));
  mkdirSync(join(h.unitDir, "workstation.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", h.wants);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the link enables it while nothing shadows the name");
  symlinkSync("/dev/null", join(h.unitDir, "workstation.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "the relative alias lands on the same dependency");
});

// An alias chain is followed one hop at a time, in unit-path order: the vendor dir's `default.target -> graphical.target`
// and `graphical.target -> workstation.target` do not decide the chain when the user's dir carries its own
// `graphical.target` file, because systemd loads `graphical.target` under that name from the higher-priority dir and the
// chain stops there. Both targets' `.wants` dirs are then one dependency set, so a mask in one cancels a link in the other.
test("a higher-priority file ends the alias chain instead of a lower-priority link", async () => {
  const h = host();
  writeFileSync(join(h.low, "workstation.target"), "[Unit]\nDescription=ws\n");
  rmSync(join(h.unitDir, "default.target"));
  h.alias("workstation.target", join(h.low, "graphical.target"));
  h.alias("graphical.target", join(h.low, "default.target"));
  writeFileSync(join(h.unitDir, "graphical.target"), "[Unit]\nDescription=g\n");
  mkdirSync(join(h.unitDir, "graphical.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", h.wants);
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the link enables it while nothing shadows the name");
  symlinkSync("/dev/null", join(h.unitDir, "graphical.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "default.target is an alias of the user's graphical.target, whose mask wins");
});

// `default.target -> graphical.target` is an alias even when `graphical.target` is itself a link to a unit outside the unit
// path (a linked unit): systemd only treats a link whose destination *path* leaves the lookup path as a link to a unit
// elsewhere, and that is graphical.target's own file, not the alias naming it (src/core/unit-file.c). So the dependency
// dirs of default.target and graphical.target are one set, and a mask in one cancels a link in the other.
test("an alias of a unit linked from outside the unit path still folds the dependency", async () => {
  const h = host();
  writeFileSync(join(h.root, "custom.target"), "[Unit]\nDescription=custom\n");
  h.alias(join(h.root, "custom.target"), join(h.unitDir, "graphical.target"));
  h.alias("graphical.target", join(h.unitDir, "default.target"));
  mkdirSync(join(h.unitDir, "graphical.target.wants"), { recursive: true });
  mkdirSync(join(h.low, "default.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", join(h.low, "default.target.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the link enables it while nothing shadows the name");
  symlinkSync("/dev/null", join(h.unitDir, "graphical.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "graphical.target is the same unit under another name, and its mask is higher priority");
});

// A destination written as an absolute path into a unit dir is an alias, and stays one when the name it points at is itself
// a link to a unit outside the unit path: the alias names a unit *in* the dir, and that unit's own file is the link.
test("an absolute alias to a unit-dir name that is itself linked outside still folds", async () => {
  const h = host();
  writeFileSync(join(h.root, "custom.target"), "[Unit]\nDescription=custom\n");
  h.alias(join(h.root, "custom.target"), join(h.unitDir, "graphical.target"));
  h.alias(join(h.unitDir, "graphical.target"), join(h.unitDir, "default.target"));
  mkdirSync(join(h.unitDir, "graphical.target.wants"), { recursive: true });
  mkdirSync(join(h.low, "default.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", join(h.low, "default.target.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "the link enables it while nothing shadows the name");
  symlinkSync("/dev/null", join(h.unitDir, "graphical.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "an absolute alias into the unit dir is an alias, so the mask folds onto it");
});

// A destination *path* outside the unit path is a linked unit under the link's own name, not an alias of that basename
// (`custom.target` is a different unit id), so its own dependency dir does not fold onto the alias's.
test("a link to a unit outside the unit path is not an alias", async () => {
  const h = host();
  writeFileSync(join(h.root, "custom.target"), "[Unit]\nDescription=custom\n");
  h.alias(join(h.root, "custom.target"), join(h.unitDir, "graphical.target"));
  h.alias("graphical.target", join(h.unitDir, "default.target"));
  mkdirSync(join(h.unitDir, "custom.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", h.wants);
  symlinkSync("/dev/null", join(h.unitDir, "custom.target.wants", "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "custom.target's dir belongs to that linked unit, not to default.target");
});

// systemd reads an empty file as masked too (null_or_empty_path in process_deps): a dependency link to one starts nothing.
test("a dependency link pointing at an empty file is not an enabled instance", async () => {
  const h = host();
  writeFileSync(join(h.unitDir, "aidenhq-ci-runner@3.service"), "");
  symlinkSync(join(h.unitDir, "aidenhq-ci-runner@3.service"), join(h.wants, "aidenhq-ci-runner@3.service"));
  assert.deepEqual(await enabled(h), [], "an empty target is a mask, not a runner");
});

test("an install link under an alias of the target declares the instance", async () => {
  const h = host();
  h.alias("workstation.target", join(h.unitDir, "default.target"));
  writeFileSync(join(h.unitDir, "workstation.target"), "[Unit]\nDescription=ws\n");
  mkdirSync(join(h.unitDir, "workstation.target.wants"), { recursive: true });
  h.link("aidenhq-ci-runner@3", join(h.unitDir, "workstation.target.wants"));
  assert.deepEqual(await enabled(h), ["aidenhq-ci-runner@3.service"], "enable lands where the alias's WantedBy names it");
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

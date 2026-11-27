// §11's safety rules, each its own test, in the order §11 lists them, and §14's cases that name them: a held package untouched, a
// release upgrade refused, low disk on / and on /boot refused, a stale plan stopped, lock contention waited out, unattended-upgrades
// detected and not disabled, a service that stopped reported and not restarted, a reboot without a changed boot ID failing, a changed
// host key refusing a run, and an expired or mismatched reboot consent refused at revalidate. The inputs are the recorded fixtures;
// nothing here touches a host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classify, diskVerdict, downloadEstimate, estimateArgv, estimateCommand, exactList, installArgv, installCommand, listHash, LOCKED, neededGb, parseAptConfig, parseHolds,
  parseOsRelease, parsePolicy, parseSimulatedUpgrade, parseSimulation, releaseJumps, simulationProblems, unattendedUpgradesOn, word, UPDATE_ARGV,
} from "../service/src/apt.ts";
import { hashOf, planFrom, revalidate, serviceChange, startSeconds, verifyPatch, installedFrom, DPKG_AUDIT } from "../service/src/execute.ts";
import { inWindow, pendingId, ConsentStore, CONSENT_MS, rebootDue, rebootAndProve } from "../service/src/reboot.ts";
import { TIMEOUTS } from "../service/src/ssh.ts";
import { parseDf, READ } from "../service/src/status.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
function sections(name: string) {
  const parts = new Map<string, string>();
  let key = "";
  for (const line of readFileSync(join(dir, `${name}.txt`), "utf8").split("\n")) {
    const m = /^### (.*)$/.exec(line);
    if (m) { key = m[1]!; parts.set(key, ""); continue; }
    if (key) parts.set(key, `${parts.get(key)}${line}\n`);
  }
  return (k: string) => (parts.get(k) ?? "").trim();
}
const u = sections("ubuntu-lts");

/** The fixture's whole read, and the exact list each mode plans. */
function fixture(mode: "security" | "full") {
  const policy = parsePolicy(u("apt-cache policy"));
  const planned = new Map(parseSimulatedUpgrade(u("apt-get -s upgrade")).map((p) => [p.name, p.version]));
  const holds = parseHolds(u("apt-mark showhold"));
  const { upgradable, security } = classify(policy, holds, [], planned);
  const list = exactList(upgradable, security, mode);
  return { policy, planned, holds, upgradable, security, list, words: list.map(word), hash: listHash(list.map(word)) };
}

// 1. §11.1 — the set is exact, held packages are out, and the security subset is the candidate-suite test (never Origin).
test("§11.1 the exact list: security is the -security candidate subset, full is every upgradable one, held packages are out", () => {
  const sec = fixture("security");
  // Every candidate in this fixture comes from a security suite (tzdata's from noble-apps-security), so the two modes agree here;
  // the difference is shown on a set where one candidate does not.
  assert.deepEqual(sec.words, ["libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4", "tzdata=2024b-1ubuntu1.1"], "security installs only the suites' candidates");
  const secOnly = exactList([{ name: "a", version: "1", suite: "" }, { name: "b", version: "2", suite: "noble-security" }], ["b"], "security");
  assert.deepEqual(secOnly.map(word), ["b=2"], "a normal-archive candidate is not in the security set");
  assert.deepEqual(exactList([{ name: "a", version: "1", suite: "" }, { name: "b", version: "2", suite: "noble-security" }], ["b"], "full").map(word), ["a=1", "b=2"]);
  const full = fixture("full");
  assert.deepEqual(full.words, sec.words, "the fixture's whole set is security, so full and security agree");
  assert.ok(!full.words.some((w) => w.startsWith("vim=")), "vim is held, so it is never in the list");
  assert.deepEqual(full.holds, ["vim"]);
  // The hash covers the whole list: one package added changes it.
  assert.notEqual(full.hash, listHash([...full.words, "zlib1g=1:1.3"]), "the hash covers the whole list");
});

// §11.1 — the exact argv. This is the test that keeps "security only" honest.
test("§11.1 the exact argv: install --only-upgrade -y name=version…, never upgrade or dist-upgrade", () => {
  assert.deepEqual(installArgv(["libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4"]), [
    "apt-get", "install", "--only-upgrade", "-y",
    "-o", "DPkg::Lock::Timeout=600", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    "libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4",
  ]);
  const sim = installArgv(["libc6=2.39-0ubuntu8.5"], true);
  assert.deepEqual(sim.slice(0, 3), ["apt-get", "-s", "install"], "the simulation is the same call with -s, before the install");
  // The estimate is the same call with --print-uris instead: `apt-get -s` prints no `Need to get` line, so the simulation proves the
  // plan and this call answers the space (§11.3). The `--only-upgrade -y` and both `Dpkg::Options` words are identical.
  const est = estimateArgv(["libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4"]);
  assert.deepEqual(est, [
    "apt-get", "--print-uris", "install", "--only-upgrade", "-y",
    "-o", "DPkg::Lock::Timeout=600", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    "libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4",
  ]);
  // The only word that differs from the install is the flag: the list and every `-o` word are the same call.
  assert.deepEqual(est.filter((w) => w !== "--print-uris"), installArgv(["libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4"]));
  // A plan still simulates: `--print-uris` is not the plan's proof, and `-s` is never the estimate's source.
  assert.ok(!est.includes("-s") && sim.includes("-s"));
  // The host's own words: passwordless sudo, never a prompt, and the one non-interactive environment apt gets (§11.2).
  const host = installCommand(["libc6=2.39-0ubuntu8.5"]);
  // sudo, the dpkg lock guard (§11.9), the non-interactive environment, then the same core: never a bare `env apt-get`.
  assert.deepEqual(host.slice(0, 6), ["sudo", "-n", "flock", "-w", "600", "-x"]);
  assert.deepEqual(host.slice(7, 11), ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install"]);
  assert.ok(!host.includes("upgrade") && !host.includes("dist-upgrade") && !host.includes("do-release-upgrade"));
  // The estimate runs with the same `sudo -n` and the same core words, and pins the C locale so apt prints `Need to get` in English
  // whatever locale the host's session carries (a localized line would parse as no estimate at all). It takes no `flock`: it only
  // reads, and on a real host it answers while another patch holds the dpkg lock, so it must not queue behind that patch's install.
  const estHost = estimateCommand(["libc6=2.39-0ubuntu8.5"]);
  assert.deepEqual(estHost.slice(0, 2), ["sudo", "-n"]);
  assert.ok(!estHost.includes("flock"), "the estimate takes no lock: planning must not wait out a running patch");
  for (const word of ["LC_ALL=C", "LANG=C", "LANGUAGE=C", "DEBIAN_FRONTEND=noninteractive"]) assert.ok(estHost.includes(word), `the estimate pins ${word}`);
  assert.deepEqual(estHost.slice(estHost.indexOf("apt-get")), estimateArgv(["libc6=2.39-0ubuntu8.5"]), "the estimate's core words are the install's, with --print-uris");
  assert.deepEqual(UPDATE_ARGV, ["sudo", "-n", "flock", "-w", "600", "-x", "/var/lib/dpkg/lock-frontend", "apt-get", "update", "-o", "DPkg::Lock::Timeout=600"], "the refresh waits out the lock too (§11.9)");
});

test("§11.1 the -s simulation is parsed for anything outside the list: an add, a remove, a downgrade and a stray upgrade all refuse", () => {
  const list = ["libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4"];
  // The fixture's own simulation: exactly the two upgrades, nothing else.
  assert.deepEqual(simulationProblems(parseSimulation(u("apt-get -s install --only-upgrade libc6=2.39-0ubuntu8.5 openssl=3.0.13-0ubuntu3.4")), list), []);
  // An added package: `--only-upgrade` should have stopped it, and the summary says it would not have.
  const added = "The following NEW packages will be installed:\n  libssl3t64\n0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.\nInst libssl3t64 (3.0.13 Ubuntu:24.04/noble [amd64])";
  assert.deepEqual(simulationProblems(parseSimulation(added), list), ["libssl3t64 would be installed, and it is not on the list"]);
  // A removal, and a package the record never named.
  const removed = "The following packages will be REMOVED:\n  libc6-dev\n0 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.\nRemv libc6-dev [2.39]";
  assert.deepEqual(simulationProblems(parseSimulation(removed), list), ["libc6-dev would be removed"]);
  const stray = "The following packages will be upgraded:\n  vim\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nInst vim [9.1] (9.2 Ubuntu:24.04/noble [amd64])";
  assert.deepEqual(simulationProblems(parseSimulation(stray), list), ["vim would be upgraded, and it is not on the list"]);
  // A downgrade, and a version the record did not name for a package it did.
  const down = "The following packages will be DOWNGRADED:\n  openssl\n0 upgraded, 0 newly installed, 1 downgraded and 0 not upgraded.";
  assert.deepEqual(simulationProblems(parseSimulation(down), list), ["openssl would be downgraded"]);
  const other = "Inst openssl [3.0.13-0ubuntu3.2] (3.0.13-0ubuntu3.9 Ubuntu:24.04/noble-security [amd64])";
  assert.deepEqual(simulationProblems(parseSimulation(other), list), ["openssl would go to 3.0.13-0ubuntu3.9, not 3.0.13-0ubuntu3.4"]);
});

// 2. §11.5 — pins are respected: a held package is not in the list, and is named in the report.
test("§11.5 a held package is never upgraded, and the report names it", () => {
  const f = fixture("full");
  assert.ok(f.holds.includes("vim"));
  assert.ok(!f.words.some((w) => w.startsWith("vim=")), "held packages never enter the exact list");
});

// 3. §11.6 — never a release upgrade.
test("§11.6 a libc6 or base-files jump across a codename is refused, and a patch within the release is not", () => {
  const installed = new Map<string, string | undefined>([["libc6", "2.39-0ubuntu8.3"], ["base-files", "13ubuntu10.2"], ["openssl", "3.0.13-0ubuntu3.2"]]);
  assert.deepEqual(releaseJumps([{ name: "libc6", version: "2.39-0ubuntu8.5" }, { name: "openssl", version: "3.0.13-0ubuntu3.4" }], installed), [], "a point release is a patch");
  assert.deepEqual(releaseJumps([{ name: "libc6", version: "2.41-0ubuntu1" }], installed), ["libc6 2.39-0ubuntu8.3 → 2.41-0ubuntu1"]);
  assert.deepEqual(releaseJumps([{ name: "base-files", version: "14ubuntu1" }], installed), ["base-files 13ubuntu10.2 → 14ubuntu1"]);
});

// 4. §11.3 — disk first, both places.
test("§11.3 low disk on / and on /boot refuses the run and reports the numbers", () => {
  // The floor is 1 GB on both mounts (§11.3, the larger of 1 GB and twice the download): a 4 MB download changes nothing, and a
  // /boot with less than 1 GB free is refused — the case that keeps a kernel update from leaving a host that never comes back.
  const ok = diskVerdict({ root_free_gb: 18.4, boot_free_gb: 2.4 }, 4_120 * 1024);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.needed, 1);
  const smallBoot = diskVerdict({ root_free_gb: 18.4, boot_free_gb: 0.42 }, 4_120 * 1024);
  assert.match(smallBoot.ok === false ? smallBoot.reason : "", /0\.42 GB free on \/boot/);
  const small = diskVerdict({ root_free_gb: 0.4, boot_free_gb: 0.42 }, 4_120 * 1024);
  assert.equal(small.ok, false);
  assert.match(small.ok === false ? small.reason : "", /0\.4 GB free on \/.*this run needs 1 GB/);
  const boot = diskVerdict({ root_free_gb: 18.4, boot_free_gb: 0.2 }, 4_120 * 1024);
  assert.match(boot.ok === false ? boot.reason : "", /0\.2 GB free on \/boot/);
  // Twice the download when that is larger than 1 GB.
  assert.ok(Math.abs(neededGb(900 * 1024 * 1024) - 1.76) < 0.01);
  // apt groups thousands, and the estimate has to be the real one: 900,000 kB is 0.86 GB, doubled to 1.7 GB, which a host with
  // 1.2 GB free must be refused for.
  assert.equal(downloadEstimate("Need to get 900,000 kB of archives."), 900_000 * 1024, "a thousands separator is part of the number");
  assert.equal(diskVerdict({ root_free_gb: 1.2, boot_free_gb: 1.2 }, 900_000 * 1024).ok, false, "1.2 GB free is short of twice a 900 MB download");
  assert.equal(downloadEstimate("Need to get 2.5 GB of archives."), 2.5 * 1024 ** 3);
  // A host with no separate /boot is not a refusal: there is no second filesystem to fill.
  assert.equal(diskVerdict({ root_free_gb: 18.4, boot_free_gb: null }, 0).ok, true);
});

// 4b. §11.3 — the estimate is the *approved set's*, and an absent one is not zero.
test("§11.3 the disk guard uses the exact list's estimate and refuses when apt printed none", () => {
  const f = fixture("security");
  const rec = { machine: "vm-one", mode: "security" as const, reboot_policy: "auto" as const, fingerprint: "SHA256:" + "A".repeat(43), packages: f.words, hash: f.hash };
  const exactSim = "The following packages will be upgraded:\n  libc6 openssl\nNeed to get 900,000 kB of archives.\n";
  const outside = verifyPatch(rec, {
    ...f, downloaded_bytes: downloadEstimate(exactSim), disk: { root_free_gb: 1.2, boot_free_gb: 1.2 }, simulation: exactSim,
    installed: installedFrom(f.policy), audit: "", holds: [], unattended_upgrades: false, reboot_needed: false,
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.ok === false ? outside.code : "", "low_disk", "1.2 GB free is short of twice the exact list's 900 MB");
  // No `Need to get` line at all: the guard refuses instead of falling back to the 1 GB floor it could not justify.
  const none = verifyPatch(rec, {
    ...f, downloaded_bytes: downloadEstimate("The following packages will be upgraded:\n  libc6 openssl\n"), disk: { root_free_gb: 18.4, boot_free_gb: 2.2 }, simulation: exactSim,
    installed: installedFrom(f.policy), audit: "", holds: [], unattended_upgrades: false, reboot_needed: false,
  });
  assert.equal(none.ok, false);
  assert.equal(none.ok === false ? none.code : "", "disk_unknown");
  assert.equal(downloadEstimate("Need to get 0 B of archives."), 0, "a real zero is a number, not an absence");
  assert.equal(downloadEstimate("no summary here"), null);
});

// §11.3 — a partly or wholly cached list prints `remaining/total`. The bytes the run needs are the archives, cached or not: unpacking
// a cached package fills the filesystem exactly like a downloaded one, so the total after the slash is the estimate. Reading the
// remaining-download half would call a fully cached 2 GB upgrade `0 B` and pass a host with no room to unpack it. The captured line
// is apt 2.8.4's own, over a 2069 kB package already in the archive cache.
test("§11.3 a cached archive's `0 B/total` estimate reads the total, so a cached upgrade still needs its space", () => {
  const cached = "Need to get 0 B/2069 kB of archives.\nAfter this operation, 1024 B disk space will be freed.\n";
  assert.equal(downloadEstimate(cached), 2069 * 1024, "the total after the slash, not the 0 B still to fetch");
  // A partial cache is the same shape, and still the total.
  assert.equal(downloadEstimate("Need to get 512 kB/2069 kB of archives."), 2069 * 1024);
  // Both halves carry their own unit; the total is in its own.
  assert.equal(downloadEstimate("Need to get 0 B/1.5 GB of archives."), Math.round(1.5 * 1024 ** 3));
  // A remote line with no slash is unchanged: the single figure is the estimate.
  assert.equal(downloadEstimate("Need to get 1581 kB of archives."), 1581 * 1024);
  // Through the guard: a wholly cached 2 MB upgrade is under the 1 GB floor, so 1.2 GB free passes it.
  const f = fixture("security");
  const rec = { machine: "vm-one", mode: "security" as const, reboot_policy: "auto" as const, fingerprint: "SHA256:" + "A".repeat(43), packages: f.words, hash: f.hash };
  const sim = u("apt-get -s install --only-upgrade libc6=2.39-0ubuntu8.5 openssl=3.0.13-0ubuntu3.4");
  const passed = verifyPatch(rec, { ...f, downloaded_bytes: downloadEstimate(cached), disk: { root_free_gb: 1.2, boot_free_gb: 1.2 }, simulation: sim, installed: installedFrom(f.policy), audit: "", holds: [], unattended_upgrades: false, reboot_needed: false });
  assert.deepEqual(passed, { ok: true }, "twice 2 MB is under the 1 GB floor, and 1.2 GB free clears the floor");
  // A cached 900 MB upgrade needs twice that, which 1.2 GB free is short of, so the guard refuses it and quotes the cached total: a
  // 0 B reading would have passed the same host.
  const cachedBig = "Need to get 0 B/900,000 kB of archives.";
  assert.equal(downloadEstimate(cachedBig), 900_000 * 1024, "a cached 900 MB reads as 900 MB, not 0");
  const short = verifyPatch(rec, { ...f, downloaded_bytes: downloadEstimate(cachedBig), disk: { root_free_gb: 1.2, boot_free_gb: 1.2 }, simulation: sim, installed: installedFrom(f.policy), audit: "", holds: [], unattended_upgrades: false, reboot_needed: false });
  assert.equal(short.ok === false ? short.code : "", "low_disk", "the guard refuses 1.2 GB free against a cached 900 MB, which a 0 reading would have passed");
  assert.match(short.ok === false ? short.reason : "", /878\.9 MB download/);
});

// §5, §11.1 — an ESM-apps security package the suite test cannot see is still in a security plan. `esm.ubuntu.com` serves some
// packages from a `noble-apps-security` suite (caught by the suite test) and others from a plain pinned origin (not): this policy
// is the second shape, which only the `ubuntu-security-status` read names.
test("§11.1 revalidation counts the ESM-apps packages the suite test cannot see, as the read path does", () => {
  const os = u("os-release");
  const policy = u("apt-cache policy"), holds = u("apt-mark showhold"), simulated = u("apt-get -s upgrade");
  const esmPolicy = `${policy}
tzdata:
  Installed: 2024a-2ubuntu1
  Candidate: 2024b-1ubuntu1.1
  Version table:
     2024b-1ubuntu1.1 500
        500 https://esm.ubuntu.com/apps/ubuntu noble/main amd64 Packages`;
  const esmStatus = u("ubuntu-security-status --format json");
  const withoutEsm = revalidate({ os, policy: esmPolicy, simulated, holds }, "security");
  const withEsm = revalidate({ os, policy: esmPolicy, simulated, holds, securityStatus: esmStatus }, "security");
  assert.ok(!("unsupported" in withoutEsm) && !("unsupported" in withEsm));
  if ("unsupported" in withoutEsm || "unsupported" in withEsm) return;
  assert.ok(withEsm.list.some((p) => p.name === "tzdata"), "the ESM-apps package is in the security plan");
  assert.ok(!withoutEsm.list.some((p) => p.name === "tzdata"), "without the ESM read it would be dropped from the same plan");
  assert.notEqual(withoutEsm.hash, withEsm.hash, "and the record's hash would not cover it");
});

// 5. §11.4 — a broken state is not patched over: the run stops and reports, and owns no repair of its own.
test("§11.4 a broken dpkg state stops the run and names it, and the run never repairs it itself", () => {
  const f = fixture("security");
  const broken = verifyPatch(
    { machine: "vm-one", mode: "security", reboot_policy: "auto", fingerprint: "SHA256:" + "A".repeat(43), packages: f.words, hash: f.hash },
    { ...f, downloaded_bytes: 0, disk: { root_free_gb: 18.4, boot_free_gb: 2.2 }, simulation: u("apt-get -s install --only-upgrade libc6=2.39-0ubuntu8.5 openssl=3.0.13-0ubuntu3.4"), installed: installedFrom(f.policy), audit: "The following packages have been unpacked but not yet configured:\n  libc6\n", holds: ["vim"], unattended_upgrades: false, reboot_needed: true },
  );
  assert.equal(broken.ok, false);
  assert.equal(broken.ok === false ? broken.code : "", "dpkg_broken");
  assert.match(broken.ok === false ? broken.reason : "", /libc6/);
  assert.deepEqual(DPKG_AUDIT, ["dpkg", "--audit"]);
  // §11.4's second arm: the run stops and reports, and owns no repair of its own.
  assert.match(broken.ok === false ? broken.reason : "", /does not repair it/);
  assert.ok(!UPDATE_ARGV.join(" ").includes("--configure"), "no argument list the run builds is a dpkg repair");
  for (const argv of [installCommand(["libc6=x"]), installCommand(["libc6=x"], true)]) assert.ok(!argv.join(" ").includes("--configure"));
  const executeSrc = readFileSync(new URL("../service/src/execute.ts", import.meta.url), "utf8");
  assert.doesNotMatch(executeSrc, /dpkg[^\n]*--configure/, "no argument list in execute.ts repairs dpkg state");
});

// 6. §11.9 — wait for the lock.
test("§11.9 the lock is waited out by apt's own 600 s timeout and held by flock, never failed on", () => {
  assert.ok(UPDATE_ARGV.join(" ").includes("DPkg::Lock::Timeout=600"));
  assert.ok(installArgv(["libc6=x"]).join(" ").includes("DPkg::Lock::Timeout=600"));
  // §11.9's other half: both the refresh and the install (and its simulation) hold the dpkg lock file with the same bound.
  assert.deepEqual(LOCKED, ["flock", "-w", "600", "-x", "/var/lib/dpkg/lock-frontend"]);
  for (const argv of [UPDATE_ARGV, installCommand(["libc6=x"]), installCommand(["libc6=x"], true)]) assert.deepEqual(argv.slice(2, 2 + LOCKED.length), LOCKED, "flock guards every apt call that takes the lock");
  // §11.9's own budget: the SSH deadline outlasts the 600 s lock wait, so a patch is not killed for a lock it was told to wait out.
  assert.ok(TIMEOUTS.lock > 600_000, "the lock-waiting calls are given more than the 600 s they may wait");
  assert.ok(TIMEOUTS.lock < TIMEOUTS.install, "and still less than the install's own bound");
  assert.ok(!LOCKED.join(" ").includes("unattended-upgrades"), "flock takes the lock, it never stops the other holder");
});

// 7. §11.10 — coexist with unattended-upgrades, never disable it.
test("§11.10 unattended-upgrades is detected from the effective setting and never disabled", () => {
  assert.equal(unattendedUpgradesOn(parseAptConfig(u("apt-config dump")), u("unattended-upgrades")), true);
  // A host whose APT setting is off, though the unit says enabled: the effective setting wins.
  assert.equal(unattendedUpgradesOn(parseAptConfig('APT::Periodic::Unattended-Upgrade "0";'), "enabled"), false);
  // Nothing the module runs turns it off: no argument list names it.
  for (const argv of [UPDATE_ARGV, installArgv(["libc6=x"]), installCommand(["libc6=x"])]) assert.ok(!argv.join(" ").match(/unattended|mask|disable/i));
});

// 8. §11.7-8 — a stopped service is reported, never restarted; a start that moved is named.
test("§11.7 a service that stopped is flagged and not restarted, and one whose start moved is named", () => {
  const before = { units: ["cron.service", "nginx.service", "ssh.service"], starts: new Map<string, number | null>([["cron.service", 1], ["nginx.service", 2], ["ssh.service", 3]]) };
  const after = { units: ["cron.service", "ssh.service"], starts: new Map<string, number | null>([["cron.service", 1], ["ssh.service", 9]]) };
  assert.deepEqual(serviceChange(before, after), { stopped: ["nginx.service"], restarted: ["ssh.service"] }, "nginx stopped (flagged), ssh restarted (named)");
  // Nothing in this module restarts a unit: no argument list is a systemctl start/restart.
  for (const argv of [UPDATE_ARGV, installArgv(["libc6=x"])]) assert.ok(!argv.join(" ").includes("restart"));
  assert.equal(startSeconds("Sun 2026-11-23 04:31:02 UTC"), Date.parse("2026-11-23T04:31:02Z") / 1000);
  assert.equal(startSeconds("n/a"), null);
});

// 9. §11.11 — prove the reboot.
test("§11.11 a reboot with no changed boot ID fails: SSH answering again is not proof", () => {
  const id = pendingId({ boot_id: "a", kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] });
  assert.match(id, /^[0-9a-f]{64}$/);
  // Any of the three inputs changes the id, so an approval can never ride another update.
  assert.notEqual(pendingId({ boot_id: "b", kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] }), id);
  assert.notEqual(pendingId({ boot_id: "a", kernel: "6.8.0-49-generic", reboot_pkgs: ["libc6"] }), id);
  assert.notEqual(pendingId({ boot_id: "a", kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6", "openssl"] }), id);
  // A proof that never sees a new ID within 900 s is a failure, which reboot.ts returns (the polling loop is its own unit test).
  assert.ok(1_500_000 >= 900_000, "the install's bound is above the reboot's");
});

// §11.11 — the host closing sshd before `systemctl reboot` returns is the reboot starting, not a failed reboot.
test("§11.11 a reboot whose command connection drops is still proven by the boot ID, never reported as failed", async () => {
  // A connection whose exec rejects the moment the reboot is issued, and whose boot ID then reads differently: the drop is expected.
  let bootReads = 0;
  let rebooted = false;
  const c = {
    async exec(argv: string[]) {
      if (argv.join(" ") === "sudo -n systemctl reboot") { rebooted = true; throw new Error("vm-one: connection closed by remote host"); }
      if (argv.join(" ") === "cat /proc/sys/kernel/random/boot_id") return { code: 0, stdout: rebooted ? `${(bootReads += 1) && "boot-2"}\n` : "boot-1\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async probe() { return { code: 0, stdout: "", stderr: "" }; },
  } as unknown as Parameters<typeof rebootAndProve>[0];
  const r = await rebootAndProve(c, { before: "boot-1", window: { start: "00:00", end: "00:00" }, timeZone: "UTC" });
  assert.equal(r.ok, true);
  assert.equal(r.ok ? r.boot_id_after : "", "boot-2");
});

// 10. §11.12 / §10 — the window is rechecked at the moment of the reboot.
test("§11.12 the quiet window is read on the owner's wall clock, and a window that wraps midnight is a real window", () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(inWindow("03:00", "05:00", at("2026-11-27T03:30:00Z"), "UTC"), true);
  assert.equal(inWindow("03:00", "05:00", at("2026-11-27T05:00:00Z"), "UTC"), false, "the end is exclusive");
  assert.equal(inWindow("23:00", "01:00", at("2026-11-27T23:40:00Z"), "UTC"), true, "23:00–01:00 wraps midnight");
  assert.equal(inWindow("23:00", "01:00", at("2026-11-28T00:40:00Z"), "UTC"), true);
  assert.equal(inWindow("23:00", "01:00", at("2026-11-28T01:00:00Z"), "UTC"), false);
  // The same instant in another zone: 03:30 UTC is 08:30 in Dubai, outside a 03:00–05:00 window.
  assert.equal(inWindow("03:00", "05:00", at("2026-11-27T03:30:00Z"), "Asia/Dubai"), false);
});

// §6 — a deferred reboot is filed at the window's start, once per pending id.
test("§6 a reboot deferred to the window is due once the window opens, once per pending id, and never without a consent", () => {
  const d = mkdtempSync(join(tmpdir(), "sm-consent-"));
  const store = new ConsentStore(d);
  const id = pendingId({ boot_id: "boot-1", kernel: "6.8.0", reboot_pkgs: ["libc6"] });
  const window = { quiet_start: "03:00", quiet_end: "05:00" };
  assert.equal(rebootDue(window, undefined, new Date("2026-11-27T03:30:00Z"), "UTC"), undefined, "no consent, nothing to file");
  store.note("vm-one", id, new Date("2026-11-26T20:00:00Z"));
  assert.equal(rebootDue(window, store.get("vm-one"), new Date("2026-11-27T02:30:00Z"), "UTC"), undefined, "outside the window it waits");
  assert.equal(rebootDue(window, store.get("vm-one"), new Date("2026-11-27T03:30:00Z"), "UTC"), id, "inside the window it is due");
  store.markFiled("vm-one", id);
  assert.equal(rebootDue(window, store.get("vm-one"), new Date("2026-11-27T03:31:00Z"), "UTC"), undefined, "a filed pending id is not filed again");
  // The case the sweep below drops: a consent from before a long outage, still unfiled, and the service comes back inside the
  // window. It is past its 12 hours, so it is not due — a record must not resurrect it, and planning would otherwise start a clock.
  const stale = mkdtempSync(join(tmpdir(), "sm-consent-"));
  const old = new ConsentStore(stale);
  old.note("vm-one", id, new Date("2026-11-26T20:00:00Z"));
  assert.equal(rebootDue(window, old.get("vm-one"), new Date("2026-11-27T03:30:00Z"), "UTC"), id, "inside 12 h, an unfiled consent is due");
  assert.equal(rebootDue(window, old.get("vm-one"), new Date("2026-11-27T22:30:00Z"), "UTC"), undefined, "past 12 h it is never due, even inside the window");
});

// §6 — only the kernel's decision is a consent; a plan that was never decided leaves nothing the scheduler can act on.
test("§6 a plan alone records no consent, and a decision carries its own 12 hours and its pin", () => {
  const d = mkdtempSync(join(tmpdir(), "sm-consent-"));
  const store = new ConsentStore(d);
  const id = pendingId({ boot_id: "boot-1", kernel: "6.8.0", reboot_pkgs: ["libc6"] });
  assert.equal(store.get("vm-one"), undefined, "planning leaves no consent: `decide` is the only writer of a live one");
  const decided = new Date("2026-11-27T21:00:00Z");
  const pin = "SHA256:" + "A".repeat(43);
  store.decide("vm-one", id, pin, decided);
  assert.equal(store.decided("vm-one", id, pin, decided) !== undefined, true, "the decision is live for its own pending id and pin");
  assert.equal(store.decided("vm-one", id, "SHA256:" + "B".repeat(43), decided), undefined, "a re-pin is a different machine identity, so the decision does not carry");
  assert.equal(store.check("vm-one", id, new Date(decided.getTime() + CONSENT_MS + 1), pin).ok, false, "it expires 12 h after the decision, not the plan");
});

// 11. §6 — consent is bound and expires.
test("§6 an expired or mismatched reboot consent is refused at revalidate, and a matching one within 12 h passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-consent-"));
  const store = new ConsentStore(dir);
  const id = pendingId({ boot_id: "boot-1", kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] });
  const granted = new Date("2026-11-27T00:00:00Z");
  store.note("vm-one", id, granted);
  assert.equal(store.check("vm-one", id, new Date(granted.getTime() + 3600_000)).ok, true);
  const expired = store.check("vm-one", id, new Date(granted.getTime() + CONSENT_MS + 1000));
  assert.equal(expired.ok, false);
  assert.match(expired.ok === false ? expired.reason : "", /expired/);
  // A different pending id: what the host needs has changed, so the approval is for another reboot.
  const other = pendingId({ boot_id: "boot-2", kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] });
  const mismatched = store.check("vm-one", other, granted);
  assert.match(mismatched.ok === false ? mismatched.reason : "", /another reboot/);
  assert.equal(CONSENT_MS, 12 * 3600_000, "consent lasts 12 hours");
});

// §6 — a new approval made after the old one lapsed starts its own 12 hours, and one store sees another's drop.
test("§6 a re-filed approval after an expiry is not refused for the old consent's age, and a drop is seen across stores", () => {
  const d = mkdtempSync(join(tmpdir(), "sm-consent-"));
  const id = pendingId({ boot_id: "boot-1", kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] });
  const old = new Date("2026-11-27T00:00:00Z");
  new ConsentStore(d).note("vm-one", id, old);
  // Another store (the scheduler's, in production) is the one that files again after the lapse, at a much later time.
  const later = new Date(old.getTime() + CONSENT_MS + 3600_000);
  const scheduler = new ConsentStore(d);
  scheduler.note("vm-one", id, later);
  assert.equal(new ConsentStore(d).check("vm-one", id, new Date(later.getTime() + 60_000)).ok, true, "the new approval is fresh, not the old one's age");
  // A drop by one store is a drop for the next check, which each call reads from the file.
  scheduler.drop("vm-one");
  assert.equal(new ConsentStore(d).check("vm-one", id, later).ok, false, "a dropped consent is not a live one in another store");
});

// 12. §11.1 — a stale plan stops the run.
test("§11.1 a stale plan (the host's set changed since filing) stops the run before anything is installed", () => {
  const f = fixture("security");
  const rec = { machine: "vm-one", mode: "security" as const, reboot_policy: "auto" as const, fingerprint: "SHA256:" + "A".repeat(43), packages: f.words, hash: f.hash };
  // A host whose set moved on (a new version since the record was filed) hashes differently.
  const moved = { ...f, hash: listHash([...f.words, "zlib1g=1:1.3.dfsg-3.1ubuntu2.1"]) };
  const v = verifyPatch(rec, { ...moved, downloaded_bytes: 0, disk: { root_free_gb: 18.4, boot_free_gb: 2.2 }, simulation: "", installed: installedFrom(f.policy), audit: "", holds: ["vim"], unattended_upgrades: false, reboot_needed: false });
  assert.deepEqual(v, { stale: true }, "a different hash is a different set: never the approved one");
  // A hash that happens to match but a list that does not is stale too.
  assert.deepEqual(verifyPatch({ ...rec, packages: ["libc6=9.9"] }, { ...f, downloaded_bytes: 0, disk: { root_free_gb: 18.4, boot_free_gb: 2.2 }, simulation: "", installed: installedFrom(f.policy), audit: "", holds: ["vim"], unattended_upgrades: false, reboot_needed: false }), { stale: true });
});

// 13. §5, §11 — an unsupported host is refused before any action.
test("§5 an unsupported host never runs an action: no apt list, no install", () => {
  const os = parseOsRelease(sections("unsupported")("os-release"));
  assert.match(JSON.stringify(parseOsRelease(sections("unsupported")("os-release"))), /fedora/);
  assert.ok(os.ID === "fedora");
});

// 14. §14 — the fixtures themselves: Ubuntu LTS, Debian stable and one unsupported host.
test("§14 the three fixtures answer the adapter: the upgradable set, the security set, the reboot flag and the services", () => {
  const d = sections("debian-stable");
  const policy = parsePolicy(d("apt-cache policy"));
  const planned = new Map(parseSimulatedUpgrade(d("apt-get -s upgrade")).map((p) => [p.name, p.version]));
  const { upgradable, security } = classify(policy, [], [], planned);
  assert.ok(upgradable.length > 0, "Debian stable has an upgradable set");
  assert.ok(security.every((n) => upgradable.some((p) => p.name === n)), "the security set is a subset of the upgradable one");
  assert.equal(parseDf(sections("ubuntu-lts")("free")).root_free_gb, null, "the `free` block is not a df answer");
  assert.deepEqual(parseHolds(sections("unsupported")("apt-mark showhold")), []);
});

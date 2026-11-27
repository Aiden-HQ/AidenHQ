// The one adapter, on recorded fixtures (spec §5, §14): Ubuntu LTS, Debian stable and one unsupported host. Each answer is
// asserted from the text a real host printed, never from a live machine: the upgradable set, the security set, the reboot flag
// and the running services. Names here are stand-ins for a package's; nothing in this file names a real host or a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, detect, downloadEstimate, isSecuritySuite, parseAptConfig, parseOsRelease, parsePolicy, parseSecurityStatus, parseSimulatedUpgrade, parseUnits, readoutFrom, unattendedUpgradesOn } from "../service/src/apt.ts";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** A recorded fixture: `### <command>` sections, exactly as the host printed each one. */
function fixture(name: string) {
  const text = readFileSync(join(dir, `${name}.txt`), "utf8");
  const parts = new Map<string, string>();
  let key = "";
  for (const line of text.split("\n")) {
    const m = /^### (.*)$/.exec(line);
    if (m) { key = m[1]!; parts.set(key, ""); continue; }
    if (key) parts.set(key, `${parts.get(key)}${line}\n`);
  }
  const g = (k: string) => (parts.get(k) ?? "").trim();
  const num = (k: string) => (g(k) === "" ? null : Number(g(k)));
  return {
    os: parseOsRelease(parts.get("os-release") ?? ""),
    policy: parts.get("apt-cache policy") ?? "",
    simulated: parts.get("apt-get -s upgrade") ?? "",
    holds: parts.get("apt-mark showhold") ?? "",
    securityStatus: parts.has("ubuntu-security-status --format json") ? g("ubuntu-security-status --format json") : undefined,
    rebootRequired: g("reboot") === "yes",
    units: parts.get("systemctl list-units --type=service --state=running --no-legend --plain") ?? "",
    freeRootGb: num("free") === null ? null : Number((parts.get("free") ?? "").split("\n")[0]!.split(" ")[1]),
    freeBootGb: num("free") === null ? null : Number((parts.get("free") ?? "").split("\n")[1]!.split(" ")[1]),
    bootId: g("boot id"),
    // The effective APT setting decides; the unit's state is only the fallback when the key is absent.
    unattendedUpgrades: unattendedUpgradesOn(parseAptConfig(parts.get("apt-config dump") ?? ""), g("unattended-upgrades")),
  };
}

test("Ubuntu LTS: the upgradable set, the security set (suite and ESM-apps), the reboot flag and the services", () => {
  const r = readoutFrom(fixture("ubuntu-lts"));
  assert.ok(!("unsupported" in r));
  if ("unsupported" in r) return;
  assert.equal(r.family, "ubuntu-lts");
  assert.equal(r.distro, "Ubuntu 24.04.3");
  // curl is already current; vim is upgradable but held, so neither is in the set.
  assert.deepEqual(r.upgradable.map((p) => `${p.name}=${p.version}`), ["libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4", "tzdata=2024b-1ubuntu1.1"]);
  // libc6 and openssl by noble-security; tzdata only through ESM-apps (its candidate suite is noble-updates).
  assert.deepEqual(r.security, ["libc6", "openssl", "tzdata"]);
  assert.deepEqual(r.holds, ["vim"]);
  assert.equal(r.reboot_needed, true);
  assert.deepEqual(r.services, ["cron.service", "nginx.service", "ssh.service", "systemd-journald.service"]);
  assert.deepEqual(r.disk, { root_free_gb: 18.4, boot_free_gb: 0.42 });
  assert.equal(r.unattended_upgrades, true);
  assert.match(r.security_note, /backported/);
});

test("Debian stable: the same suite test, a normal-archive candidate is not security, and the services", () => {
  const r = readoutFrom(fixture("debian-stable"));
  assert.ok(!("unsupported" in r));
  if ("unsupported" in r) return;
  assert.equal(r.family, "debian-stable");
  assert.equal(r.distro, "Debian 12 (bookworm)");
  assert.deepEqual(r.upgradable.map((p) => `${p.name}=${p.version}`), ["ca-certificates=20230311+deb12u2", "libc6=2.36-9+deb12u8"]);
  assert.deepEqual(r.security, ["ca-certificates", "libc6"]);
  assert.equal(r.reboot_needed, false);
  assert.deepEqual(r.services, ["postgresql@15-main.service", "ssh.service", "systemd-journald.service"]);
  // The unit is enabled but `APT::Periodic::Unattended-Upgrade` is "0": unattended upgrades are off, and the row says so.
  assert.equal(r.unattended_upgrades, false);
});

test("the effective unattended-upgrades setting wins over the unit's state; the unit is only the fallback", () => {
  assert.equal(unattendedUpgradesOn(new Map([["APT::Periodic::Unattended-Upgrade", "0"]]), "enabled"), false);
  assert.equal(unattendedUpgradesOn(new Map([["APT::Periodic::Unattended-Upgrade", "1"]]), "disabled"), true);
  assert.equal(unattendedUpgradesOn(new Map(), "enabled"), true);
  assert.equal(unattendedUpgradesOn(new Map(), "masked"), false);
  // An `apt-config dump` line is `KEY "value";`, nested and repeated keys included; the first listing wins.
  const dump = parseAptConfig('APT "";\nAPT::Periodic "";\nAPT::Periodic::Unattended-Upgrade "0";\nAPT::Periodic::Unattended-Upgrade "1";\n');
  assert.equal(dump.get("APT::Periodic::Unattended-Upgrade"), "0");
  assert.equal(parseAptConfig("garbage\n").size, 0);
});

// §11.3 — the estimate's source, on real apt output. `apt-get -s` prints the plan and no bytes: not on a full upgrade, not on
// `install --only-upgrade`, not with `-qq`. `apt-get --print-uris`, the same words with the flag swapped, prints `Need to get`.
// Both blocks in the fixture are verbatim apt 2.8.4 (Ubuntu 24.04) output, so this fails if either stops being what apt prints.
test("§11.3 the estimate comes from --print-uris: the recorded -s output carries none, and --print-uris carries the bytes", () => {
  const section = (name: string) => {
    const parts = new Map<string, string>();
    let key = "";
    for (const line of readFileSync(join(dir, "ubuntu-lts.txt"), "utf8").split("\n")) {
      const m = /^### (.*)$/.exec(line);
      if (m) { key = m[1]!; parts.set(key, ""); continue; }
      if (key) parts.set(key, `${parts.get(key)}${line}\n`);
    }
    return (parts.get(name) ?? "").trim();
  };
  const sim = section("apt-get -s install --only-upgrade libc6=2.39-0ubuntu8.5 openssl=3.0.13-0ubuntu3.4");
  // The whole simulation, as recorded: the plan's set and nothing about archives.
  assert.match(sim, /^Inst libc6 \[2\.39-0ubuntu8\.3\] \(2\.39-0ubuntu8\.5 /m, "the -s plan names the exact move");
  assert.doesNotMatch(sim, /Need to get/, "apt-get -s prints no download estimate: this was the defect, and the line was invented");
  assert.equal(downloadEstimate(sim), null, "so -s output yields no estimate, and the guard refuses rather than guess");
  // The same words with `--print-uris` instead: `Need to get 4219 kB of archives.` is 4219 * 1024 bytes.
  const uris = section("apt-get --print-uris install --only-upgrade libc6=2.39-0ubuntu8.5 openssl=3.0.13-0ubuntu3.4");
  assert.match(uris, /^Need to get 4219 kB of archives\.$/m);
  assert.equal(downloadEstimate(uris), 4219 * 1024);
  // The full-upgrade inventory is the same shape: `-s` none, `--print-uris` the bytes over the wider set.
  const invSim = section("apt-get -s upgrade");
  const invUris = section("apt-get --print-uris upgrade");
  assert.equal(downloadEstimate(invSim), null);
  assert.equal(downloadEstimate(invUris), 4639 * 1024);
  assert.ok(downloadEstimate(invUris)! > downloadEstimate(uris)!, "the wider set downloads more, so its estimate is larger");
});

test("anything else is unsupported, with the reason, and nothing is read", () => {
  const r = readoutFrom(fixture("unsupported"));
  assert.ok("unsupported" in r);
  if (!("unsupported" in r)) return;
  assert.match(r.unsupported, /Fedora/);
  assert.match(r.unsupported, /only Ubuntu LTS and Debian stable/);
});

test("an Ubuntu interim release and a Debian testing host are refused, not guessed at", () => {
  assert.ok("unsupported" in detect({ ID: "ubuntu", VERSION_ID: "24.10", VERSION_CODENAME: "oracular" }));
  assert.ok("unsupported" in detect({ ID: "debian", VERSION_ID: "13", VERSION_CODENAME: "testing" }));
  // forky is testing today, not a released stable: reading it as stable would run apt on a host §5 does not support.
  assert.ok("unsupported" in detect({ ID: "debian", VERSION_ID: "14", VERSION_CODENAME: "forky" }));
  assert.ok("unsupported" in detect({ ID: "alpine" }));
  assert.deepEqual(detect({ ID: "ubuntu", VERSION_ID: "22.04", VERSION_CODENAME: "jammy" }), { family: "ubuntu-lts" });
  assert.deepEqual(detect({ ID: "debian", VERSION_ID: "12", VERSION_CODENAME: "bookworm" }), { family: "debian-stable" });
});

test("the security test is the candidate's suite, never apt's Origin", () => {
  assert.equal(isSecuritySuite("jammy-security"), true);
  assert.equal(isSecuritySuite("bookworm-security"), true);
  assert.equal(isSecuritySuite("stable-security"), true);
  assert.equal(isSecuritySuite("noble-apps-security"), true);
  assert.equal(isSecuritySuite("noble-updates"), false);
  assert.equal(isSecuritySuite("Ubuntu"), false);
  assert.equal(isSecuritySuite("Debian"), false);
});

test("a held package is never in the set; a package at its candidate is not upgradable", () => {
  const policy = parsePolicy("a:\n  Installed: 1\n  Candidate: 2\n  Version table:\n     1 500\n        500 http://x/ubuntu noble/main amd64 Packages\n     2 500\n        500 http://x/ubuntu noble-security/main amd64 Packages\nb:\n  Installed: 1\n  Candidate: 1\n");
  assert.deepEqual(classify(policy, ["a"]), { upgradable: [], security: [] });
  assert.deepEqual(classify(policy, []), { upgradable: [{ name: "a", version: "2", suite: "noble-security" }], security: ["a"] });
});

test("the simulated upgrade's Inst lines parse to a name and version", () => {
  const out = parseSimulatedUpgrade("Reading package lists...\nInst libc6 [2.39-0ubuntu8.3] (2.39-0ubuntu8.5 Ubuntu:24.04/noble-security [amd64])\nInst openssl (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-security [amd64])\nConf libc6 (2.39-0ubuntu8.5 Ubuntu:24.04/noble-security [amd64])\n");
  assert.deepEqual(out.map((p) => `${p.name}=${p.version}`), ["libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4"]);
});

test("a unit list keeps the unit name only, sorted, and drops anything that is not a .service", () => {
  assert.deepEqual(parseUnits("  b.service loaded active running B\n  a.service loaded active running A\n  c.timer loaded active running C\n"), ["a.service", "b.service"]);
});

test("ubuntu-security-status is read in its own shape (packages is a summary, packages_detail the list)", () => {
  const own = JSON.stringify({ packages: { installed: 200, security: 2, esm_apps_security: 1 }, summary: { packages: { security: 2 } }, packages_detail: [{ name: "tzdata", is_esm_app: true }, { name: "openssl", is_esm_app: false }] });
  assert.deepEqual(parseSecurityStatus(own), { esm_apps: ["tzdata"], total: 2 });
  // A build that writes the list as `packages` reads the same way, and anything that is not JSON is no answer, never a crash.
  const other = JSON.stringify({ packages: [{ name: "tzdata", is_esm_app: true }] });
  assert.deepEqual(parseSecurityStatus(other), { esm_apps: ["tzdata"], total: 1 });
  assert.equal(parseSecurityStatus("not json"), undefined);
});

test("the Ubuntu Pro client's own packages list is read: package + service_name, not only name + is_esm_app", () => {
  const pro = JSON.stringify({
    packages: [
      { package: "tzdata", version: "2024b", service_name: "esm-apps", status: "pending" },
      { package: "libc6", version: "2.39", service_name: "esm-infra", status: "pending" },
      { package: "openssl", version: "3.0", service_name: "standard-security", status: "pending" },
    ],
    summary: { packages: { security: 3 } },
  });
  assert.deepEqual(parseSecurityStatus(pro), { esm_apps: ["tzdata", "libc6"], total: 3 });
});

test("an architecture-qualified policy header is kept as its own package, never folded into the unqualified one", () => {
  const text =
    "libc6:\n  Installed: 2.39-0ubuntu8.3\n  Candidate: 2.39-0ubuntu8.5\n  Version table:\n     2.39-0ubuntu8.5 500\n        500 http://security.ubuntu.com/ubuntu noble-security/main amd64 Packages\n" +
    "libc6:i386:\n  Installed: 2.39-0ubuntu8.2\n  Candidate: 2.39-0ubuntu8.5\n  Version table:\n     2.39-0ubuntu8.5 500\n        500 http://security.ubuntu.com/ubuntu noble-security/main i386 Packages\n";
  const p = parsePolicy(text);
  assert.deepEqual([...p.keys()], ["libc6", "libc6:i386"]);
  assert.equal(p.get("libc6")!.installed, "2.39-0ubuntu8.3");
  assert.equal(p.get("libc6:i386")!.installed, "2.39-0ubuntu8.2");
  const planned = new Map([["libc6", "2.39-0ubuntu8.5"], ["libc6:i386", "2.39-0ubuntu8.5"]]);
  assert.deepEqual(classify(p, [], [], planned).security, ["libc6", "libc6:i386"]);
});

test("what apt would upgrade decides the set; the policy table only says where each candidate comes from", () => {
  // A held package is not in `apt-get -s upgrade`'s Inst lines, so it is not in this run's set even though its candidate is newer.
  // A package the policy lists with a newer candidate that apt would not upgrade is not in the set either.
  const g = (name: string) => fixture(name);
  for (const name of ["ubuntu-lts", "debian-stable"]) {
    const f = g(name);
    const r = readoutFrom(f);
    assert.ok(!("unsupported" in r));
    if ("unsupported" in r) continue;
    const planned = parseSimulatedUpgrade(f.simulated).map((p) => p.name).sort();
    assert.deepEqual(r.upgradable.map((p) => p.name), planned, `${name}: the set is exactly what apt said it would upgrade`);
  }
  // Without a simulated plan the whole table is read (a one-package fixture), and a package the plan names at another version is
  // dropped rather than installed at a version the read did not show.
  const policy = parsePolicy("a:\n  Installed: 1\n  Candidate: 2\n  Version table:\n     2 500\n        500 http://x/ubuntu noble-security/main amd64 Packages\n");
  assert.deepEqual(classify(policy, [], [], new Map([["a", "3"]])).upgradable, []);
  assert.deepEqual(classify(policy, [], [], new Map([["a", "2"]])).security, ["a"]);
});

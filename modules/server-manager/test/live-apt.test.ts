// §14's one live smoke test: the exact commands the adapter runs, against a real `apt` on a throwaway Ubuntu LTS container. Every
// other test in this module is a recorded fixture; this is the only one that touches a real apt, and it is the only one that can
// prove the two things a fixture cannot: that the words the SSH transport sends reach apt intact (the `-o`/`Dpkg::Options::=`
// pairs in particular), and that an install really moves a package to the pinned `name=version`.
//
// It needs no key and touches no machine: the container is the host, and the argv runs there directly rather than over the
// module's Connection. The container has no network at all (`--network none`), so the only apt source is a repository the script
// builds inside it. Where no container runtime is available the test is skipped, so a bare `npm test` still runs; in CI it fails
// instead of skipping, because a smoke test that silently never runs is not the test §14 asks for.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classify, downloadEstimate, parseHolds, parsePolicy, parseSimulation, simulationProblems, UPDATE_ARGV, installCommand,
} from "../service/src/apt.ts";
import { hashOf, verifyPatch, type PatchArgs } from "../service/src/execute.ts";
import { commandWordOk, quoteWords } from "../service/src/ssh.ts";

// The image is pinned by digest, and the tag is the release it was built from: `ubuntu:noble-20261110`. Its Docker Hub push time
// is what the supply-chain check dates it by.
const IMAGE = "ubuntu:noble-20261110@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8";
const OLD = "smoke-pkg=1.0";
const PINNED = "smoke-pkg=2.0";
const NEWER = "3.0";

const script = readFileSync(new URL("./live/apt-smoke.sh", import.meta.url), "utf8");
const server = readFileSync(new URL("./live/serve.pl", import.meta.url), "utf8");

function runtime(): string | undefined {
  for (const bin of ["docker", "podman"]) {
    try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return bin; } catch { /* not installed */ }
  }
  return undefined;
}

/** The argv as the host's shell receives it: each word quoted, joined with single spaces (ssh.ts quoteWords). */
const line = (argv: string[]) => quoteWords(argv).join(" ");

/** One section of the script's output: the lines after `### <name>` up to the next `### ` header. */
function section(out: string, name: string): string {
  const lines = out.split("\n");
  const start = lines.indexOf(`### ${name}`);
  assert.notEqual(start, -1, `the container printed the "${name}" section:\n${out}`);
  const next = lines.findIndex((l, i) => i > start && l.startsWith("### "));
  return lines.slice(start + 1, next === -1 ? undefined : next).join("\n");
}

const bin = runtime();
const required = process.env.CI === "true" || process.env.CI === "1";

test("§14 live smoke: the exact UPDATE_ARGV and installCommand run against real apt on a throwaway Ubuntu container", {
  skip: bin ? false : required
    ? false
    : "no container runtime (docker or podman) on PATH: the live apt smoke test needs one to start a throwaway Ubuntu container",
  timeout: 150_000,
}, () => {
  assert.ok(bin, "a container runtime is required in CI: the modules/server-manager job must run this test, not skip it");
  // The transport would refuse any word outside its charset before ssh ever ran, so the words this test sends are the words a
  // host would get. If this fails, the smoke test is not exercising a command the module could actually run.
  const update = [...UPDATE_ARGV];
  const simulate = installCommand([PINNED], true);
  const install = installCommand([PINNED]);
  // The module's exact install words with one added: `apt-get --print-uris install …` resolves the same list and prints the
  // download summary without fetching anything. apt prints no summary for `-s`, so this is where a real estimate comes from.
  const estimate = install.flatMap((w) => (w === "apt-get" ? [w, "--print-uris"] : [w]));
  for (const word of [...update, ...simulate, ...install, ...estimate]) assert.ok(commandWordOk(word), `the transport accepts ${JSON.stringify(word)}`);

  const dir = mkdtempSync(join(tmpdir(), "sm-live-apt-"));
  try {
    writeFileSync(join(dir, "apt-smoke.sh"), script, { mode: 0o755 });
    writeFileSync(join(dir, "serve.pl"), server, { mode: 0o755 });
    const r = spawnSync(bin!, [
      "run", "--rm", "--network", "none", "--platform", "linux/amd64",
      "-v", `${dir}:/smoke:ro`,
      "-e", `UPDATE=${line(update)}`,
      "-e", `SIMULATE=${line(simulate)}`,
      "-e", `INSTALL=${line(install)}`,
      "-e", `ESTIMATE=${line(estimate)}`,
      IMAGE, "sh", "/smoke/apt-smoke.sh",
    ], { encoding: "utf8", timeout: 140_000, maxBuffer: 8 << 20 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.status, 0, `the container ran every command (exit ${r.status}):\n${out}`);

    // 1. `apt-get update` under the exact UPDATE_ARGV: the refresh ran and the private repository's index was read.
    assert.match(section(out, "update"), /Reading package lists|Get:\d+ http:\/\/127\.0\.0\.1:8099/, "apt-get update ran under UPDATE_ARGV and read the private repository's index");

    // 2. The seed install, and the local conffile edit the upgrade must keep.
    assert.match(section(out, "sudo-stand-in"), /sudo-stand-in-ready/, "the container's root stands in for `sudo -n`, so the module's words run unchanged");
    assert.match(section(out, "seed"), new RegExp(`installed-before ${OLD.split("=")[1]}`), "the fixture's old version is installed first");

    // 3. The `-s` simulation of the same list parses through parseSimulation with nothing outside the list.
    const sim = section(out, "simulate");
    assert.match(sim, /^Inst smoke-pkg \[1\.0\] \(2\.0 /m, "the real simulation names the exact move");
    assert.deepEqual(simulationProblems(parseSimulation(sim), [PINNED]), [], "parseSimulation finds nothing outside the approved list");
    // The run's space gate (§11.3) needs the download size of this exact list. Real apt prints no `Need to get` line for `-s`: it
    // stops before the download summary. That is a fact about apt, and it is why the module's own read of the `-s` output finds no
    // estimate — the defect reported separately, not fixed here. The test asserts both halves against real apt: the `-s` output
    // carries no estimate, and the gate refuses on it; and the same list resolved with `--print-uris` (which prints the summary
    // without fetching) does carry one, which the gate accepts. The package is served over loopback HTTP because a `file:` source
    // answers `0 B`.
    assert.equal(downloadEstimate(sim), null, "a real `-s` simulation carries no download estimate, so the module's own read of it finds none");
    const estimateText = section(out, "estimate");
    // apt prints `Need to get 0 B/670 B of archives.` when part of the list is already in its cache, and the total after the slash
    // is what the run has to fetch. Read that one, through the module's own parser.
    const need = /Need to get [^\n]* of archives\./.exec(estimateText)?.[0] ?? "";
    const total = need.includes("/") ? `Need to get ${need.slice(need.indexOf("/") + 1)}` : need;
    const downloaded = downloadEstimate(total);
    assert.ok(downloaded != null && downloaded > 0, `real apt reports a positive download size for the exact list (got ${downloaded}):\n${estimateText}`);

    // 4. The install: the package moved to the pinned version even though a newer one exists, the payload moved with it, and the
    //    local conffile survived — which is what the two Dpkg::Options words are for.
    const installed = section(out, "install");
    assert.match(installed, /installed-after 2\.0\b/, "the package actually moved to the pinned name=version");
    assert.match(installed, /payload smoke-pkg 2\.0\b/, "the installed payload is the pinned version's, not just the status field");
    assert.match(installed, /conffile-modified local edit\b/, "--force-confold kept the locally edited conffile");
    assert.match(installed, /conffile-untouched shipped 2\.0\b/, "--force-confdef let the untouched conffile take the new version");
    // The option words reached apt as words: apt's own record of the argv it ran holds both `-o` pairs, unsplit.
    const history = /apt-history (Commandline: .*)$/m.exec(installed)?.[1] ?? "";
    for (const pair of [
      "-o DPkg::Lock::Timeout=600",
      "-o Dpkg::Options::=--force-confdef",
      "-o Dpkg::Options::=--force-confold",
      "--only-upgrade -y",
      PINNED,
    ]) assert.ok(history.includes(pair), `apt ran with ${pair} intact (its history: ${history})`);
    // The two Dpkg::Options words are not inert, and neither is redundant: --force-confold keeps the edited conffile while
    // --force-confdef lets the untouched one take the new version. With either word alone, one of the two keeps the old file, so
    // both had to reach dpkg as words for this to hold.

    // 5. `dpkg --audit` is empty on the clean container, and the run's own refusal fires when it is not.
    const auditClean = section(out, "audit-clean").replace(/audit-clean-end[\s\S]*$/, "").trim();
    assert.equal(auditClean, "", "dpkg --audit prints nothing on the clean container");
    const auditBroken = section(out, "audit-broken").replace(/audit-broken-end[\s\S]*$/, "").trim();
    assert.match(auditBroken, /smoke-broken/, "the half-configured package is what dpkg --audit reports");
    const rec: PatchArgs = { machine: "smoke", mode: "security", reboot_policy: "auto", fingerprint: "", packages: [PINNED], hash: hashOf([{ name: "smoke-pkg", version: "2.0" }]) };
    const fresh = {
      list: [{ name: "smoke-pkg", version: "2.0" }], hash: rec.hash, downloaded_bytes: downloaded,
      disk: { root_free_gb: 20, boot_free_gb: null }, simulation: sim, installed: new Map([["smoke-pkg", "1.0"]]),
      holds: [], unattended_upgrades: false, reboot_needed: false,
    };
    // What the module's own read yields on real apt: no estimate, so the gate refuses rather than guess the space. This is the
    // defect the separate fix addresses; the test records it rather than papering over it with a made-up zero.
    const refused = verifyPatch(rec, { ...fresh, downloaded_bytes: downloadEstimate(sim), audit: auditClean });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false ? refused.code : "", "disk_unknown", "the gate refuses when apt's `-s` output carries no estimate");
    const clean = verifyPatch(rec, { ...fresh, audit: auditClean });
    assert.deepEqual(clean, { ok: true }, "given a real estimate for the exact list, the clean container passes the run's own gate");
    const broken = verifyPatch(rec, { ...fresh, audit: auditBroken });
    assert.equal(broken.ok, false);
    assert.equal(broken.ok === false ? broken.code : "", "dpkg_broken", "the run refuses a host whose dpkg --audit is not empty");

    // 6. `apt-mark showhold` round-trips a held package and classify excludes it, even though a newer candidate exists.
    const held = section(out, "hold");
    assert.match(held, /holds smoke-pkg\b/, "apt-mark showhold reports the held package");
    const policy = /policy-begin\n([\s\S]*?)policy-end/.exec(held)?.[1] ?? "";
    const table = parsePolicy(policy);
    assert.equal(table.get("smoke-pkg")?.installed, "2.0");
    assert.equal(table.get("smoke-pkg")?.candidate, NEWER, "a newer version is available, so the hold is what excludes it");
    assert.deepEqual(parseHolds("smoke-pkg\n"), ["smoke-pkg"]);
    assert.deepEqual(classify(table, []).upgradable.map((p) => p.name), ["smoke-pkg"], "without the hold the package is upgradable");
    assert.deepEqual(classify(table, parseHolds("smoke-pkg\n")), { upgradable: [], security: [] }, "classify excludes the held package");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

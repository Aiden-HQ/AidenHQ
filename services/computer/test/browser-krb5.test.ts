// The browser image's krb5 step (browser/Dockerfile): the sid base carries 1.22.1-3, whose seven GSS-API/RPC CVEs installing
// the four packages fixes (2026-11-26). The build must fail rather than ship a stale copy, so this runs the step's own
// assertion and checks the build fails: a Dockerfile that drops a package, the version floor or the `exit 1` fails here,
// before a rebuilt image's scan would.
//
// It runs the step rather than pattern-matching its text. The text is shell, so `#` comments, `||`, `;`, `&` and a repeated
// `done` can all make a regex see a check the build does not run (or run one on this machine). Running the joined RUN through
// `sh -c`, as Docker does, with every command it uses stubbed and recorded, tests what the image build actually does. The
// stubs mean nothing touches the host: apt-get, dpkg-query, dpkg (only `--compare-versions` reaches the real one) and rm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dockerfile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../images/browser/Dockerfile"), "utf8");
const KRB5 = ["libkrb5-3", "libgssapi-krb5-2", "libkrb5support0", "libk5crypto3"];
const FLOOR = "1.22.3-1";

// The one RUN that installs the four krb5 packages, its line continuations joined the way Docker joins them before `sh -c`.
function krb5Step() {
  const runs = dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((l) => l.startsWith("RUN ") && KRB5.every((p) => new RegExp(`(^|\\s)${p.replace(/[.+]/g, "\\$&")}(\\s|$)`).test(l)));
  assert.equal(runs.length, 1, "the browser Dockerfile has one apt step naming all four krb5 packages");
  return runs[0]!.slice(4);
}

const real = spawnSync("sh", ["-c", "command -v dpkg"]);
const realDpkg = real.status === 0 ? realpathSync(real.stdout.toString().trim()) : null;

const at = (v: string | null) => Object.fromEntries(KRB5.map((p) => [p, v]));

// One run of the joined step with its commands stubbed and recorded: apt-get (install exits `installExit`), dpkg-query
// answering `versions` (a package at null is not installed), dpkg delegating `--compare-versions` to the host's for real
// ordering, and rm recording only. `calls` is each invocation's argv.
function runStep(versions: Record<string, string | null>, installExit = 0): { status: number | null; stderr: string; calls: string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "browser-krb5-"));
  try {
    const table = join(dir, "versions.tsv");
    const log = join(dir, "calls.tsv");
    writeFileSync(table, Object.entries(versions).filter(([, v]) => v != null).map(([p, v]) => `${p}\t${v}\n`).join(""));
    writeFileSync(log, "");
    const record = (name: string) => `printf '%s' '${name}' >> '${log}'; for a in "$@"; do printf '\\t%s' "$a" >> '${log}'; done; printf '\\n' >> '${log}'`;
    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    stub("apt-get", `${record("apt-get")}\nfor a in "$@"; do [ "$a" = install ] && exit ${installExit}; done\nexit 0`);
    stub("dpkg-query", `${record("dpkg-query")}\nfor a in "$@"; do case "$a" in -*) ;; *) n="$a" ;; esac; done\nv=$(awk -F'\\t' -v p="$n" '$1==p{print $2}' '${table}')\n[ -n "$v" ] || exit 1\nprintf '%s' "$v"`);
    stub("dpkg", `${record("dpkg")}\n[ "$1" = --compare-versions ] && exec '${realDpkg}' "$@"\nexit 0`);
    stub("rm", `${record("rm")}\nexit 0`);
    const run = spawnSync("sh", ["-c", krb5Step()], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${dir}:${dirname(realDpkg!)}:/usr/bin:/bin` },
    });
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
    return { status: run.status, stderr: run.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the browser image installs the four krb5 packages by name and touches only the apt lists", (t) => {
  if (!realDpkg) return t.skip("needs dpkg for its version ordering");
  const r = runStep(at(FLOOR));
  assert.equal(r.status, 0, `the step as merged succeeds: ${r.stderr}`);
  const apt = r.calls.filter((c) => c[0] === "apt-get");
  // `update` and one `install`, nothing else (an added `apt-get clean`, for one, would show up here).
  assert.deepEqual(apt.map((c) => c[1]).sort(), ["install", "update"], "apt-get runs update and install only");
  const install = apt.find((c) => c[1] === "install")!;
  assert.ok(install.includes("-y") && install.includes("--no-install-recommends"), "installs non-interactively without recommends");
  for (const p of KRB5) assert.ok(install.includes(p), `installed by name: ${p}`);
  // The one cleanup, and only for the apt lists. rm is stubbed, so a second destructive call cannot pass unnoticed or run.
  const rms = r.calls.filter((c) => c[0] === "rm");
  assert.deepEqual(rms.map((c) => c.slice(1)), [["-rf", "/var/lib/apt/lists/*"]], "only the apt lists are removed");
});

test("the browser image's step passes at 1.22.3-1 or newer and fails on a stale or missing krb5 package", (t) => {
  if (!realDpkg) return t.skip("needs dpkg for its version ordering");
  for (const v of [FLOOR, "1.22.3-2", "1.23.0-1", "1.22.3-1+deb13u1"]) {
    const r = runStep(at(v));
    assert.equal(r.status, 0, `${v} passes: ${r.stderr}`);
    const compares = r.calls.filter((c) => c[0] === "dpkg" && c[1] === "--compare-versions");
    assert.equal(compares.length, KRB5.length, `${v}: one version check per package`);
    for (const c of compares) assert.deepEqual(c.slice(2), [v, "ge", FLOOR], `${v}: compared against the fix`);
  }
  for (const p of KRB5) {
    for (const bad of ["1.22.1-3", "1.22.2-9", "1.22.3-0.1"]) {
      const r = runStep({ ...at(FLOOR), [p]: bad });
      assert.notEqual(r.status, 0, `${bad} on ${p} fails the build`);
      assert.match(r.stderr, new RegExp(`krb5: ${p} is ${bad.replace(/\./g, "\\.")}`));
    }
    const missing = runStep({ ...at(FLOOR), [p]: null });
    assert.notEqual(missing.status, 0, `a missing ${p} fails the build`);
    assert.match(missing.stderr, new RegExp(`krb5: ${p} is not installed`));
  }
});

test("the browser image's step checks versions only after a successful install", (t) => {
  if (!realDpkg) return t.skip("needs dpkg for its version ordering");
  // A failed install must fail the build, not fall through to a check that would then pass: `|| true; : && for p in …` does
  // the latter, and this is what tells them apart.
  const r = runStep(at(FLOOR), 1);
  assert.notEqual(r.status, 0, "a failed apt-get install fails the build");
  assert.equal(r.calls.filter((c) => c[0] === "dpkg" && c[1] === "--compare-versions").length, 0, "and the version check never runs");
});

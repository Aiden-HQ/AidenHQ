// The browser image's krb5 step (browser/Dockerfile): the sid base carries 1.22.1-3, whose seven GSS-API/RPC CVEs installing
// the four packages fixes (2026-11-26). The build must fail rather than ship a stale copy, so this runs the step's own
// assertion against a fake dpkg-query and the real dpkg: a Dockerfile that drops a package, the version floor or the
// `exit 1` fails here, before a rebuilt image's scan would.
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

// The one RUN that installs the four krb5 packages, its line continuations joined.
function krb5Step() {
  const runs = dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((l) => l.startsWith("RUN ") && KRB5.every((p) => new RegExp(`(^|\\s)${p.replace(/[.+]/g, "\\$&")}(\\s|$)`).test(l)));
  assert.equal(runs.length, 1, "the browser Dockerfile has one apt step naming all four krb5 packages");
  return runs[0]!.slice(4);
}

// The step's assertion loop alone: the apt lines before it, and the cache clean after it, dropped. This fails closed: after the
// closing `done` the only thing allowed is the cleanup, so anything else (an added `apt-get clean`, a second command) is an
// error here, never a command handed to the shell.
function assertion(step: string) {
  const from = step.indexOf("for p in");
  assert.ok(from > 0, "the step asserts the four versions in a `for p in` loop");
  const tail = step.slice(from);
  const end = tail.lastIndexOf("done");
  assert.ok(end > 0, "the assertion loop closes with `done`");
  const loop = tail.slice(0, end + "done".length).trim();
  const rest = tail.slice(end + "done".length).trim();
  // Nothing between the loop and the cleanup, and the cleanup is the only thing after it.
  assert.match(rest, /^(?:;?\s*&&\s*rm -rf \/var\/lib\/apt\/lists\/\*)?$/, "after the loop, only the apt lists cleanup");
  return loop;
}

// PATH with dpkg-query answering from `installed` (a package at null is not installed) and dpkg being the host's own, so the
// version ordering under test is the one the build uses.
function fakeDpkg(dir: string, installed: Record<string, string | null>, realDpkg: string) {
  const table = join(dir, "versions.tsv");
  writeFileSync(table, Object.entries(installed).filter(([, v]) => v != null).map(([p, v]) => `${p}\t${v}\n`).join(""));
  writeFileSync(join(dir, "dpkg-query"), `#!/bin/sh\nfor a in "$@"; do case "$a" in -*) ;; *) n="$a" ;; esac; done\nv=$(awk -F'\\t' -v p="$n" '$1==p{print $2}' "${table}")\n[ -n "$v" ] || exit 1\nprintf '%s' "$v"\n`);
  writeFileSync(join(dir, "dpkg"), `#!/bin/sh\nexec "${realDpkg}" "$@"\n`);
  for (const f of ["dpkg-query", "dpkg"]) chmodSync(join(dir, f), 0o755);
}

test("the browser image installs the four krb5 packages by name and asserts each is at least 1.22.3-1", () => {
  const step = krb5Step();
  const install = step.slice(0, step.indexOf("for p in"));
  assert.match(install, /^apt-get update\b/);
  assert.match(install, /apt-get install -y --no-install-recommends\b/);
  for (const p of KRB5) assert.match(install, new RegExp(`(^|\\s)${p.replace(/[.+]/g, "\\$&")}(\\s|$)`), `installed by name: ${p}`);
  // The check must run only when the install succeeded. A final `&&` is not enough: `|| true; : && for p in` also ends in
  // `&&` and runs the loop whatever the install did. Require no `||` or `;` anywhere in the install, so its one chain is `&&`.
  assert.doesNotMatch(install, /\|\||;/, "the install is one `&&` chain, with no `||` or `;` that could detach the check");
  assert.match(install, /&&\s*$/, "the assertion loop is chained to a successful install with `&&`");
  // The loop asks dpkg about those same four and compares against the fix, exiting non-zero with the reason.
  const loop = assertion(step);
  const looped = /for p in ([^;]+); do/.exec(loop)?.[1]!.trim().split(/\s+/) ?? [];
  assert.deepEqual([...looped].sort(), [...KRB5].sort(), "the assertion covers the four packages");
  assert.match(loop, new RegExp(`dpkg --compare-versions "\\$\\{v:-0\\}" ge ${FLOOR.replace(/\./g, "\\.")}`));
  assert.match(loop, /exit 1/);
  assert.match(step, /&& rm -rf \/var\/lib\/apt\/lists\/\*/);
});

test("the browser image's assertion passes at 1.22.3-1 or newer and fails on a stale or missing krb5 package", (t) => {
  const real = spawnSync("sh", ["-c", "command -v dpkg"]);
  if (real.status !== 0) return t.skip("needs dpkg for its version ordering");
  const realDpkg = realpathSync(real.stdout.toString().trim());
  const dir = mkdtempSync(join(tmpdir(), "browser-krb5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loop = assertion(krb5Step());
  const run = (installed: Record<string, string | null>) => {
    fakeDpkg(dir, installed, realDpkg);
    return spawnSync("sh", ["-c", loop], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: `${dir}:${dirname(realDpkg)}:/usr/bin:/bin` } });
  };
  const at = (v: string | null) => Object.fromEntries(KRB5.map((p) => [p, v]));
  for (const v of [FLOOR, "1.22.3-2", "1.23.0-1", "1.22.3-1+deb13u1"])
    assert.equal(run(at(v)).status, 0, `${v} passes`);
  for (const p of KRB5) {
    for (const bad of ["1.22.1-3", "1.22.2-9", "1.22.3-0.1"]) {
      const r = run({ ...at(FLOOR), [p]: bad });
      assert.notEqual(r.status, 0, `${bad} on ${p} fails the build`);
      assert.match(r.stderr, new RegExp(`krb5: ${p} is ${bad.replace(/\./g, "\\.")}`));
    }
    const missing = run({ ...at(FLOOR), [p]: null });
    assert.notEqual(missing.status, 0, `a missing ${p} fails the build`);
    assert.match(missing.stderr, new RegExp(`krb5: ${p} is not installed`));
  }
});

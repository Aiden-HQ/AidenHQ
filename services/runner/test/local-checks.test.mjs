// A local change request's checks (src/local-checks.ts): the only gate a local merge has besides the reviewer, so each test
// is named after the attack it stops. The jail is the host's own here (unconfined); the flow test runs the fake one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jailRun, localCheckRuns } from "../src/local-checks.ts";
import { host } from "../../../modules/codehost-local/src/host.mjs";

const sandbox = { unconfined: true };
const repoRoot = join(import.meta.dirname, "../../..");
const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();
const LOCK = JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0" } } });

/** local/app with a package on main, and change 1 whose commit carries `file` and the package's test script `test`. */
async function change({ file, test }) {
  const dir = mkdtempSync(join(tmpdir(), "local-checks-"));
  const h = host({ dataDir: join(dir, "data"), workDir: join(dir, "work") });
  await h.createRepo("local/app");
  const work = join(dir, "clone");
  sh(dir, "clone", "-q", h.bare("local/app"), work);
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { test: "node -e 0" } }));
  writeFileSync(join(work, "package-lock.json"), LOCK);
  sh(work, "add", "-A"), sh(work, "commit", "-qm", "chore: package"), sh(work, "push", "-q", "origin", "main");
  sh(work, "checkout", "-q", "-b", "feat/x");
  writeFileSync(join(work, file[0]), file[1]);
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { test } }));
  sh(work, "add", "-A"), sh(work, "commit", "-qm", "feat: x");
  await h.publish({ path: work, slug: "local/app", sha: sh(work, "rev-parse", "HEAD"), branch: "feat/x" });
  const { number } = await h.openChange({ slug: "local/app", branch: "feat/x", base: "main", title: "x" });
  const c = await h.readChange("local/app", number);
  // A stand-in for gitleaks: red when the scanned range adds "SECRET", unless its config allows it.
  const gitleaks = join(dir, "gitleaks");
  writeFileSync(gitleaks, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --config) c="$2"; shift;; --log-opts) r="$2"; shift;; esac; shift; done\ngrep -q allow "$c" && exit 0\ngit log -p "$r" | grep -q "^+.*SECRET" && { echo "leak found"; exit 1; }\nexit 0\n');
  chmodSync(gitleaks, 0o755);
  return { dir, h, c, n: number, gitleaks };
}

describe("local checks", () => {
  it("code under test that rewrites its clone's git objects, refs and every config it can reach can't clear the secret scan", async () => {
    // The tests try what they can: plant an allowlist in every .toml near them, swap the leaking commit with git replace,
    // and point grafts at the base, then pass.
    const tamper = "for f in ../*.toml ../../*.toml .gitleaks.toml; do echo allow > $f 2>/dev/null; done; git replace -f HEAD HEAD~1 2>/dev/null; echo $(git rev-parse HEAD~1) > .git/info/grafts; exit 0";
    const { dir, c, n, gitleaks } = await change({ file: ["key.txt", "SECRET=abc\n"], test: tamper });
    const r = await localCheckRuns({ sandbox, bare: join(dir, "data", "codehost", "local", "app.git"), n, base: c.base, head: c.head, root: join(dir, "checks"), gitleaks, repoRoot });
    assert.equal(r.secrets.ok, false, r.secrets.tail);
    assert.match(r.secrets.tail, /leak found/);
    assert.equal(r.tests.ok, true, r.tests.tail);
  });

  it("a process the tests leave running in the background is killed when they end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-jail-"));
    mkdirSync(join(dir, "w"));
    const r = await jailRun(sandbox, join(dir, "w"), ["bash", "-c", "(sleep 1; touch late) & echo started"]);
    assert.equal(r.ok, true);
    await new Promise((ok) => setTimeout(ok, 1800));
    assert.equal(existsSync(join(dir, "w", "late")), false, "the background process outlived the check");
  });
});

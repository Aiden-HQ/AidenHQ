// A local change request's checks (src/checks.ts): the only gate a local merge has besides the reviewer, so each test
// is named after the attack it stops. The jail is the host's own here (unconfined); the flow test runs the fake one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jailRun, localCheckRuns } from "../src/checks.ts";
import { host } from "../src/host.mjs";

const sandbox = { unconfined: true };
// The product checkout this module sits in (modules/ at its root): its scripts/supply-chain are the check scripts.
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
  // A stand-in for gitleaks that reads what the real one reads: red when the scanned range adds "SECRET", unless its config
  // allows it, its ignore list (the --gitleaks-ignore-path file, else the source's .gitleaksignore) names it, or the line
  // carries gitleaks:allow (honoured unless --ignore-gitleaks-allow).
  const gitleaks = join(dir, "gitleaks");
  writeFileSync(gitleaks, [
    "#!/bin/sh",
    'i=""; strict=""; while [ $# -gt 0 ]; do case "$1" in --config) c="$2"; shift;; --log-opts) r="$2"; shift;; --gitleaks-ignore-path) i="$2"; shift;; --ignore-gitleaks-allow) strict=1;; esac; shift; done',
    '[ -n "$i" ] || i=.gitleaksignore',
    'echo "INF $(git log --format=%H "$r" | wc -l | tr -d " ") commits scanned."',
    'grep -q allow "$c" && exit 0',
    'hits=$(git log -p "$r" | grep "^+.*SECRET" | grep -v "^+++")',
    '[ -z "$strict" ] && hits=$(printf "%s\\n" "$hits" | grep -v "gitleaks:allow")',
    '[ -f "$i" ] && grep -q SECRET "$i" && exit 0',
    'printf "%s" "$hits" | grep -q SECRET && { echo "leak found"; exit 1; }',
    "exit 0",
  ].join("\n") + "\n");
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

  it("a change whose ref moved on after the check was asked for is never passed on the head it left", async () => {
    const { dir, h, c, n, gitleaks } = await change({ file: ["ok.txt", "fine\n"], test: "node -e 0" });
    const bare = join(dir, "data", "codehost", "local", "app.git");
    // The change moves on to a head whose tests fail and that leaks: the checks of the earlier head must not see it.
    const work = join(dir, "clone");
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { test: "exit 7" } }));
    writeFileSync(join(work, "leak.txt"), "SECRET=1\n");
    sh(work, "add", "-A"), sh(work, "commit", "-qm", "feat: moved");
    await h.publish({ path: work, slug: "local/app", sha: sh(work, "rev-parse", "HEAD"), branch: "feat/x" });
    await h.openChange({ slug: "local/app", branch: "feat/x", base: "main" });
    const r = await localCheckRuns({ sandbox, bare, n, base: c.base, head: c.head, root: join(dir, "checks"), gitleaks, repoRoot });
    assert.deepEqual([r.secrets.ok, r.tests.ok], [false, false]);
    assert.match(r.secrets.tail, /not checked: change \d+ is at/);
    // A head the repo doesn't have is never "checked" on whatever the clone holds.
    const ghost = await localCheckRuns({ sandbox, bare, n, base: c.base, head: "f".repeat(40), root: join(dir, "checks"), gitleaks, repoRoot });
    assert.deepEqual([ghost.secrets.ok, ghost.tests.ok], [false, false]);
    assert.match(ghost.tests.tail, /not checked/);
  });

  it("a change that adds a secret together with a .gitleaksignore and a gitleaks:allow comment for it still fails the scan", async () => {
    const { dir, h, c, n, gitleaks } = await change({ file: ["key.txt", "SECRET=abc # gitleaks:allow\n"], test: "node -e 0" });
    const work = join(dir, "clone");
    writeFileSync(join(work, ".gitleaksignore"), "SECRET\nkey.txt\n");
    sh(work, "add", "-A"), sh(work, "commit", "-qm", "chore: ignore list");
    await h.publish({ path: work, slug: "local/app", sha: sh(work, "rev-parse", "HEAD"), branch: "feat/x" });
    await h.openChange({ slug: "local/app", branch: "feat/x", base: "main" });
    const now = await h.readChange("local/app", n);
    const r = await localCheckRuns({ sandbox, bare: join(dir, "data", "codehost", "local", "app.git"), n, base: now.base, head: now.head, root: join(dir, "checks"), gitleaks, repoRoot });
    assert.equal(r.secrets.ok, false, r.secrets.tail);
    assert.match(r.secrets.tail, /leak found/);
    assert.ok(c.head !== now.head);
  });

  it("an inline gitleaks:allow comment in the change is no exemption", async () => {
    const { dir, c, n, gitleaks } = await change({ file: ["key.txt", "SECRET=abc # gitleaks:allow\n"], test: "node -e 0" });
    const r = await localCheckRuns({ sandbox, bare: join(dir, "data", "codehost", "local", "app.git"), n, base: c.base, head: c.head, root: join(dir, "checks"), gitleaks, repoRoot });
    assert.equal(r.secrets.ok, false, r.secrets.tail);
  });

  it("a scanner that hits a git error and scans nothing, yet exits 0, never passes the change", async () => {
    const { dir, c, n } = await change({ file: ["ok.txt", "fine\n"], test: "node -e 0" });
    const broken = join(dir, "gitleaks-broken");
    writeFileSync(broken, '#!/bin/sh\necho "ERR error=\\"stderr is not empty\\""\necho "INF 0 commits scanned."\necho "INF no leaks found"\nexit 0\n');
    chmodSync(broken, 0o755);
    const r = await localCheckRuns({ sandbox, bare: join(dir, "data", "codehost", "local", "app.git"), n, base: c.base, head: c.head, root: join(dir, "checks"), gitleaks: broken, repoRoot });
    assert.equal(r.secrets.ok, false, r.secrets.tail);
    assert.match(r.secrets.tail, /doesn't count as passed/);
  });

  it("in the job jail each check sees what it reads, read-only: the scan its clone, config and ignore list; the tests the supply-chain scripts", async () => {
    // A bwrap that records its mounts, then runs the command: the real jail hides the home (where the check folder and the
    // product checkout live), so whatever isn't mounted here doesn't exist for the check.
    const { dir, c, n, gitleaks } = await change({ file: ["ok.txt", "fine\n"], test: "node -e 0" });
    const calls = join(dir, "bwrap-calls");
    const bwrap = join(dir, "bwrap");
    writeFileSync(bwrap, `#!/bin/sh\nfor a in "$@"; do [ "$a" = -- ] && break; printf '%s ' "$a" >> ${JSON.stringify(calls)}; done\necho >> ${JSON.stringify(calls)}\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n`);
    chmodSync(bwrap, 0o755);
    const jail = { bwrap, hidden: [], binDir: "", browserDir: "" };
    const r = await localCheckRuns({ sandbox: jail, bare: join(dir, "data", "codehost", "local", "app.git"), n, base: c.base, head: c.head, root: join(dir, "checks"), gitleaks, repoRoot });
    assert.deepEqual([r.secrets.ok, r.tests.ok], [true, true], `${r.secrets.tail}\n${r.tests.tail}`);
    // Each check's own mounts (the check folder's and the product's scripts), named relative to them.
    const short = (p) => p.replace(/.*\/check-[^/]+\//, "").replace(/.*\/scripts\//, "scripts/");
    const [scan, tests] = readFileSync(calls, "utf8").trim().split("\n").map((l) => {
      const a = l.trim().split(" ");
      const of = (how) => a.filter((x, i) => a[i - 1] === how && (x.startsWith(dir) || x.endsWith("supply-chain"))).map(short).sort();
      return { ro: of("--ro-bind"), rw: of("--bind") };
    });
    assert.deepEqual(scan, { ro: ["gitleaks.toml", "gitleaksignore", "scan.git"], rw: [] });
    assert.deepEqual(tests, { ro: ["scripts/supply-chain"], rw: ["tests"] });
  });
});

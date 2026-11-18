// Release updates (docs/design/release-updates.md), end to end on local repositories standing in for GitHub: the distro, kernel
// and modules repos under <base>/Aiden-HQ/, an instance repo with a bare origin, a product checkout. The published asset and
// the workflow run are a fake download; the apply is a fake that records the commit it was given (apply's own health check
// and auto-revert are scripts/test/apply-atomic.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { Refused, check, createUpdates, install, pinTo, verify } from "../src/updates.ts";

// The owner's own git config (signing, hooks) never reaches the fixtures or the updater's commits.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const DAY = new Date("2026-11-18T08:00:00Z"); // 12:00 in Dubai
const NIGHT = new Date("2026-11-18T23:30:00Z"); // 03:30 in Dubai
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }).trim();

/** A repo `name` under base/Aiden-HQ with one commit per entry of `commits` (file -> text); returns each commit's sha. */
function repo(base, name, commits) {
  const src = join(base, "src", name);
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q");
  const shas = commits.map((files) => {
    for (const [f, t] of Object.entries(files)) { mkdirSync(join(src, f, ".."), { recursive: true }); writeFileSync(join(src, f), t); }
    git(src, "add", "-A");
    git(src, "commit", "-qm", Object.keys(files).join(" "));
    return git(src, "rev-parse", "HEAD");
  });
  git(base, "clone", "-q", "--bare", src, join(base, "Aiden-HQ", `${name}.git`));
  return { src, shas, push: () => git(src, "push", "-q", join(base, "Aiden-HQ", `${name}.git`), "--mirror", "--force") };
}

const release = (name, kernel, market, over = {}) => ({
  name: "AidenHQ", release: name, kernel, kernel_repo: "Aiden-HQ/AidenHQ",
  marketplace: { name: "aidenhq", source: { source: "github", repo: "Aiden-HQ/aidenhq-modules" }, sha: market },
  modules: { board: market }, tested: { ci_run: "", suites: ["kernel-only"] },
  images: { board: `ghcr.io/aiden-hq/board@sha256:${"a".repeat(64)}` }, notes: ["Updates install themselves"], ...over,
});

/** The world: 2026.11.2 running (kernel K1, modules M1), 2026.11.3 tagged on the distro's main (K2, M2). */
function world({ auto = "on", next = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "updates-"));
  const base = join(root, "gh");
  const kernel = repo(base, "AidenHQ", [{ "a.txt": "1" }, { "a.txt": "2" }]);
  const modules = repo(base, "aidenhq-modules", [{ "m.txt": "1" }, { "m.txt": "2" }]);
  const [K1, K2] = kernel.shas, [M1, M2] = modules.shas;
  const files = { "2026.11.2": release("2026.11.2", K1, M1), "2026.11.3": release("2026.11.3", K2, M2, typeof next === "function" ? next({ K1, K2, M1, M2 }) : next) };
  const distro = repo(base, "aidenhq-distro", [{ "releases/2026.11.2.json": JSON.stringify(files["2026.11.2"]) }, { "releases/2026.11.3.json": JSON.stringify(files["2026.11.3"]) }]);
  const [D1, D2] = distro.shas;
  git(distro.src, "tag", "2026.11.2", D1);
  git(distro.src, "tag", "2026.11.3", D2);
  distro.push();
  // The instance, as ops/setup.sh writes it for a release install.
  const instYaml = `# acme's AidenHQ.
product: ${K1}
release: { name: "2026.11.2", source: { source: github, repo: Aiden-HQ/aidenhq-distro }, sha: ${D1} }
marketplaces:
  - { name: aidenhq, source: { source: github, repo: Aiden-HQ/aidenhq-modules }, sha: ${M1} }
modules: [board]
settings:
  owner_name: "Acme"
  timezone: "Asia/Dubai"
  auto_update: "${auto}"
`;
  const iw = join(root, "iw");
  mkdirSync(iw);
  git(iw, "init", "-q");
  writeFileSync(join(iw, "instance.yaml"), instYaml);
  git(iw, "add", "-A");
  git(iw, "commit", "-qm", "instance");
  git(root, "clone", "-q", "--bare", iw, join(root, "inst.git"));
  git(root, "clone", "-q", join(root, "inst.git"), "inst");
  // The product checkout: its origin is the official kernel repo, as install.sh clones it.
  git(root, "clone", "-q", join(base, "Aiden-HQ", "AidenHQ.git"), "product");
  const applied = [];
  const published = {};
  for (const [n, f] of Object.entries(files)) published[n] = { ...f, tested: { ci_run: `https://github.com/Aiden-HQ/aidenhq-distro/actions/runs/${n === "2026.11.3" ? 22 : 11}`, suites: ["kernel-only", "swap"] } };
  const runs = { 11: { path: ".github/workflows/release.yml", head_sha: D1, event: "push" }, 22: { path: ".github/workflows/release.yml", head_sha: D2, event: "push" } };
  const d = {
    base, fetch: { cacheDir: join(root, "cache") }, inst: join(root, "inst"), product: join(root, "product"), dir: join(root, "state", "updates"), board: join(root, "state", "board", "updates.json"),
    download: async (u) => {
      const a = /releases\/download\/([\d.]+)\//.exec(u), r = /actions\/runs\/(\d+)$/.exec(u);
      if (a) return published[a[1]];
      if (r) return runs[r[1]];
      throw new Error(`unexpected ${u}`);
    },
    applyCode: 0,
    apply(sha) { applied.push(sha); return this.applyCode === 0 ? { code: 0, out: "generation 3 is good" } : { code: 1, out: "generation 3 failed: checks that passed before failed\napply alert: generation 3 failed (checks that passed before the switch fail now: kernel) and was reverted to generation 2; this host stays there until the instance's main moves; log x" }; },
  };
  const pinned = () => { git(d.inst, "fetch", "-q", "origin"); return YAML.parse(git(d.inst, "show", "origin/main:instance.yaml")); };
  return { root, d, K1, K2, M1, M2, D1, D2, applied, published, runs, pinned, distro, files };
}

test("a newer release is found and verified; by day nothing installs, and the owner is told once", async () => {
  const w = world();
  const s = await check({ ...w.d, now: () => DAY });
  assert.equal(s.current.name, "2026.11.2");
  assert.equal(s.available.name, "2026.11.3");
  assert.equal(s.available.kernel, w.K2);
  assert.deepEqual(s.available.notes, ["Updates install themselves"]);
  assert.equal(existsSync(join(w.d.dir, "next")), false, "by day: no install");
  // The board's copy carries what it shows only.
  const shown = JSON.parse(readFileSync(w.d.board, "utf8"));
  assert.equal(shown.available.name, "2026.11.3");
  assert.equal(shown.available.kernel, undefined);
  // The kernel tells the owner each event once.
  const lines = [];
  const u = createUpdates({ db: new DatabaseSync(":memory:"), dir: w.d.dir, ownerLine: (t) => lines.push(t), start: () => {} });
  u.tick(); u.tick();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2026\.11\.3 is available\. It installs tonight between 2:00 and 5:00 \(Asia\/Dubai\)/);
});

test("verification refuses a mismatched sha, an unpublished stamp, a kernel off main and a downgrade", async () => {
  const w = world();
  const text = git(w.d.inst, "show", "HEAD:instance.yaml");
  // The published asset names another kernel than the file at the tag.
  w.published["2026.11.3"] = { ...w.published["2026.11.3"], kernel: w.K1 };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), (e) => e instanceof Refused && /published release file isn't the one at its tag/.test(e.message));
  // A stamp whose run isn't on this commit.
  w.published["2026.11.3"] = { ...w.files["2026.11.3"], tested: { ci_run: "https://github.com/Aiden-HQ/aidenhq-distro/actions/runs/11", suites: ["swap"] } };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), /tested stamp doesn't name a release run on its commit/);
  // Older or equal: refused before anything is fetched.
  await assert.rejects(verify(w.d, text, "2026.11.1", w.D1), /isn't newer than 2026\.11\.2: downgrades are refused/);
  await assert.rejects(verify(w.d, text, "2026.11.2", w.D1), /downgrades are refused/);
  // A module sha that isn't on the marketplace's history (install.sh's check too).
  const offHistory = world({ next: ({ K1 }) => ({ modules: { board: K1 } }) });
  await assert.rejects(verify(offHistory.d, git(offHistory.d.inst, "show", "HEAD:instance.yaml"), "2026.11.3", offHistory.D2), /module board at [0-9a-f]{12} isn't on the marketplace's history/);
  // A kernel sha that isn't on the kernel's main (a side branch GitHub would serve too).
  const side = world();
  const k = join(side.root, "gh", "src", "AidenHQ");
  git(k, "checkout", "-q", "-b", "side", side.K1);
  writeFileSync(join(k, "evil.txt"), "x");
  git(k, "add", "-A"); git(k, "commit", "-qm", "evil");
  const evil = git(k, "rev-parse", "HEAD");
  git(k, "push", "-q", join(side.root, "gh", "Aiden-HQ", "AidenHQ.git"), "side");
  const bad = release("2026.11.4", evil, side.M2);
  writeFileSync(join(side.distro.src, "releases/2026.11.4.json"), JSON.stringify(bad));
  git(side.distro.src, "add", "-A"); git(side.distro.src, "commit", "-qm", "2026.11.4");
  const D4 = git(side.distro.src, "rev-parse", "HEAD");
  git(side.distro.src, "tag", "2026.11.4", D4);
  side.distro.push();
  await assert.rejects(verify(side.d, git(side.d.inst, "show", "HEAD:instance.yaml"), "2026.11.4", D4), /kernel [0-9a-f]{12} isn't on Aiden-HQ\/AidenHQ's main/);
  // check() records a refused release, tells the owner once, and never offers it.
  const s = await check({ ...side.d, now: () => NIGHT });
  assert.equal(s.available, null);
  assert.match(s.error, /2026\.11\.4 was refused/);
  assert.ok(s.events.some((e) => e.id === "refused:2026.11.4"));
  assert.equal(existsSync(join(side.d.dir, "next")), false);
});

test("auto-updates off: at night the release is only offered, never installed", async () => {
  const w = world({ auto: "off" });
  const s = await check({ ...w.d, now: () => NIGHT });
  assert.equal(s.auto, false);
  assert.equal(s.available.name, "2026.11.3");
  assert.equal(existsSync(join(w.d.dir, "next")), false);
  assert.match(s.events.at(-1).text, /Auto-updates are off: install it from Settings > Instance \(Update now\)/);
  assert.deepEqual(w.applied, []);
});

test("Update now installs: one pin commit (product, release, marketplace), applied; the night installs too", async () => {
  const w = world({ auto: "off" });
  await check({ ...w.d, now: () => DAY });
  let started = 0;
  const u = createUpdates({ db: new DatabaseSync(":memory:"), dir: w.d.dir, ownerLine: () => {}, start: () => started++ });
  assert.throws(() => u.requestNow("2026.11.9", "account:a1"), /isn't the one available/);
  // A request for a release that is no longer the one available is said, not dropped.
  writeFileSync(join(w.d.dir, "now.json"), JSON.stringify({ release: "2026.11.9", by: "account:a1" }));
  assert.match((await check({ ...w.d, now: () => DAY })).events.at(-1).text, /Update now didn't start: 2026\.11\.9 isn't the release available any more/);
  assert.match(u.requestNow("2026.11.3", "account:a1"), /Installing 2026\.11\.3 now/);
  assert.equal(started, 1);
  await check({ ...w.d, now: () => DAY });
  assert.deepEqual(JSON.parse(readFileSync(join(w.d.dir, "next"), "utf8")), { release: "2026.11.3", by: "account:a1" });
  const s = await install({ ...w.d, now: () => DAY });
  assert.equal(s.last.outcome, "installed");
  assert.equal(s.current.name, "2026.11.3");
  const p = w.pinned();
  assert.equal(p.product, w.K2);
  assert.deepEqual(p.release, { name: "2026.11.3", source: { source: "github", repo: "Aiden-HQ/aidenhq-distro" }, sha: w.D2 });
  assert.equal(p.marketplaces[0].sha, w.M2);
  assert.equal(p.settings.auto_update, "off", "the rest of instance.yaml is kept");
  assert.match(git(w.d.inst, "show", "origin/main:instance.yaml"), /^# acme's AidenHQ\./, "comments kept");
  assert.deepEqual(w.applied, [git(w.d.inst, "rev-parse", "origin/main")]);
  // With auto on, the night alone starts it.
  const n = world();
  await check({ ...n.d, now: () => NIGHT });
  assert.deepEqual(JSON.parse(readFileSync(join(n.d.dir, "next"), "utf8")), { release: "2026.11.3", by: "auto-update" });
  // A local product mirror (origin a path) gets the verified kernel pushed onto its main, where apply looks for it.
  const mirror = join(n.root, "mirror.git");
  git(n.root, "clone", "-q", "--bare", join(n.root, "gh", "src", "AidenHQ"), mirror);
  git(join(n.root, "gh", "src", "AidenHQ"), "push", "-q", mirror, `${n.K1}:refs/heads/main`, "--force");
  git(n.d.product, "remote", "set-url", "origin", mirror);
  assert.equal((await install({ ...n.d, now: () => NIGHT })).last.outcome, "installed");
  assert.equal(git(mirror, "rev-parse", "main"), n.K2);
});

test("a failed health check: the pin is reverted, the owner told, and the night doesn't try that release again", async () => {
  const w = world();
  w.d.applyCode = 1;
  await check({ ...w.d, now: () => NIGHT });
  const s = await install({ ...w.d, now: () => NIGHT });
  assert.equal(s.last.outcome, "failed");
  assert.match(s.last.why, /generation 3 failed \(checks that passed before the switch fail now: kernel\) and was reverted to generation 2/);
  assert.equal(w.pinned().product, w.K1, "instance main pins the release that runs again");
  assert.equal(w.pinned().release.name, "2026.11.2");
  assert.match(git(w.d.inst, "log", "-1", "--format=%s", "origin/main"), /update: back to 2026\.11\.2 \(2026\.11\.3 failed to install\)/);
  assert.match(s.events.at(-1).text, /2026\.11\.3 didn't install: .*This server is back on 2026\.11\.2\. It won't retry on its own/);
  // The next night offers it, but doesn't install it; Update now still can.
  const again = await check({ ...w.d, now: () => NIGHT });
  assert.equal(again.available.name, "2026.11.3");
  assert.equal(existsSync(join(w.d.dir, "next")), false);
  writeFileSync(join(w.d.dir, "now.json"), JSON.stringify({ release: "2026.11.3", by: "account:a1" }));
  await check({ ...w.d, now: () => DAY });
  assert.ok(existsSync(join(w.d.dir, "next")));
});

test("the installer run again moves the pin to its release; the same release is a repair, an older one is refused", () => {
  const w = world();
  assert.throws(() => pinTo(w.d, "2026.11.1", w.D1, w.K1), (e) => e instanceof Refused && /runs 2026\.11\.2, newer than 2026\.11\.1: downgrades are refused/.test(e.message));
  assert.equal(pinTo(w.d, "2026.11.2", w.D1, w.K1), "already on 2026.11.2");
  assert.throws(() => pinTo(w.d, "2026.11.3", w.D2, w.K1), /kernel is [0-9a-f]{12}, but this checkout is at/);
  assert.match(pinTo(w.d, "2026.11.3", w.D2, w.K2), /now pins 2026\.11\.3 \(from 2026\.11\.2\)/);
  const p = w.pinned();
  assert.deepEqual([p.product, p.release.name, p.release.sha, p.marketplaces[0].sha], [w.K2, "2026.11.3", w.D2, w.M2]);
  // An instance that pins its product by hand is left as it is.
  const h = world();
  writeFileSync(join(h.d.inst, "instance.yaml"), `product: ${h.K1}\n`);
  git(h.d.inst, "commit", "-qam", "by hand");
  git(h.d.inst, "push", "-q", "origin", "HEAD:main");
  assert.match(pinTo(h.d, "2026.11.3", h.D2, h.K2), /pins its product by hand: left as it is/);
});

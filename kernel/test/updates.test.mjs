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
import { Refused, check, createUpdates, pinTo, readState, run, verify } from "../src/updates.ts";

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
  const runs = { 11: { path: ".github/workflows/release.yml", head_sha: D1, event: "push", conclusion: "success" }, 22: { path: ".github/workflows/release.yml", head_sha: D2, event: "push", conclusion: "success" } };
  const d = {
    base, fetch: { cacheDir: join(root, "cache") }, inst: join(root, "inst"), product: join(root, "product"), dir: join(root, "state", "updates"), board: join(root, "state", "board", "updates.json"), applied: join(root, "applied-product"),
    download: async (u) => {
      const a = /releases\/download\/([\d.]+)\//.exec(u), r = /actions\/runs\/(\d+)$/.exec(u);
      if (a) return published[a[1]];
      if (r) return runs[r[1]];
      throw new Error(`unexpected ${u}`);
    },
    applyCode: 0,
    // A fake apply: records its arguments and the instance main it would apply; good writes the pinned product as applied.
    apply(args) {
      git(this.inst, "fetch", "-q", "origin");
      applied.push([...args, git(this.inst, "rev-parse", "origin/main")]);
      if (args[0] === "--recover") return { code: 0, out: "" };
      if (this.applyCode !== 0) return { code: 1, out: "generation 3 failed: checks that passed before failed\napply alert: generation 3 failed (checks that passed before the switch fail now: kernel) and was reverted to generation 2; this host stays there until the instance's main moves; log x" };
      writeFileSync(this.applied, YAML.parse(git(this.inst, "show", "origin/main:instance.yaml")).product);
      return { code: 0, out: "generation 3 is good" };
    },
  };
  const pinned = () => { git(d.inst, "fetch", "-q", "origin"); return YAML.parse(git(d.inst, "show", "origin/main:instance.yaml")); };
  return { root, d, K1, K2, M1, M2, D1, D2, applied, published, runs, pinned, distro, files };
}


const ask = (w, release, by = "account:a1") => { mkdirSync(w.d.dir, { recursive: true }); writeFileSync(join(w.d.dir, "now.json"), JSON.stringify({ release, by })); };

test("a newer release is found and verified; by day nothing installs, and the owner is told once", async () => {
  const w = world();
  const { state: s, install } = await check({ ...w.d, now: () => DAY });
  assert.equal(s.current.name, "2026.11.2");
  assert.equal(s.available.name, "2026.11.3");
  assert.equal(s.available.kernel, w.K2);
  assert.deepEqual(s.available.notes, ["Updates install themselves"]);
  assert.equal(install, null, "by day: no install");
  const shown = JSON.parse(readFileSync(w.d.board, "utf8"));
  assert.equal(shown.available.name, "2026.11.3");
  assert.equal(shown.available.kernel, undefined, "the board's copy carries what it shows only");
  const lines = [];
  const u = createUpdates({ db: new DatabaseSync(":memory:"), dir: w.d.dir, ownerLine: (t) => lines.push(t), start: () => {} });
  u.tick(); await check({ ...w.d, now: () => DAY }); u.tick();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2026\.11\.3 is available\. It installs tonight between 2:00 and 5:00 \(Asia\/Dubai\)/);
});

test("verification refuses a mismatched sha, a stamp from another or a failed run, a kernel off main, a module off history and a downgrade", async () => {
  const w = world();
  const text = git(w.d.inst, "show", "HEAD:instance.yaml");
  w.published["2026.11.3"] = { ...w.published["2026.11.3"], kernel: w.K1 };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), (e) => e instanceof Refused && /published release file isn't the one at its tag/.test(e.message));
  w.published["2026.11.3"] = { ...w.files["2026.11.3"], tested: { ci_run: "https://github.com/Aiden-HQ/aidenhq-distro/actions/runs/11", suites: ["swap"] } };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), /tested stamp doesn't name a successful release run on its commit/);
  w.published["2026.11.3"] = { ...w.files["2026.11.3"], tested: { ci_run: "https://github.com/Aiden-HQ/aidenhq-distro/actions/runs/22", suites: ["swap"] } };
  w.runs[22] = { ...w.runs[22], conclusion: "failure" };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), /successful release run/);
  await assert.rejects(verify(w.d, text, "2026.11.1", w.D1), /isn't newer than 2026\.11\.2: downgrades are refused/);
  const off = world({ next: ({ K1 }) => ({ modules: { board: K1 } }) });
  await assert.rejects(verify(off.d, git(off.d.inst, "show", "HEAD:instance.yaml"), "2026.11.3", off.D2), /module board at [0-9a-f]{12} isn't on the marketplace's history/);
  // A newest tag whose kernel is off main (a side branch GitHub would serve too) is refused and said once; the valid older
  // release under it is still offered.
  const side = world();
  const k = join(side.root, "gh", "src", "AidenHQ");
  git(k, "checkout", "-q", "-b", "side", side.K1);
  writeFileSync(join(k, "evil.txt"), "x");
  git(k, "add", "-A"); git(k, "commit", "-qm", "evil");
  const evil = git(k, "rev-parse", "HEAD");
  git(k, "push", "-q", join(side.root, "gh", "Aiden-HQ", "AidenHQ.git"), "side");
  writeFileSync(join(side.distro.src, "releases/2026.11.4.json"), JSON.stringify(release("2026.11.4", evil, side.M2)));
  git(side.distro.src, "add", "-A"); git(side.distro.src, "commit", "-qm", "2026.11.4");
  const D4 = git(side.distro.src, "rev-parse", "HEAD");
  git(side.distro.src, "tag", "2026.11.4", D4);
  side.distro.push();
  await assert.rejects(verify(side.d, git(side.d.inst, "show", "HEAD:instance.yaml"), "2026.11.4", D4), /kernel [0-9a-f]{12} isn't on Aiden-HQ\/AidenHQ's main/);
  const { state: s, install } = await check({ ...side.d, now: () => NIGHT });
  assert.equal(s.available.name, "2026.11.3");
  assert.ok(s.events.some((e) => e.id === "refused:2026.11.4"));
  assert.deepEqual(install, { release: "2026.11.3", by: "auto-update" });
});

test("a network error is retried, never reported as a refused release", async () => {
  const w = world();
  w.d.download = async () => { throw new Error("api.github.com answered 503"); };
  const { state: s, install } = await check({ ...w.d, now: () => NIGHT });
  assert.equal(s.available, null);
  assert.match(s.error, /503/);
  assert.ok(!s.events?.some((e) => e.id.startsWith("refused:")));
  assert.equal(install, null);
});

test("auto-updates off: at night the release is only offered, never installed", async () => {
  const w = world({ auto: "off" });
  const s = await run({ ...w.d, now: () => NIGHT });
  assert.equal(s.auto, false);
  assert.equal(s.available.name, "2026.11.3");
  assert.match(s.events.at(-1).text, /Auto-updates are off: install it from Settings > Instance \(Update now\)/);
  assert.deepEqual(w.applied, []);
});

test("Update now installs: one pin commit (product, release, marketplace), then the instance's main is applied", async () => {
  const w = world({ auto: "off" });
  await run({ ...w.d, now: () => DAY });
  let started = 0;
  const u = createUpdates({ db: new DatabaseSync(":memory:"), dir: w.d.dir, ownerLine: () => {}, start: () => started++ });
  assert.throws(() => u.requestNow("2026.11.9", "account:a1"), /isn't the one available/);
  assert.match(u.requestNow("2026.11.3", "account:a1"), /Installing 2026\.11\.3 now/);
  assert.equal(started, 1);
  const s = await run({ ...w.d, now: () => DAY });
  assert.equal(s.last.outcome, "installed");
  assert.equal(s.last.by, "account:a1");
  assert.equal(s.current.name, "2026.11.3");
  assert.equal(s.installing, undefined);
  assert.equal(existsSync(join(w.d.dir, "now.json")), false, "the request is spent");
  const p = w.pinned();
  assert.equal(p.product, w.K2);
  assert.deepEqual(p.release, { name: "2026.11.3", source: { source: "github", repo: "Aiden-HQ/aidenhq-distro" }, sha: w.D2 });
  assert.equal(p.marketplaces[0].sha, w.M2);
  assert.equal(p.settings.auto_update, "off", "the rest of instance.yaml is kept");
  assert.match(git(w.d.inst, "show", "origin/main:instance.yaml"), /^# acme's AidenHQ\./, "comments kept");
  assert.deepEqual(w.applied, [[git(w.d.inst, "rev-parse", "origin/main")]], "apply is given the instance's main, not a commit");
  assert.match(s.events.at(-1).text, /updated to 2026\.11\.3 \(from 2026\.11\.2\)\. What changed: Updates install themselves/);
  // A local product mirror (origin a path) gets the verified kernel pushed onto its main, where apply looks for it.
  const n = world();
  const mirror = join(n.root, "mirror.git");
  git(n.root, "clone", "-q", "--bare", join(n.root, "gh", "src", "AidenHQ"), mirror);
  git(join(n.root, "gh", "src", "AidenHQ"), "push", "-q", mirror, `${n.K1}:refs/heads/main`, "--force");
  git(n.d.product, "remote", "set-url", "origin", mirror);
  assert.equal((await run({ ...n.d, now: () => NIGHT })).last.outcome, "installed", "the night alone starts it with auto on");
  assert.equal(git(mirror, "rev-parse", "main"), n.K2);
});

test("an Update now that can't go ahead is told to the owner, and a request is kept until a run takes it", async () => {
  const w = world();
  await run({ ...w.d, now: () => DAY });
  ask(w, "2026.11.9");
  assert.match((await run({ ...w.d, now: () => DAY })).events.at(-1).text, /Update now didn't start: 2026\.11\.9 isn't the release available any more/);
  // Stopped at install, before anything moved (here the product checkout's origin isn't official): said, not silent.
  git(w.d.product, "remote", "set-url", "origin", "https://example.com/acme/fork.git");
  ask(w, "2026.11.3");
  const s = await run({ ...w.d, now: () => DAY });
  assert.ok(s.events.some((e) => e.id === "refused:2026.11.3" && /checks at install \(the product checkout's origin is/.test(e.text)));
  assert.equal(w.pinned().product, w.K1, "nothing moved");
  assert.deepEqual(w.applied, []);
});

test("a failed health check: the pin is reverted, the owner told, and the night doesn't try that release again", async () => {
  const w = world();
  w.d.applyCode = 1;
  const s = await run({ ...w.d, now: () => NIGHT });
  assert.equal(s.last.outcome, "failed");
  assert.match(s.last.why, /generation 3 failed \(checks that passed before the switch fail now: kernel\) and was reverted to generation 2/);
  assert.equal(w.pinned().product, w.K1, "instance main pins the release that runs again");
  assert.equal(w.pinned().release.name, "2026.11.2");
  assert.match(git(w.d.inst, "log", "-1", "--format=%s", "origin/main"), /update: back to 2026\.11\.2 \(2026\.11\.3 failed to install\)/);
  assert.match(s.events.at(-1).text, /2026\.11\.3 didn't install: .*This server is back on 2026\.11\.2\. It won't retry on its own/);
  w.applied.length = 0;
  const again = await run({ ...w.d, now: () => NIGHT });
  assert.equal(again.available.name, "2026.11.3", "still offered");
  assert.deepEqual(w.applied, [], "but the night doesn't install it");
  ask(w, "2026.11.3");
  w.d.applyCode = 0;
  assert.equal((await run({ ...w.d, now: () => DAY })).last.outcome, "installed", "Update now does");
});

test("a run that died after its pin commit: the next run finishes it as failed, reverts the pin, and the night skips it", async () => {
  const w = world();
  writeFileSync(w.d.applied, w.K1);
  // The run dies in its apply: the pin is on main, `installing` is recorded, nothing settled.
  await assert.rejects(run({ ...w.d, now: () => NIGHT, apply: () => { throw new Error("killed"); } }), /killed/);
  assert.equal(readState(w.d.dir).installing.release, "2026.11.3");
  assert.equal(w.pinned().product, w.K2);
  // The next run: apply finishes the dead generation (--recover), the host runs 2026.11.2, so the update failed.
  const s = await run({ ...w.d, now: () => NIGHT });
  assert.equal(w.applied[0][0], "--recover");
  assert.equal(s.installing, undefined);
  assert.equal(s.last.outcome, "failed");
  assert.match(s.last.why, /stopped before it finished/);
  assert.equal(w.pinned().product, w.K1, "the pin is back on what runs");
  assert.equal(w.applied.length, 1, "and the night doesn't try it again");
});

test("the installer run again moves the pin to its release; the same release is a repair, an older one is refused", () => {
  const w = world();
  assert.throws(() => pinTo(w.d, "2026.11.1", w.D1, w.K1), (e) => e instanceof Refused && /runs 2026\.11\.2, newer than 2026\.11\.1: downgrades are refused/.test(e.message));
  assert.equal(pinTo(w.d, "2026.11.2", w.D1, w.K1), "already on 2026.11.2");
  assert.throws(() => pinTo(w.d, "2026.11.3", w.D2, w.K1), /kernel is [0-9a-f]{12}, but this checkout is at/);
  assert.match(pinTo(w.d, "2026.11.3", w.D2, w.K2), /now pins 2026\.11\.3 \(from 2026\.11\.2\)/);
  const p = w.pinned();
  assert.deepEqual([p.product, p.release.name, p.release.sha, p.marketplaces[0].sha], [w.K2, "2026.11.3", w.D2, w.M2]);
  const h = world();
  writeFileSync(join(h.d.inst, "instance.yaml"), `product: ${h.K1}\n`);
  git(h.d.inst, "commit", "-qam", "by hand");
  git(h.d.inst, "push", "-q", "origin", "HEAD:main");
  assert.match(pinTo(h.d, "2026.11.3", h.D2, h.K2), /pins its product by hand: left as it is/);
});

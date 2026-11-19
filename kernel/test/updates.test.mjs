// Release updates (docs/design/release-updates.md), end to end on local repositories standing in for GitHub: the distro, kernel
// and modules repos under <base>/Aiden-HQ/, an instance repo with a bare origin (codehost-local's, as setup makes it), a product
// checkout. The published asset and the workflow run are a fake download; the kernel's record is a fake whose state the test
// sets (the planner and the apply executor have their own tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { Refused, candidateMarked, check, compareRelease, createUpdates, pinText, pinTo, readState, verify } from "../src/updates.ts";
import { localApply } from "../../modules/codehost-local/src/apply.ts";

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

// A release file. `market` given: one from before 2026-11-18, which also named the official modules repo's sha and each
// module's; without it, today's: the kernel sha alone names the official modules (its own modules/).
const release = (name, kernel, market, over = {}) => ({
  release: name, kernel, kernel_repo: "Aiden-HQ/AidenHQ",
  ...(market ? { name: "AidenHQ", marketplace: { name: "aidenhq", source: { source: "github", repo: "Aiden-HQ/aidenhq-modules" }, sha: market }, modules: { board: market } } : {}),
  tested: { ci_run: "", suites: ["kernel-only"] },
  images: { board: `ghcr.io/aiden-hq/board@sha256:${"a".repeat(64)}` }, notes: ["Updates install themselves"], ...over,
});

/** The world: 2026.11.2 running (kernel K1, modules M1: from before the official modules were the kernel's own), 2026.11.3 tagged on the distro's main (K2, one sha). */
function world({ auto = "on", next = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "updates-"));
  const base = join(root, "gh");
  const kernel = repo(base, "AidenHQ", [{ "a.txt": "1" }, { "a.txt": "2" }]);
  const modules = repo(base, "aidenhq-modules", [{ "m.txt": "1" }, { "m.txt": "2" }]);
  const [K1, K2] = kernel.shas, [M1, M2] = modules.shas;
  const files = { "2026.11.2": release("2026.11.2", K1, M1), "2026.11.3": release("2026.11.3", K2, undefined, typeof next === "function" ? next({ K1, K2, M1, M2 }) : next) };
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
  const published = {};
  for (const [n, f] of Object.entries(files)) published[n] = { ...f, tested: { ci_run: `https://github.com/Aiden-HQ/aidenhq-distro/actions/runs/${n === "2026.11.3" ? 22 : 11}`, suites: ["kernel-only", "swap"] } };
  // GitHub's Releases API: every tag is a published release; a name in `pre` is a pre-release (not graduated yet).
  const tags = Object.keys(files), pre = new Set();
  const rel = (t) => ({ tag_name: t, draft: false, prerelease: pre.has(t) });
  const runs = { 11: { path: ".github/workflows/release.yml", head_sha: D1, head_branch: "2026.11.2", event: "push", status: "completed", conclusion: "success" }, 22: { path: ".github/workflows/release.yml", head_sha: D2, head_branch: "2026.11.3", event: "push", status: "completed", conclusion: "success" } };
  const d = {
    base, fetch: { cacheDir: join(root, "cache") }, inst: join(root, "inst"), product: join(root, "product"), dir: join(root, "state", "updates"), board: join(root, "state", "board", "updates.json"),
    download: async (u) => {
      const list = /\/releases\?per_page=100&page=(\d+)$/.exec(u), tag = /\/releases\/tags\/([\d.]+)$/.exec(u);
      if (list) return list[1] === "1" ? tags.map(rel) : [];
      if (tag) { if (!tags.includes(tag[1])) throw new Error(`${u} answered 404`); return rel(tag[1]); }
      const a = /releases\/download\/([\d.]+)\//.exec(u), r = /actions\/runs\/(\d+)$/.exec(u);
      if (a) return published[a[1]];
      if (r) return runs[r[1]];
      throw new Error(`unexpected ${u}`);
    },
  };
  const pinned = () => { git(d.inst, "fetch", "-q", "origin"); return YAML.parse(git(d.inst, "show", "origin/main:instance.yaml")); };
  return { root, d, K1, K2, M1, M2, D1, D2, published, runs, pinned, distro, files, tags, pre };
}



/** The kernel's side over a world: the check runs in-process at `now`; filing and records are fakes the test reads and sets. */
function kernelSide(w, { lines = [], filed = [], now = DAY } = {}) {
  w.records = {};
  let n = 0, due = false;
  const u = createUpdates({
    db: new DatabaseSync(":memory:"), dir: w.d.dir, board: w.d.board, ownerLine: (t) => lines.push(t),
    check: async (asked) => void (await check({ ...w.d, now: () => now }, asked)),
    file: async (r) => { const record = `rec-${++n}`; filed.push({ ...r, record }); w.records[record] = { state: "review" }; return { record, task: `task-${n}` }; },
    record: (id) => w.records[id], close: async () => {},
    // A pass checks only when an hour has gone by (or Update now): the test moves the clock on with checkNow().
    now: () => (due ? (due = false, Date.now() + 10 * 3_600_000 * ++n) : Date.now()),
  });
  return Object.assign(u, { checkNow: () => { due = true; } });
}

test("nightly names sort by date, and a day's second cut between that day and the next", () => {
  const names = ["2026.11.19", "2026.11.18.1", "2026.11", "2026.11.18", "2026.12.1", "2026.11.2", "2026.11.18.2"];
  assert.deepEqual(names.sort(compareRelease), ["2026.11", "2026.11.2", "2026.11.18", "2026.11.18.1", "2026.11.18.2", "2026.11.19", "2026.12.1"]);
});

test("a newer release is found and verified; by day nothing installs, and the owner is told once", async () => {
  const w = world();
  const s = await check({ ...w.d, now: () => DAY });
  assert.equal(s.current.name, "2026.11.2");
  assert.equal(s.available.name, "2026.11.3");
  assert.equal(s.available.kernel, w.K2);
  assert.deepEqual(s.available.notes, ["Updates install themselves"]);
  assert.equal(s.ready, undefined, "by day: nothing is prepared");
  const shown = JSON.parse(readFileSync(w.d.board, "utf8"));
  assert.equal(shown.available.name, "2026.11.3");
  assert.equal(shown.available.kernel, undefined, "the board's copy carries what it shows only");
  const lines = [];
  const u = kernelSide(w, { lines });
  await u.tick(); await u.tick();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2026\.11\.3 is available\. It is filed for install tonight between 2:00 and 5:00 \(Asia\/Dubai\)/);
});

test("verification refuses a mismatched sha, a stamp from another or a failed run, a kernel off main, a module off history and a downgrade", async () => {
  const w = world();
  const text = git(w.d.inst, "show", "HEAD:instance.yaml");
  w.published["2026.11.3"] = { ...w.published["2026.11.3"], kernel: w.K1 };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), (e) => e instanceof Refused && /published release file isn't the one at its tag/.test(e.message));
  w.published["2026.11.3"] = { ...w.files["2026.11.3"], tested: { ci_run: "https://github.com/Aiden-HQ/aidenhq-distro/actions/runs/11", suites: ["swap"] } };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), /tested stamp doesn't name a successful release run on its commit/);
  w.published["2026.11.3"] = { ...w.files["2026.11.3"], tested: { ci_run: "https://github.com/Aiden-HQ/aidenhq-distro/actions/runs/22", suites: ["swap"] } };
  // The nightly's run: a dispatch on the tag counts; a dispatch on a branch at the same commit doesn't; one still running is retried.
  w.runs[22] = { ...w.runs[22], event: "workflow_dispatch" };
  assert.equal((await verify(w.d, text, "2026.11.3", w.D2)).name, "2026.11.3");
  w.runs[22] = { ...w.runs[22], head_branch: "main" };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), (e) => e instanceof Refused && /successful release run/.test(e.message));
  w.runs[22] = { ...w.runs[22], head_branch: "2026.11.3", status: "in_progress", conclusion: null };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), (e) => !(e instanceof Refused) && /still running/.test(e.message));
  w.runs[22] = { ...w.runs[22], status: "completed", conclusion: "failure" };
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), /successful release run/);
  await assert.rejects(verify(w.d, text, "2026.11.1", w.D1), /isn't newer than 2026\.11\.2: downgrades are refused/);
  // A file that still names an official marketplace or module shas: not read (the kernel's own modules/ are the official ones).
  const old = world({ next: ({ K1 }) => ({ marketplace: { name: "aidenhq", source: { source: "github", repo: "evil/modules" }, sha: K1 }, modules: { board: K1 } }) });
  assert.equal((await verify(old.d, git(old.d.inst, "show", "HEAD:instance.yaml"), "2026.11.3", old.D2)).name, "2026.11.3");
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
  side.tags.push("2026.11.4");
  await assert.rejects(verify(side.d, git(side.d.inst, "show", "HEAD:instance.yaml"), "2026.11.4", D4), /kernel [0-9a-f]{12} isn't on Aiden-HQ\/AidenHQ's main/);
  const s = await check({ ...side.d, now: () => NIGHT });
  assert.equal(s.available.name, "2026.11.3");
  assert.ok(s.events.some((e) => e.id === "refused:2026.11.4"));
  assert.deepEqual([s.ready.release, s.ready.by], ["2026.11.3", "auto-update"]);
});

test("a network error is retried, never reported as a refused release", async () => {
  const w = world();
  w.d.download = async () => { throw new Error("api.github.com answered 503"); };
  const s = await check({ ...w.d, now: () => NIGHT });
  assert.equal(s.available, null);
  assert.match(s.error, /503/);
  assert.ok(!s.events?.some((e) => e.id.startsWith("refused:")));
  assert.equal(s.ready, undefined);
});

test("only graduated releases install: a pre-release is never offered or said, and the host's candidate run takes exactly the one it names", async () => {
  const w = world();
  w.pre.add("2026.11.3");
  const text = git(w.d.inst, "show", "HEAD:instance.yaml");
  let s = await check({ ...w.d, now: () => NIGHT });
  assert.deepEqual([s.available, s.ready, s.error], [null, undefined, undefined]);
  assert.ok(!s.events?.length, "a cut still being tested is nothing to tell the owner");
  await assert.rejects(verify(w.d, text, "2026.11.3", w.D2), (e) => e instanceof Refused && /pre-release: it hasn't graduated/.test(e.message));
  // The kernel's own check (no candidate), even asked by name, never takes it.
  s = await check({ ...w.d, now: () => DAY }, { release: "2026.11.3", by: "account:a1" });
  assert.equal(s.ready, undefined);
  // The host's candidate run: that tag alone, prepared and marked with its distro commit; the planner's verify (the CLI reads
  // the mark from the state file) accepts it for exactly that release and commit.
  s = await check({ ...w.d, now: () => DAY }, { release: "2026.11.3", by: "graduate" }, "2026.11.3");
  assert.deepEqual([s.ready.release, s.ready.by, s.ready.candidate], ["2026.11.3", "graduate", w.D2]);
  const st = readState(w.d.dir);
  assert.ok(candidateMarked(st, "2026.11.3", w.D2));
  assert.ok(!candidateMarked(st, "2026.11.3", w.D1) && !candidateMarked({}, "2026.11.3", w.D2));
  assert.equal((await verify(w.d, text, "2026.11.3", w.D2, candidateMarked(st, "2026.11.3", w.D2))).name, "2026.11.3");
  // Graduated: the night takes it as any release.
  const g = world();
  assert.equal((await check({ ...g.d, now: () => NIGHT })).ready.release, "2026.11.3");
  // The releases API failing is the network's: retried, never a refusal.
  const n = world();
  const dl = n.d.download;
  n.d.download = async (u) => { if (/\/releases(\?|\/tags)/.test(u)) throw new Error("api.github.com answered 403"); return dl(u); };
  s = await check({ ...n.d, now: () => NIGHT });
  assert.match(s.error, /403/);
  assert.ok(!s.events?.some((e) => e.id.startsWith("refused:")));
  await assert.rejects(verify(n.d, text, "2026.11.3", n.D2), (e) => !(e instanceof Refused) && /403/.test(e.message));
});

test("auto-updates off: at night the release is only offered, never prepared", async () => {
  const w = world({ auto: "off" });
  const s = await check({ ...w.d, now: () => NIGHT });
  assert.equal(s.auto, false);
  assert.equal(s.available.name, "2026.11.3");
  assert.match(s.events.at(-1).text, /Auto-updates are off: file it from Settings > Instance \(Update now\)/);
  assert.equal(s.ready, undefined);
});

test("the night files the release as one kernel.apply, which codehost-local lands; its outcome is told once", async () => {
  const w = world();
  // A local product mirror (origin a path), as setup makes: the verified kernel goes onto its main, where the planner reads it.
  const mirror = join(w.root, "mirror.git");
  git(w.root, "clone", "-q", "--bare", join(w.root, "gh", "src", "AidenHQ"), mirror);
  git(join(w.root, "gh", "src", "AidenHQ"), "push", "-q", mirror, `${w.K1}:refs/heads/main`, "--force");
  git(w.d.product, "remote", "set-url", "origin", mirror);
  const lines = [], filed = [];
  const u = kernelSide(w, { lines, filed, now: NIGHT });
  await u.tick();
  assert.equal(git(mirror, "rev-parse", "main"), w.K2);
  assert.equal(filed.length, 1);
  const r = filed[0];
  assert.deepEqual([r.release, r.branch, r.by], ["2026.11.3", "release/2026.11.3", "auto-update"]);
  assert.equal(w.pinned().product, w.K1, "the instance's main is untouched until the record lands it");
  // The code host's side of that record, on the same bare repo: what the planner reads, then the land.
  const host = localApply({ bare: join(w.root, "inst.git"), instanceRepo: "local/aidenhq-instance" });
  const read = await host.read({ repo: "local/aidenhq-instance", branch: r.branch, sha: r.sha });
  assert.deepEqual(read.files, ["instance.yaml"]);
  const p = YAML.parse(read.texts.head["instance.yaml"]);
  assert.equal(p.product, w.K2);
  assert.deepEqual(p.release, { name: "2026.11.3", source: { source: "github", repo: "Aiden-HQ/aidenhq-distro" }, sha: w.D2 });
  assert.equal(p.marketplaces, undefined, "the obsolete `aidenhq` marketplace entry (its only one) is gone, and the key with it");
  assert.match(read.texts.head["instance.yaml"], /^# acme's AidenHQ\./, "comments kept");
  await assert.rejects(host.land({ repo: "local/aidenhq-instance", branch: r.branch, sha: r.sha, official: { from: { repo: "a/b", sha: w.M1 }, to: null } }), /official modules' marketplace pin/);
  assert.equal((await host.land({ repo: "local/aidenhq-instance", branch: r.branch, sha: r.sha, official: { from: null, to: null } })).landed, r.sha);
  assert.equal(w.pinned().product, w.K2);
  // Still in flight: nothing more is filed; done: installed, told once.
  await u.tick();
  assert.equal(filed.length, 1);
  w.records[r.record] = { state: "done" };
  await u.tick(); await u.tick();
  const s = readState(w.d.dir);
  assert.deepEqual([s.last.outcome, s.current.name, s.flight], ["installed", "2026.11.3", undefined]);
  assert.equal(lines.filter((l) => /updated to 2026\.11\.3 \(from 2026\.11\.2\)\. What changed: Updates install themselves/.test(l)).length, 1);
});

test("a failed record: the owner is told why, the night doesn't file it again, Update now does", async () => {
  const w = world();
  const lines = [], filed = [];
  const u = kernelSide(w, { lines, filed, now: NIGHT });
  await u.tick();
  w.records[filed[0].record] = { state: "failed", outcome: { text: "**Landed, but the apply failed** (exit-code)\nlog" } };
  await u.tick();
  assert.equal(readState(w.d.dir).last.outcome, "failed");
  // A killed install claims nothing: still on the release it ran, nothing in flight, the release recorded as failed, one notice.
  const st = readState(w.d.dir);
  assert.deepEqual([st.current.name, st.flight, st.failed], ["2026.11.2", undefined, ["2026.11.3"]]);
  await u.tick();
  assert.equal(lines.filter((l) => /didn't install/.test(l)).length, 1);
  assert.ok(lines.some((l) => /2026\.11\.3 didn't install: \*\*Landed, but the apply failed\*\* \(exit-code\)\. The night won't file it again/.test(l)));
  u.checkNow();
  await u.tick();
  assert.equal(filed.length, 1, "the night skips it");
  assert.throws(() => u.requestNow("2026.11.9", "account:a1"), /isn't the one available/);
  assert.match(u.requestNow("2026.11.3", "account:a1"), /Filing 2026\.11\.3 now/);
  await u.tick();
  assert.deepEqual([filed.length, filed[1].by], [2, "account:a1"], "Update now files it");
});

test("the installer run again moves the pin to its release; the same release is a repair, an older one is refused", () => {
  const w = world();
  assert.throws(() => pinTo(w.d, "2026.11.1", w.D1, w.K1), (e) => e instanceof Refused && /runs 2026\.11\.2, newer than 2026\.11\.1: downgrades are refused/.test(e.message));
  // A repair of an instance from before 2026-11-18: only its obsolete `aidenhq` marketplace entry goes, in a commit of its own.
  assert.match(pinTo(w.d, "2026.11.2", w.D1, w.K1), /^already on 2026\.11\.2; instance\.yaml now pins it without the obsolete aidenhq marketplace entry$/);
  assert.deepEqual([w.pinned().product, w.pinned().marketplaces], [w.K1, undefined]);
  assert.equal(pinTo(w.d, "2026.11.2", w.D1, w.K1), "already on 2026.11.2");
  assert.throws(() => pinTo(w.d, "2026.11.3", w.D2, w.K1), /kernel is [0-9a-f]{12}, but this checkout is at/);
  assert.match(pinTo(w.d, "2026.11.3", w.D2, w.K2), /now pins 2026\.11\.3 \(from 2026\.11\.2\)/);
  const p = w.pinned();
  assert.deepEqual([p.product, p.release.name, p.release.sha, p.marketplaces], [w.K2, "2026.11.3", w.D2, undefined]);
  // The upgrade from an instance that still has the entry drops it in the same pin commit.
  const u = world();
  assert.match(pinTo(u.d, "2026.11.3", u.D2, u.K2), /now pins 2026\.11\.3/);
  assert.equal(u.pinned().marketplaces, undefined);
  const h = world();
  writeFileSync(join(h.d.inst, "instance.yaml"), `product: ${h.K1}\n`);
  git(h.d.inst, "commit", "-qam", "by hand");
  git(h.d.inst, "push", "-q", "origin", "HEAD:main");
  assert.match(pinTo(h.d, "2026.11.3", h.D2, h.K2), /pins its product by hand: left as it is/);
});

test("before the first check, the page's view reads the followed release from the instance", () => {
  const w = world();
  const u = kernelSide(w);
  assert.equal(u.view().current, undefined);
  const withInst = createUpdates({ db: new DatabaseSync(":memory:"), dir: w.d.dir, inst: w.d.inst, ownerLine() {}, check: async () => {}, file: async () => ({ record: "", task: "" }), record: () => undefined, close: async () => {} });
  assert.equal(withInst.view().current.name, "2026.11.2");
});

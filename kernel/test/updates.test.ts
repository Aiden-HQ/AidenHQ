// Release updates (docs/design/release-updates.md), end to end on local repositories standing in for GitHub: the distro, kernel
// and modules repos under <base>/Aiden-HQ/, an instance repo with a bare origin (codehost-local's, as setup makes it), a product
// checkout. The published asset and the workflow run are a fake download; the kernel's record is a fake whose state the test
// sets (the planner and the apply executor have their own tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { Refused, candidateMarked, check, createUpdates, gitOwn, ownCredentials, readState, runCheck, verify, verifyMain } from "../src/updates.ts";
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
function kernelSide(w, { lines = [], filed = [], closed = [], now = DAY } = {}) {
  w.records = {};
  let n = 0, due = false;
  const u = createUpdates({
    db: new DatabaseSync(":memory:"), dir: w.d.dir, board: w.d.board, ownerLine: (t) => lines.push(t),
    check: async (asked) => void (await check({ ...w.d, now: () => now }, asked)),
    main: async (to) => { const m = await verifyMain(w.d, git(w.d.inst, "show", "origin/main:instance.yaml"), to); return { sha: m.sha, compare: m.compare }; },
    file: async (r) => { const record = `rec-${++n}`; filed.push({ ...r, record }); w.records[record] = { state: "review" }; return { record, task: `task-${n}` }; },
    record: (id) => w.records[id], close: async (task, body, status) => { closed.push({ task, body, status }); },
    // A pass checks only when an hour has gone by (or Update now): the test moves the clock on with checkNow().
    now: () => (due ? (due = false, Date.now() + 10 * 3_600_000 * ++n) : Date.now()),
  });
  return Object.assign(u, { checkNow: () => { due = true; } });
}

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
  assert.ok(lines.some((l) => /2026\.11\.3 didn't install: \*\*Landed, but the apply failed\*\* \(exit-code\)\. This server stays on 2026\.11\.2: a failed apply puts the host back on it and holds it there.*The night won't file it again/.test(l)));
  u.checkNow();
  await u.tick();
  assert.equal(filed.length, 1, "the night skips it");
  assert.throws(() => u.requestNow("2026.11.9", "account:a1"), /isn't the one available/);
  assert.match(u.requestNow("2026.11.3", "account:a1"), /Filing 2026\.11\.3 now/);
  await u.tick();
  assert.deepEqual([filed.length, filed[1].by], [2, "account:a1"], "Update now files it");
});

test("a release apply that did not install closes its task cancelled; one that installed closes it done", async () => {
  // A rejected card used to close the task done with a "**Not installed:**" body, so a failed release counted as shipped.
  const rej = world();
  const lines = [], filed = [], closed = [];
  const u = kernelSide(rej, { lines, filed, closed, now: NIGHT });
  await u.tick();
  rej.records[filed[0].record] = { state: "rejected" };
  await u.tick();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].task, "task-1");
  assert.equal(closed[0].status, "cancelled");
  assert.match(closed[0].body, /^\*\*Not installed:\*\* the card was rejected\.$/);
  assert.deepEqual([readState(rej.d.dir).last.outcome, readState(rej.d.dir).flight], ["failed", undefined]);
  // A failed apply is not an install either.
  const bad = world();
  const badFiled = [], badClosed = [];
  const bu = kernelSide(bad, { lines: [], filed: badFiled, closed: badClosed, now: NIGHT });
  await bu.tick();
  bad.records[badFiled[0].record] = { state: "failed", outcome: { text: "the image could not be pulled" } };
  await bu.tick();
  assert.deepEqual([badClosed[0]?.status, badClosed[0]?.body], ["cancelled", "**Not installed:** the image could not be pulled."]);
  // The same follower, with the record ending done: the task is closed done and the body says it installed.
  const done = world();
  const dfiled = [], dclosed = [];
  const du = kernelSide(done, { lines: [], filed: dfiled, closed: dclosed, now: NIGHT });
  await du.tick();
  done.records[dfiled[0].record] = { state: "done" };
  await du.tick();
  assert.equal(dclosed.length, 1);
  assert.deepEqual([dclosed[0].status, /^Installed: this server runs AidenHQ 2026\.11\.3\.$/.test(dclosed[0].body)], ["done", true]);
});

test("the instance checkout is fetched with its own credential helper; a URL that isn't ours never sees one", () => {
  const w = world();
  git(w.d.inst, "config", "credential.helper", "!f() { echo username=owner; echo password=secret; }; f");
  git(w.d.inst, "config", "credential.useHttpPath", "true");
  // What git would run for a fetch here: the checkout's helper is last, and so wins, only when nothing resets it after.
  const helpers = (...a) => execFileSync("git", [...a, "config", "--get-all", "credential.helper"], { cwd: w.d.inst, encoding: "utf8" }).replace(/\n$/, "").split("\n");
  assert.deepEqual(gitOwn(w.d.inst, ["config", "--get-all", "credential.helper"]).trim().split("\n").length, 1);
  assert.deepEqual(helpers("-c", "credential.helper="), [helpers()[0], ""]);
  // A fresh clone of its origin gets the same settings as -c arguments.
  assert.deepEqual(gitOwn(tmpdir(), ["config", "--get-all", "credential.helper"], ownCredentials(w.d.inst)).trim().split("\n"), [helpers()[0]]);
  assert.deepEqual(ownCredentials(join(w.root, "product")), []);
  // A failing git names its subcommand and git's words, never the argv (which holds the credential settings).
  assert.throws(() => gitOwn(tmpdir(), ["clone", "-q", "--", join(w.root, "missing"), "c"], ownCredentials(w.d.inst)), (e) => /^git clone failed/.test(e.message) && !/secret|credential/.test(e.message));
  // Only "none configured" (exit 1) is no credentials; an unreadable checkout throws.
  assert.throws(() => ownCredentials(join(w.root, "missing")));
});
test("the check's child exits non-zero when a pass hits an operational failure, so the kernel's failing counter (and its page) sees it", async () => {
  // A real child: node kernel/src/updates.ts check, with the instance checkout missing so its git fetch can't run. The pass
  // records the failure in the state's error and used to exit 0, which the kernel's runCheck read as a clean pass.
  const dir = mkdtempSync(join(tmpdir(), "upd-child-")), data = join(dir, "data"), state = join(dir, "state");
  const inst = join(dir, "missing-instance");
  const env = { ...process.env, AIDENHQ_INSTANCE_DIR: inst, AIDENHQ_DATA_DIR: data, AIDENHQ_STATE_DIR: state };
  await new Promise((ok, no) => execFile(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../src/updates.ts"), "check"], { env, timeout: 60_000 }, (e, _out, err) => (e ? no(Object.assign(e, { stderr: String(err) })) : ok()))).then(
    () => assert.fail("an operational failure must not exit 0"),
    (e) => { assert.notEqual(e.code, 3, "not a refusal"); assert.notEqual(e.code, 0); },
  );
  // runCheck (what the kernel's pass calls) is pointed at the same temporary fixture, never a developer's live instance.
  const keep = { inst: process.env.AIDENHQ_INSTANCE_DIR, data: process.env.AIDENHQ_DATA_DIR, state: process.env.AIDENHQ_STATE_DIR };
  Object.assign(process.env, { AIDENHQ_INSTANCE_DIR: inst, AIDENHQ_DATA_DIR: data, AIDENHQ_STATE_DIR: state });
  try {
    await assert.rejects(runCheck(join(import.meta.dirname, "../.."))(null), /git fetch failed|update: check failed/i);
  } finally {
    for (const [k, v] of [["AIDENHQ_INSTANCE_DIR", keep.inst], ["AIDENHQ_DATA_DIR", keep.data], ["AIDENHQ_STATE_DIR", keep.state]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("the real child exits non-zero for an operational failure the pass recorded (not only one it threw), so a stalled train pages", async () => {
  // A release-following checkout whose distro can't be reached: the pass records the failure in its state and returns it. Before,
  // that path exited 0, so the kernel's runCheck read a stalled release train as a clean pass and `failing` never reached its page.
  const dir = mkdtempSync(join(tmpdir(), "upd-recorded-")), src = join(dir, "src");
  mkdirSync(src);
  git(src, "init", "-q");
  writeFileSync(join(src, "instance.yaml"), `product: ${"a".repeat(40)}\nrelease: { name: "2026.11.2", source: { source: github, repo: Aiden-HQ/aidenhq-distro }, sha: ${"b".repeat(40)} }\n`);
  git(src, "add", "-A"); git(src, "commit", "-qm", "instance");
  git(dir, "clone", "-q", "--bare", src, join(dir, "inst.git"));
  git(dir, "clone", "-q", join(dir, "inst.git"), "inst");
  const data = join(dir, "data"), state = join(dir, "state");
  const env = {
    ...process.env, AIDENHQ_INSTANCE_DIR: join(dir, "inst"), AIDENHQ_DATA_DIR: data, AIDENHQ_STATE_DIR: state,
    // git's own URL rewrite: the official distro fetch lands on a path that doesn't exist (an unreachable host in miniature).
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${join(dir, "missing-distro")}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/Aiden-HQ/aidenhq-distro.git",
  };
  const code = await new Promise((ok) => execFile(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../src/updates.ts"), "check"], { env, timeout: 60_000 }, (e) => ok(e ? (e as { code?: unknown }).code : 0)));
  assert.notEqual(code, 0, "the recorded operational failure is a failed pass");
  assert.notEqual(code, 3, "not a refusal: the host's answer is not this");
  const recorded = readState(join(data, "updates"));
  assert.equal(recorded.checkFailed, true);
  assert.match(String(recorded.error), /ls-remote|fetch failed/);
});

test("a check that records an operational failure in its state still exits non-zero; a refusal stays exit 3", async () => {
  // In-process: a releases API failure is operational and recorded (not a release the server refused), so the pass is marked.
  const w = world();
  const dl = w.d.download;
  w.d.download = async (u) => { if (/\/releases(\?|\/tags)/.test(u)) throw new Error("api.github.com answered 403"); return dl(u); };
  const s = await check({ ...w.d, now: () => NIGHT });
  assert.equal(s.checkFailed, true);
  assert.match(String(s.error), /403/);
  // A release that fails this server's checks is an answer, not a failed pass.
  const r = world({ next: { kernel: "0".repeat(40) } });
  const refused = await check({ ...r.d, now: () => NIGHT });
  assert.equal(refused.checkFailed, undefined);
  assert.match(String(refused.error), /was refused/);
});

test("a refused main move is the answer for that pass: a release-lookup failure in the same pass doesn't turn it into a failed pass", async () => {
  // Update now for a main commit: release discovery runs first in the pass, then the move is verified. When the host refuses the
  // move (not on main, already running, …) that is the answer; a discovery failure from the same pass must not leave
  // `checkFailed` set, or the child exits non-zero and the parent retries a refusal and pages the owner as if it were an outage.
  const w = world();
  const dl = w.d.download;
  const s = await check({ ...w.d, now: () => NIGHT, download: async (u) => { if (/\/releases(\?|\/tags)/.test(u)) throw new Error("api.github.com answered 503"); return dl(u); } }, { release: "0".repeat(40), by: "owner" });
  assert.equal(s.checkFailed, undefined, "the refusal is not an operational failure");
  assert.match(String(s.error), /isn't in|doesn't descend|already runs/);
  // The same discovery failure with no main move asked for is still operational: it must page.
  const r = await check({ ...w.d, now: () => NIGHT, download: async (u) => { if (/\/releases(\?|\/tags)/.test(u)) throw new Error("api.github.com answered 503"); return dl(u); } });
  assert.equal(r.checkFailed, true);
});

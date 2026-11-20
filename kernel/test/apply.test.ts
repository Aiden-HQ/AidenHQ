// kernel.apply (apply.ts): what may land, and the executor end to end through the write records: land, queue the apply
// once, follow it to the generation that applied the commit, and carry on after the restart the apply itself causes without
// ever launching it again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpTitle, createApply, isTrial, officialMove, readDigest, strayFiles } from "../src/apply.ts";
import { openRecords } from "../src/records.ts";
import { openFacts } from "../src/facts.ts";
import { createDeploys } from "../src/generations.ts";
import { createWrites } from "../src/writes.ts";

test("only instance config can be applied", () => {
  assert.deepEqual(strayFiles(["instance.yaml", "apps.yaml", "agents/chief-of-staff.md", "agents/review-chaser/agent.yaml", "agents/review-chaser/AGENTS.md"]), []);
  assert.deepEqual(strayFiles(["agents/x/run.sh", "agents/X/agent.yaml", "agents/x/y/AGENTS.md"]), ["agents/x/run.sh", "agents/X/agent.yaml", "agents/x/y/AGENTS.md"]);
  assert.deepEqual(strayFiles(["instance.yaml", "ops/apply-config.sh", "agents/x/evil.md"]), ["ops/apply-config.sh", "agents/x/evil.md"]);
});
test("a product pin move is described honestly", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  assert.equal(bumpTitle({ to: b }), "Product pinned at `bbbbbbbbb`");
  assert.equal(bumpTitle({ from: a, to: b, forward: true }), "Product upgrade `aaaaaaaaa` → `bbbbbbbbb`, adding these commits");
  assert.equal(bumpTitle({ from: a, to: b, back: true }), "Product DOWNGRADE (rollback) `aaaaaaaaa` → `bbbbbbbbb`, removing these commits");
  assert.equal(bumpTitle({ from: a, to: b }), undefined); // diverged: refused
});
test("apply-config reads the pin with the same parser (CLI), in every form YAML allows", () => {
  const sha = "c".repeat(40);
  for (const line of [`product: ${sha}`, `product: "${sha}"`, `product: '${sha}'  # pinned`]) {
    const f = join(mkdtempSync(join(tmpdir(), "pin-")), "instance.yaml");
    writeFileSync(f, `${line}\nmodules: []\n`);
    assert.equal(execFileSync("node", [new URL("../src/apply.ts", import.meta.url).pathname, "product-pin", f], { encoding: "utf8" }), sha);
  }
});
test("trial is read as YAML, like compile", () => {
  assert.equal(isTrial("trial: true\n"), true);
  assert.equal(isTrial("notes: |\n  trial: true\n"), false);
  assert.equal(isTrial("trial: true\ntrial: false\n"), false, "unparseable: not in trial");
});

const SHA = "d".repeat(40);
const until = async (fn) => { for (let i = 0; i < 300 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(await fn()); };
/** This host as the executor sees it: the code host, systemd, the generations file and the instance's history, all fakes that count. */
const READ = (files = ["instance.yaml"]) => ({ files, texts: { base: { "instance.yaml": "product: x\n" }, head: { "instance.yaml": "product: y\n" } }, diff: "" });
function fakeHost({ files = ["instance.yaml"] } = {}) {
  const h = {
    launches: [], lands: [], units: {}, gens: [{ n: 1, instance: "e".repeat(40), health: "good" }], hang: false,
    // commit → the commits it contains besides itself.
    history: {},
    read: READ(files),
    codehost: { read: async () => h.read, land: async (s) => (h.lands.push(s), { landed: s.sha }) },
    launch: async (u) => { h.launches.push(u); h.units[u] = { loaded: true, active: "active", sub: "running", result: "success" }; },
    // A kernel that hangs here is one the apply has just restarted: it never sees the unit end.
    unit: (u) => (h.hang ? new Promise(() => {}) : Promise.resolve(h.units[u] ?? { loaded: false, active: "inactive", sub: "dead", result: "success" })),
    generations: () => h.gens, contains: async (sha, c) => c === sha || (h.history[c] ?? []).includes(sha), tail: async () => "apply-config: the health check failed",
  };
  return h;
}
/** One kernel process: its records on `db` and the writes lifecycle with kernel.apply executed natively (as after the switch). */
function kernel(db, h) {
  const records = openRecords(db);
  const applies = createApply({ db: records.db, ...h, pollMs: 5 });
  const notices = [];
  const writes = createWrites({
    records, registry: () => ({ "kernel.apply": { module: "kernel", floor: 1, tools: [] } }), connections: () => ({}), secret: () => "", resolver: {},
    onTask: { open: async () => true, notify: async (task, text) => void notices.push(text) }, replay: async () => ({ ok: false, text: "" }),
    native: { "kernel.apply": applies.execute }, resume: ["kernel.apply"],
  });
  return { records, applies, writes, notices };
}
const claimed = (records, files = ["instance.yaml"]) => records.file({
  kind: "kernel.apply", module: "kernel", args: { repo: "acme/aidenhq-instance", branch: "fleet/edit", sha: SHA, files }, targets: { content: readDigest(READ(files)) }, executor: { module: "kernel" }, policy: "p",
  card: { sentence: "Apply.", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "", key: "", name: "the runner", roles: [], kind: "runner" },
  task: "TASK-1", identifier: "ACME-1", tier: 1, panel: false, state: "claimed",
});
const dbFile = () => join(mkdtempSync(join(tmpdir(), "apply-")), "kernel.db");

test("an apply lands its commit from the task's workspace, queues its apply once and is done when a generation applies it", async () => {
  const h = fakeHost();
  const k = kernel(dbFile(), h);
  const r = claimed(k.records);
  const done = k.applies.execute(r);
  await until(() => h.launches.length === 1);
  h.gens.push({ n: 2, instance: SHA, health: "good" });
  delete h.units[h.launches[0]];
  const o = await done;
  assert.equal(o.ok, true, o.text);
  assert.deepEqual(h.lands, [{ repo: "acme/aidenhq-instance", branch: "fleet/edit", sha: SHA, workspace: "ACME-1", official: { from: null, to: null } }]);
  assert.deepEqual(h.launches, [`aidenhq-apply-${r.id}`]);
  // A commit that no longer changes the approved files lands nothing.
  const h2 = fakeHost({ files: ["instance.yaml", "ops/apply-config.sh"] });
  const k2 = kernel(dbFile(), h2);
  assert.match((await k2.applies.execute(claimed(k2.records))).text, /no longer changes the files that were approved/);
  assert.deepEqual([h2.lands.length, h2.launches.length], [0, 0]);
  // Nor does one whose content moved under the same files (the workspace rewrote what the sha resolves to, say): the land
  // re-reads the commit and lands only exactly what was reviewed.
  const h3 = fakeHost();
  h3.read = { ...READ(), texts: { base: { "instance.yaml": "product: x\n" }, head: { "instance.yaml": "product: z\n" } }, diff: "-product: x\n+product: z\n" };
  const k3 = kernel(dbFile(), h3);
  assert.match((await k3.applies.execute(claimed(k3.records))).text, /no longer exactly what was approved/);
  assert.deepEqual([h3.lands.length, h3.launches.length], [0, 0]);
});

test("a crash between launching the unit and recording its outcome never starts a second apply", async () => {
  const db = dbFile();
  const h = fakeHost();
  h.hang = true;
  const a = kernel(db, h);
  const r = claimed(a.records);
  void a.applies.execute(r); // the apply restarts this kernel right after systemd-run returns
  await until(() => h.launches.length === 1);
  // The next kernel: the unit is still running, then ends well. Its start's reconcile follows the record, never launches it.
  h.hang = false;
  const b = kernel(db, h);
  await b.writes.reconcile();
  await new Promise((ok) => setTimeout(ok, 30));
  assert.equal(b.records.get(r.id).state, "claimed", "still running: followed, not settled");
  h.gens.push({ n: 2, instance: SHA, health: "good" });
  delete h.units[h.launches[0]];
  await until(() => b.records.get(r.id).state === "done");
  assert.equal(h.launches.length, 1);
  assert.equal(h.lands.length, 1);
  // A kernel that died after writing the launch intent but before systemd started anything: the unit is unknown to systemd
  // and no generation applied the commit, so it fails, and nothing launches it again.
  const db2 = dbFile();
  const h2 = fakeHost();
  h2.launch = async () => new Promise(() => {});
  const c = kernel(db2, h2);
  const r2 = claimed(c.records);
  void c.applies.execute(r2);
  await until(() => c.records.db.prepare("SELECT unit FROM applies WHERE record = ?").get(r2.id)?.unit);
  const h3 = fakeHost();
  const d = kernel(db2, h3);
  await d.writes.reconcile();
  await until(() => d.records.get(r2.id).state === "failed");
  assert.match(d.records.get(r2.id).outcome.text, /no apply applied it.*not started again/s);
  assert.equal(h3.launches.length, 0);
});

test("a land whose answer was lost lands on its retry, and a systemd that can't be read for a moment isn't an outcome", async () => {
  const h = fakeHost();
  // The land pushes, then its answer times out (no status): the retry finds the commit on main (merge base = the commit, an
  // empty diff) and takes the code host's no-op land, never "no longer changes the files that were approved".
  let pushed = false;
  h.codehost.read = async () => (pushed ? { files: [], texts: { base: {}, head: {} }, diff: "", base: SHA, main: SHA } : h.read);
  h.codehost.land = async (s) => { h.lands.push(s); pushed = true; throw new Error("the code host's land didn't answer in 3 minutes"); };
  // And systemctl show fails twice while the unit runs.
  let fails = 2;
  const unit = h.unit;
  h.unit = (u) => (fails-- > 0 ? Promise.reject(new Error("systemctl show: Connection timed out")) : unit(u));
  const records = openRecords(dbFile());
  const applies = createApply({ db: records.db, ...h, pollMs: 5, retryMs: [5] });
  const r = claimed(records);
  const done = applies.execute(r);
  await until(() => h.launches.length === 1);
  await until(() => fails < 0);
  h.gens.push({ n: 2, instance: SHA, health: "good" });
  delete h.units[h.launches[0]];
  const o = await done;
  assert.equal(o.ok, true, o.text);
  assert.match(o.text, /Applied: generation 2 runs the instance's main at `ddddddddd`/);
  assert.equal(h.lands.length, 1, "the retry read the commit on main and didn't land again");
  assert.ok(fails < 0, "systemd was read again after its failures");
});

test("an apply is done by the first good generation whose instance contains its commit, never by an auto-revert's", async () => {
  // Main has moved past the approved commit since (a newer commit on top, F): the commit has landed, the apply is queued, and
  // whichever apply runs main first applies it.
  const F = "f".repeat(40), R = "a".repeat(40);
  const h = fakeHost();
  h.codehost.read = async () => ({ files: [], texts: { base: {}, head: {} }, diff: "", base: SHA, main: F });
  h.history = { [F]: [SHA], [R]: [SHA] };
  h.gens.push({ n: 2, instance: F, health: "good" }); // before the mark: an apply that ran before this record's
  const records = openRecords(dbFile());
  const done = createApply({ db: records.db, ...h, pollMs: 5 }).execute(claimed(records));
  await until(() => h.launches.length === 1);
  assert.equal(h.lands.length, 0, "already on main: nothing to land");
  // An apply queued earlier runs F and fails; its auto-revert (built on F, so containing the commit too) is good. Neither
  // is this record's outcome while its own apply is still queued.
  h.gens.push({ n: 3, instance: F, health: "failed", reason: "the kernel is down" }, { n: 4, instance: R, health: "good", revert_of: 3 });
  await new Promise((ok) => setTimeout(ok, 30));
  let settled = false;
  void done.then(() => (settled = true));
  await new Promise((ok) => setTimeout(ok, 30));
  assert.equal(settled, false, "a failed generation and a revert don't settle a record whose apply is still queued");
  // Its own apply (or any later one) runs main and is good.
  h.gens.push({ n: 5, instance: F, health: "good" });
  const o = await done;
  assert.equal(o.ok, true, o.text);
  assert.match(o.text, /generation 5 runs the instance's main at `fffffffff`, which contains `ddddddddd`/);
  assert.equal(h.launches.length, 1);
});

test("a failed apply marks the record failed, though the auto-revert left the host healthy", async () => {
  for (const reboot of [false, true]) {
    const db = dbFile();
    const h = fakeHost();
    h.hang = true;
    const a = kernel(db, h);
    const r = claimed(a.records);
    void a.applies.execute(r);
    await until(() => h.launches.length === 1);
    // Generation 2 applied this commit and failed its health check; the auto-revert (3) re-applied the last known good.
    h.gens.push({ n: 2, instance: SHA, health: "failed", reason: "the kernel is down", log: "/state/apply-2.log" }, { n: 3, instance: "e".repeat(40), health: "good", revert_of: 2, lkg: 1 });
    h.units[h.launches[0]] = reboot ? undefined : { loaded: true, active: "failed", sub: "failed", result: "exit-code" };
    h.hang = false;
    const b = kernel(db, h);
    await b.writes.reconcile();
    await until(() => b.records.get(r.id).state === "failed");
    assert.match(b.records.get(r.id).outcome.text, /the apply failed.*generation 2: failed, the kernel is down; log \/state\/apply-2\.log/s, reboot ? "after a reboot: read from the generations" : "from the unit");
    assert.equal(h.launches.length, 1);
    assert.match(b.notices.join("\n"), /\*\*Failed\*\*/);
  }
});

test("the official modules' pin is read structurally for the land's reviewer-eval gate, and fails closed", () => {
  const [A, B] = ["a".repeat(40), "b".repeat(40)];
  const flow = (sha, repo = "acme/aidenhq-modules") => `product: ${"c".repeat(40)}\nmarketplaces:\n  - { name: aidenhq, source: { source: github, repo: ${repo} }, sha: ${sha} }\n`;
  const block = (sha) => `marketplaces:\n  - name: aidenhq\n    source:\n      source: github\n      repo: acme/aidenhq-modules\n    sha: ${sha}\n`;
  assert.deepEqual(officialMove(flow(A), block(A)), { from: { repo: "acme/aidenhq-modules", sha: A }, to: { repo: "acme/aidenhq-modules", sha: A } });
  assert.match(officialMove(flow(A), block(B)).error, /moves an `aidenhq` marketplace pin/);
  assert.match(officialMove(flow(A), flow(A, "evil/modules")).error, /moves/, "the repository is part of the pin");
  assert.deepEqual(officialMove("product: x\n", "product: y\n"), { from: null, to: null });
  assert.match(officialMove("product: x\n", flow(A)).error, /adds an `aidenhq` marketplace pin/);
  assert.deepEqual(officialMove(flow(A), "product: x\n"), { from: { repo: "acme/aidenhq-modules", sha: A }, to: null }, "a pre-monorepo install drops it");
  assert.match(officialMove(undefined, flow(A)).error, /instance.yaml isn't on the instance's main/, "missing is never an empty document");
  assert.match(officialMove(flow(A), undefined).error, /isn't on the commit/);
  assert.match(officialMove(flow(A), `${flow(B)}marketplaces: []\n`).error, /can't be read/, "duplicate keys");
  assert.match(officialMove(flow(A), `${flow(B)}  - { name: aidenhq, source: { source: github, repo: acme/x }, sha: ${A} }\n`).error, /can't be read/, "listed twice");
});

test("a generation writes deploy.applied and pr.deployed for the merges it contains; a second does not re-deploy a PR", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploys-"));
  const repo = join(dir, "product");
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repo]);
  git("remote", "add", "origin", "https://github.com/acme/product.git");
  const commit = (m) => (git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", m), git("rev-parse", "HEAD"));
  const c1 = commit("PR 1"), c2 = commit("PR 2");
  const records = openRecords(join(dir, "kernel.db"));
  const facts = openFacts(records.db);
  facts.record({ type: "pr.merged", subject: "pr:acme/product#1", version: `github/${c1}`, at: "2026-11-18T09:00:00.000Z", actor: "github:bot", data: { sha: c1, head: c1 } });
  facts.record({ type: "pr.merged", subject: "pr:acme/other#9", version: `github/${c1}`, at: "2026-11-18T09:00:00.000Z", actor: "github:bot", data: { sha: c1, head: c1 } });
  facts.record({ type: "pr.merged", subject: "pr:acme/product#2", version: `github/${c2}`, at: "2026-11-18T09:00:00.000Z", actor: "module:github", data: { sha: c2, head: c2 } });
  // Only the repo's own code host's pr.merged counts: another module declaring the type, or another host, can't claim a deploy.
  facts.record({ type: "pr.merged", subject: "pr:acme/product#3", version: `acme-crm/${c2}`, at: "2026-11-18T09:00:00.000Z", actor: "module:acme-crm", data: { sha: c2, head: c2 } });
  facts.record({ type: "pr.merged", subject: "pr:acme/product#4", version: `codehost-local/${c2}`, at: "2026-11-18T09:00:00.000Z", actor: "module:codehost-local", data: { sha: c2, head: c2 } });
  facts.record({ type: "pr.merged", subject: "pr:acme/product#5", version: "github/x", at: "2026-11-18T09:00:00.000Z", actor: "module:github", data: { sha: "--output=/tmp/x", head: c2 } });
  const file = join(dir, "generations.jsonl");
  const gen = (n, product, health) => ({ n, at: new Date(Date.now() + n * 1000).toISOString(), product, instance: "f".repeat(40), health });
  writeFileSync(file, [gen(1, c1, "good"), gen(2, c2, "pending")].map((g) => JSON.stringify(g) + "\n").join(""));
  const recordDeploys = createDeploys({ db: records.db, file, repo });
  assert.equal(recordDeploys(), 2);
  writeFileSync(file, [gen(1, c1, "good"), gen(2, c2, "good")].map((g) => JSON.stringify(g) + "\n").join(""));
  assert.equal(recordDeploys(), 2);
  assert.equal(recordDeploys(), 0);
  const rows = records.db.prepare("SELECT type, subject, data FROM facts WHERE type IN ('deploy.applied', 'pr.deployed') ORDER BY seq").all().map((f) => [f.type, f.subject, JSON.parse(f.data).generation]);
  assert.deepEqual(rows, [["deploy.applied", "deploy:1", 1], ["pr.deployed", "pr:acme/product#1", 1], ["deploy.applied", "deploy:2", 2], ["pr.deployed", "pr:acme/product#2", 2]]);
});

test("a merge fact that arrives after a look is deployed at the next one, with no new generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploys-late-"));
  const repo = join(dir, "product");
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repo]);
  git("remote", "add", "origin", "https://github.com/acme/product.git");
  const commit = (m) => (git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", m), git("rev-parse", "HEAD"));
  const c1 = commit("PR 1"), c2 = commit("PR 2");
  const records = openRecords(join(dir, "kernel.db"));
  const facts = openFacts(records.db);
  const merge = (n, c) => facts.record({ type: "pr.merged", subject: `pr:acme/product#${n}`, version: `github/${c}`, at: "2026-11-18T09:00:00Z", actor: "module:github", source: "backfill", data: { sha: c, head: c } });
  const file = join(dir, "generations.jsonl");
  writeFileSync(file, JSON.stringify({ n: 1, at: new Date().toISOString(), product: c2, instance: "f".repeat(40), health: "good" }) + "\n");
  const recordDeploys = createDeploys({ db: records.db, file, repo });
  merge(1, c1);
  assert.equal(recordDeploys(), 2, "deploy.applied and the first PR");
  merge(2, c2); // a backfill still running: it lands after the look, and no generation follows
  assert.equal(recordDeploys(), 1);
  assert.equal(recordDeploys(), 0);
});

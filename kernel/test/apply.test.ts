// kernel.apply (apply.ts): what may land, and the executor end to end through the write records: land, queue the apply
// once, follow it to the generation that applied the commit, and carry on after the restart the apply itself causes without
// ever launching it again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApply, readDigest } from "../src/apply.ts";
import { strayFiles } from "../sdk/src/instance-paths.ts";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";

test("only instance config can be applied: a local module, a library skill, a handbook fork; never an agent.yaml", () => {
  assert.deepEqual(strayFiles(["instance.yaml", "apps.yaml", "owner/profile.md", "agents/chief-of-staff.md", "agents/chief-of-staff/AGENTS.md", "modules/review-chaser/module.yaml", "modules/review-chaser/agents/review-chaser/AGENTS.md", "modules/library/skills/triage-notes/SKILL.md"]), []);
  assert.deepEqual(strayFiles(["agents/x/agent.yaml", "modules/x/run.sh", "agents/x/memory.md"]), ["agents/x/agent.yaml", "modules/x/run.sh", "agents/x/memory.md"]);
  assert.deepEqual(strayFiles(["instance.yaml", "ops/apply-config.sh", "agents/x/evil.md", "agents/x/y/AGENTS.md", "modules/X/module.yaml", "modules/x/skills/s/run.sh"]), ["ops/apply-config.sh", "agents/x/evil.md", "agents/x/y/AGENTS.md", "modules/X/module.yaml", "modules/x/skills/s/run.sh"]);
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
  task: "TASK-1", identifier: "ACME-1", tier: 1, state: "claimed",
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

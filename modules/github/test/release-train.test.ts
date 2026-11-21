// The release train's loop (service/src/train.ts) against a fake kernel and GitHub: a green product tip past the batch window
// files one kernel.apply for its bump on the Platform Engineer's task; a restart between filing and saving adopts the same
// card, which the kernel answers with the same record; a bump that ends is closed and its tip never tried again; a bump that
// ends failed or unknown — even one whose written-down state was lost — closes its task with a "Not landed" note.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReleaseTrain } from "../service/src/train.ts";

const [OLD, NEW] = ["a", "b"].map((c) => c.repeat(40));
const INSTANCE = `product: ${OLD}\nmodules: [core]\n`;

function fakes() {
  // `tasks`: every filing call; `made`: the tasks the control plane actually created (one per source, as the kernel's
  // idempotency key makes it); `closeFails`: close calls to fail before answering 502; `stranded`: the open tasks the kernel's
  // source listing answers with (a task a process filed and this one never had in hand).
  const k = { tasks: [], made: [], writes: [], closed: [], records: {}, closeFails: 0, stranded: [], lists: [] };
  const kernel = async (method, path, body) => {
    const l = /^\/v1\/tasks\?source=(.+)$/.exec(path);
    if (l) {
      k.lists.push(decodeURIComponent(l[1]));
      // The control plane's listing is open tasks: one the fake kernel has just closed is no longer in it.
      return { tasks: k.stranded.filter((t) => decodeURIComponent(l[1]) === "release:instance:" && t.source.startsWith("release:instance:") && !k.closed.some((c) => c.task === t.id)) };
    }
    if (path === "/v1/tasks") {
      k.tasks.push(body);
      const same = k.made.find((t) => t.source === body.source);
      if (same) return { id: same.id, identifier: same.identifier, deduplicated: true };
      const t = { id: `t-${body.source}`, identifier: "ACME-7", source: body.source };
      k.made.push(t);
      return { id: t.id, identifier: t.identifier };
    }
    const w0 = /^\/v1\/work\?task=(.+)$/.exec(path);
    if (w0) {
      const task = decodeURIComponent(w0[1]);
      return { records: Object.values(k.records).filter((r) => r.task === task).map((r) => ({ ...r, outcome_text: r.outcome?.text ?? null })) };
    }
    if (path === "/v1/writes") {
      // The kernel: the same request still open is that record.
      const same = Object.values(k.records).find((r) => r.sha === body.args.sha && ["review", "owner"].includes(r.state));
      k.writes.push(body);
      if (same) return { id: same.id, tier: 1, state: same.state };
      const id = `k-${String(Object.keys(k.records).length).padStart(16, "0")}`;
      k.records[id] = { id, kind: body.kind, sha: body.args.sha, task: body.task, state: "review" };
      return { id, tier: 1, state: "review" };
    }
    const w = /^\/v1\/writes\/(k-\d+)$/.exec(path);
    if (w) return k.records[w[1]];
    const c = /^\/v1\/tasks\/(.+)\/close$/.exec(path);
    if (c) {
      if (k.closeFails > 0) { k.closeFails -= 1; throw new Error("/v1/tasks/x/close answered 502: the control plane answered 502"); }
      k.closed.push({ task: c[1], ...body });
      return {};
    }
    throw new Error(`no route ${path}`);
  };
  const github = {
    tip: async () => ({ tip: NEW, green: true }),
    text: async (repo, path) => (path === "instance.yaml" ? INSTANCE : undefined),
    commits: async (repo, from, to) => [{ repo, sha: to, subject: "(#1)" }],
  };
  return { k, kernel, github };
}
const train = (dir, f, clock, extra = {}) => createReleaseTrain({
  dir, productRepo: "acme/aidenhq", instanceRepo: "acme/aidenhq-instance", windowMinutes: 15,
  kernel: f.kernel, github: f.github, evalBump: async () => undefined, now: () => clock.t,
  commit: async (repo, path, edit) => { const t = edit(f.head ?? INSTANCE); f.committed = t; return t.includes(NEW) ? "e".repeat(40) : "0".repeat(40); }, ...extra,
});

/**
 * A task a process filed and this train never had in hand: `state` is its newest kernel.apply's state (`null`: none was ever
 * filed), `createdAt` its filing time. Written to the fake kernel's listing and work log, never to `s.flight`.
 */
function stranded(f, { source = "release:instance:1795022489866", state = "failed", text = "the service codehost-github isn't running", createdAt = "2026-11-18T09:00:00Z" } = {}) {
  const id = `t-${source}`;
  f.k.stranded.push({ id, identifier: "WOR-8308", source, createdAt, status: "in_review" });
  if (state) f.k.records[`k-${source}`] = { id: `k-${source}`, kind: "kernel.apply", task: id, state, created_at: createdAt, outcome: { ok: state === "done", text } };
  return id;
}

test("a green tip past the window files one kernel.apply; a restart adopts that same card, and an ended bump is never retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  await train(dir, f, clock).step();
  assert.equal(f.k.writes.length, 0, "opened: the window runs");
  clock.t = new Date("2026-11-18T10:20:00Z");
  // The kernel's answer is lost (a restart before the train saves the flight): the next train adopts the card it filed.
  let lost = true;
  const flaky = { ...f, kernel: async (m, p, b) => { const r = await f.kernel(m, p, b); if (p === "/v1/writes" && lost) { lost = false; throw new Error("socket hang up"); } return r; } };
  await assert.rejects(train(dir, flaky, clock).step(), /hang up/);
  await train(dir, f, clock).step();
  assert.equal(f.k.tasks.length, 1, "one task per tip");
  assert.equal(f.k.tasks[0].role, "platform-engineer");
  assert.equal(f.k.tasks[0].quiet, true, "filed quiet: the card carries the bump and no agent is woken for it");
  assert.deepEqual(f.k.writes.map((w) => [w.kind, w.args.repo, w.args.sha, w.task]), [["kernel.apply", "acme/aidenhq-instance", "e".repeat(40), "t-release:instance:" + NEW]], "the filed card is adopted, not requested again");
  assert.equal(Object.keys(f.k.records).length, 1, "one record: the same request");
  // In flight: nothing else files. Applied: the task closes and the same tip is never filed again.
  await train(dir, f, clock).step();
  assert.equal(f.k.writes.length, 1);
  Object.values(f.k.records)[0].state = "done";
  await train(dir, f, clock).step();
  await train(dir, f, clock).step();
  assert.deepEqual(f.k.closed.map((c) => c.body), ["Applied: this instance runs the bump."]);
  assert.equal(f.k.writes.length, 1);
});

test("a bump whose reviewer eval runs waits; one the kernel refuses closes its task and isn't tried again", async () => {
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  const f = fakes();
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  let gate = { wait: "the eval runs" };
  const asked = [];
  const t = () => train(dir, f, clock, { evalBump: async (from, to) => (asked.push([from, to]), gate) });
  await t().step();
  clock.t = new Date("2026-11-18T10:20:00Z");
  await t().step();
  assert.equal(f.k.tasks.length, 0, "waits for the eval before anything is filed");
  assert.deepEqual(asked.at(-1), [OLD, NEW], "the product's move: the tip judged by the pinned commit");
  gate = undefined;
  const refusing = { ...f, kernel: async (m, p, b) => { if (p === "/v1/writes") throw new Error("the kernel's /v1/writes answered 422: a new agent starts in trial"); return f.kernel(m, p, b); } };
  await train(dir, refusing, clock, { evalBump: async () => undefined }).step();
  assert.match(f.k.closed[0].body, /Not filed:\*\* .*answered 422/);
  await t().step();
  assert.equal(f.k.tasks.length, 1, "the refused tip is not tried again");
});

test("the bump is written on instance.yaml as it is at the head its commit builds on, never on an older read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  await train(dir, f, clock).step();
  clock.t = new Date("2026-11-18T10:20:00Z");
  // Main moved between the train's read and its commit: a setting landed on it.
  f.head = `${INSTANCE}settings: { quiet_start: on }\n`;
  await train(dir, f, clock).step();
  assert.match(f.committed, /quiet_start: on/, "the commit keeps what landed on main meanwhile");
  assert.match(f.committed, new RegExp(`product: ${NEW}`));
});

/** One bump filed and in flight, its record moved to `state` with `text` as its outcome: the opening of the settle tests. */
async function inFlight(f, clock, state, text) {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const t = () => train(dir, f, clock);
  await t().step();
  clock.t = new Date("2026-11-18T10:20:00Z");
  await t().step();
  assert.equal(f.k.writes.length, 1, "the bump is filed before the test moves it");
  const [record] = Object.values(f.k.records);
  record.state = state;
  record.outcome = { ok: false, text };
  return { dir, t, record };
}

for (const state of ["failed", "unknown"]) {
  test(`a record that ends ${state} closes the bump's task with a Not landed note naming the failure`, async () => {
    const f = fakes();
    const clock = { t: new Date("2026-11-18T10:00:00Z") };
    const why = `the service codehost-github isn't running (${state})`;
    const { t, record } = await inFlight(f, clock, state, why);
    await t().step();
    assert.deepEqual(f.k.closed.map((c) => [c.task, c.status]), [[record.task, "done"]]);
    assert.match(f.k.closed[0].body, /\*\*Not landed:\*\* it was approved but failed: the service codehost-github isn't running/);
    // Settled once: the flight entry is gone and the next poll closes nothing again.
    await t().step();
    assert.equal(f.k.closed.length, 1);
  });
}

test("a restart whose flight state is lost reclaims the task by the idempotent re-file and closes that same task", async () => {
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  const { dir, record } = await inFlight(f, clock, "failed", "the apply host was replaced mid-run");
  // The state file is gone (a replaced process, a lost volume): the next process knows nothing about the bump it filed.
  rmSync(join(dir, "release-instance.json"));
  // A fresh open and its window, as any bump after a merge: the re-file answers with the existing task, not a new one.
  clock.t = new Date("2026-11-18T10:40:00Z");
  await train(dir, f, clock).step();
  clock.t = new Date("2026-11-18T11:00:00Z");
  await train(dir, f, clock).step();
  assert.equal(f.k.made.length, 1, "no second task is filed for the same bump");
  assert.equal(f.k.tasks.length, 2, "the re-file is made, and the kernel answers it with the task that exists");
  assert.deepEqual(f.k.closed.map((c) => [c.task, c.status]), [[record.task, "done"]], "the close lands on the task the bump opened");
  assert.match(f.k.closed[0].body, /\*\*Not landed:\*\* it was approved but failed: the apply host was replaced mid-run/);
  assert.equal(f.k.writes.length, 1, "no second card");
});

test("a close the kernel refuses leaves the bump pending, and the next poll retries it and succeeds", async () => {
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  const { dir, record } = await inFlight(f, clock, "failed", "the service codehost-github isn't running");
  f.k.closeFails = 1;
  await train(dir, f, clock).step();
  assert.equal(f.k.closed.length, 0, "the close failed");
  const kept = JSON.parse(readFileSync(join(dir, "release-instance.json"), "utf8"));
  assert.equal(kept.flight?.record, record.id, "the bump is kept, so the task is not abandoned");
  await train(dir, f, clock).step();
  assert.deepEqual(f.k.closed.map((c) => [c.task, c.status]), [[record.task, "done"]]);
  assert.equal(JSON.parse(readFileSync(join(dir, "release-instance.json"), "utf8")).flight, undefined, "settled: nothing left to retry");
});

test("an instance that installs releases (a release: key) is the kernel updater's: the train stays idle", async () => {
  const f = fakes();
  f.github.text = async () => `${INSTANCE}release: { name: "2026.11.2" }\n`;
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  const t = train(mkdtempSync(join(tmpdir(), "train-")), f, clock);
  await t.step();
  clock.t = new Date("2026-11-18T10:20:00Z");
  await t.step();
  assert.deepEqual([f.k.tasks.length, f.k.writes.length], [0, 0]);
});

/**
 * The sweep: the tip is the live pin, so trainStep is idle and nothing is filed or followed here; only the tasks the kernel's
 * source listing returns are settled, from their cards, with no memory of them in this process at all.
 */
function idle(f) {
  f.github.tip = async () => ({ tip: OLD, green: true });
  return f;
}

test("a stranded bump whose apply failed is swept and settled, with no flight state and nothing to file", async () => {
  const f = idle(fakes());
  const clock = { t: new Date("2026-11-18T10:20:00Z") };
  const task = stranded(f);
  await train(mkdtempSync(join(tmpdir(), "train-")), f, clock).step();
  assert.deepEqual(f.k.lists, ["release:instance:"], "the listing is the train's own source family");
  assert.deepEqual(f.k.closed.map((c) => [c.task, c.status]), [[task, "done"]]);
  assert.match(f.k.closed[0].body, /\*\*Not landed:\*\* it was approved but failed: the service codehost-github isn't running\. The next merge to the product files the next bump\.$/);
  assert.deepEqual([f.k.tasks.length, f.k.writes.length], [0, 0], "idle: the sweep files nothing");
});

test("a stranded bump with no apply card at all is left open, before and past the batch window", async () => {
  const f = idle(fakes());
  // Filed but never carded (the gap between filing the task and filing the apply, or a process that died in it). Its card may
  // still be on its way, so no amount of age proves it never will be: the sweep settles only a bump with a card.
  const clock = { t: new Date("2026-11-18T18:10:00Z") };
  const task = stranded(f, { source: "release:instance:1795025189923", state: null, createdAt: "2026-11-18T18:06:30.500Z" });
  const t = train(mkdtempSync(join(tmpdir(), "train-")), f, clock);
  await t.step();
  assert.deepEqual(f.k.closed, [], "inside the window a filing may still be on its way");
  clock.t = new Date("2026-11-18T18:30:00Z");
  await t.step();
  assert.equal(task, "t-release:instance:1795025189923");
  assert.deepEqual(f.k.closed, [], "past the window with no card, it is still left open for its card to arrive");
});

test("a bump whose card is still moving is left alone", async () => {
  const f = idle(fakes());
  const clock = { t: new Date("2026-11-18T10:20:00Z") };
  stranded(f, { state: "review" });
  await train(mkdtempSync(join(tmpdir(), "train-")), f, clock).step();
  assert.deepEqual(f.k.closed, []);
});

test("a task that isn't the train's is never closed by the sweep", async () => {
  const f = idle(fakes());
  const clock = { t: new Date("2026-11-18T10:20:00Z") };
  stranded(f, { source: "dependabot:acme/app/7" });
  await train(mkdtempSync(join(tmpdir(), "train-")), f, clock).step();
  assert.deepEqual(f.k.closed, []);
});

test("the bump in flight is follow()'s: the sweep skips it even when its card has settled", async () => {
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  const { t, record } = await inFlight(f, clock, "failed", "the apply host was replaced mid-run");
  // The same task is also listed: the sweep must not close it before follow(), nor close it twice.
  f.k.stranded.push({ id: record.task, identifier: "ACME-7", source: `release:instance:${NEW}`, createdAt: "2026-11-18T09:00:00Z", status: "in_review" });
  f.k.lists.length = 0;
  await t().step();
  assert.deepEqual(f.k.closed.map((c) => c.task), [record.task], "closed once, by follow()");
  assert.match(f.k.closed[0].body, /\*\*Not landed:\*\* it was approved but failed: the apply host was replaced mid-run/);
});

test("an edit refused at the commit's head closes the bump's task it already filed, never strands it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const f = fakes();
  f.head = `${INSTANCE}product: ${OLD}\n`; // main moved under the read: two pins, which can't be bumped in place
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  await train(dir, f, clock).step();
  clock.t = new Date("2026-11-18T10:20:00Z");
  await train(dir, f, clock).step();
  assert.equal(f.k.tasks.length, 1);
  assert.deepEqual(f.k.closed.map((c) => c.task), [f.k.made[0].id]);
  assert.match(f.k.closed[0].body, /\*\*Not filed:\*\* instance\.yaml can't be bumped in place/);
});

test("a stranded bump whose card was cancelled (expired, replaced) or went stale is swept and settled", async () => {
  for (const state of ["cancelled", "stale"]) {
    const f = idle(fakes());
    const task = stranded(f, { state, text: "replaced" });
    await train(mkdtempSync(join(tmpdir(), "train-")), f, { t: new Date("2026-11-25T10:20:00Z") }).step();
    assert.deepEqual(f.k.closed.map((c) => c.task), [task], state);
    assert.match(f.k.closed[0].body, new RegExp(`the card was ${state}`));
  }
});

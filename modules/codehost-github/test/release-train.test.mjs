// The release train's loop (service/src/train.ts) against a fake kernel and GitHub: a green product tip past the batch window
// files one kernel.apply for its bump on the Platform Engineer's task; a restart between filing and saving files the same
// commit again, which the kernel answers with the same record; a bump that ends is closed and its tip never tried again.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReleaseTrain } from "../service/src/train.ts";

const [OLD, NEW] = ["a", "b"].map((c) => c.repeat(40));
const INSTANCE = `product: ${OLD}\nmodules: [core]\n`;

function fakes() {
  const k = { tasks: [], writes: [], closed: [], records: {} };
  const kernel = async (method, path, body) => {
    if (path === "/v1/tasks") { k.tasks.push(body); return { id: `t-${body.source}`, identifier: "ACME-7" }; }
    if (path === "/v1/writes") {
      // The kernel: the same request still open is that record.
      const same = Object.values(k.records).find((r) => r.sha === body.args.sha && ["review", "owner"].includes(r.state));
      k.writes.push(body);
      if (same) return { id: same.id, tier: 1, state: same.state };
      const id = `k-${String(Object.keys(k.records).length).padStart(16, "0")}`;
      k.records[id] = { id, sha: body.args.sha, state: "review" };
      return { id, tier: 1, state: "review" };
    }
    const w = /^\/v1\/writes\/(k-\d+)$/.exec(path);
    if (w) return k.records[w[1]];
    const c = /^\/v1\/tasks\/(.+)\/close$/.exec(path);
    if (c) { k.closed.push({ task: c[1], ...body }); return {}; }
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

test("a green tip past the window files one kernel.apply; a restart files the same commit, and an ended bump is never retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  await train(dir, f, clock).step();
  assert.equal(f.k.writes.length, 0, "opened: the window runs");
  clock.t = new Date("2026-11-18T10:20:00Z");
  // The kernel's answer is lost (a restart before the train saves the flight): the next train files the same commit again.
  let lost = true;
  const flaky = { ...f, kernel: async (m, p, b) => { const r = await f.kernel(m, p, b); if (p === "/v1/writes" && lost) { lost = false; throw new Error("socket hang up"); } return r; } };
  await assert.rejects(train(dir, flaky, clock).step(), /hang up/);
  await train(dir, f, clock).step();
  assert.equal(f.k.tasks.length, 1, "one task per tip");
  assert.equal(f.k.tasks[0].role, "platform-engineer");
  assert.deepEqual(f.k.writes.map((w) => [w.kind, w.args.repo, w.args.sha, w.task]), [["kernel.apply", "acme/aidenhq-instance", "e".repeat(40), "t-release:instance:" + NEW], ["kernel.apply", "acme/aidenhq-instance", "e".repeat(40), "t-release:instance:" + NEW]]);
  assert.equal(Object.keys(f.k.records).length, 1, "one record: the same request");
  // In flight: nothing else files. Applied: the task closes and the same tip is never filed again.
  await train(dir, f, clock).step();
  assert.equal(f.k.writes.length, 2);
  Object.values(f.k.records)[0].state = "done";
  await train(dir, f, clock).step();
  await train(dir, f, clock).step();
  assert.deepEqual(f.k.closed.map((c) => c.body), ["Applied: this instance runs the bump."]);
  assert.equal(f.k.writes.length, 2);
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

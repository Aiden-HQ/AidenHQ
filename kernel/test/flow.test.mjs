// Flow's views (flow.ts): a task's waterfall with its stages, actors and idle reasons, items, the summary and idle now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { createFlow } from "../src/flow.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";

const D = "2026-11-19T";
/** A fact store and its flow; each fact is seen when it happened (seen_at = at). */
function setup(now = `${D}23:00:00.000Z`) {
  const db = new DatabaseSync(":memory:");
  let clock = now;
  const facts = openFacts(db, () => new Date(clock));
  const add = (type, subject, at, data = {}, over = {}) => { clock = at.length < 13 ? `${D}${at}.000Z` : at; facts.record({ type, subject, version: `${type}@${clock}`, at: clock, actor: "unknown", task: "t1", data, ...over }); };
  return { add, flow: createFlow({ db, stages: () => KERNEL_STAGES, now: () => new Date(now) }) };
}

/** WOR-8567 (2026-11-19): assigned, a 29 s queue, the first job, a handoff, a second job, then idle until a comment woke it. */
function wor8567(add) {
  add("task.created", "task:t1", "10:02:03", { parent: null, identifier: "WOR-8567" });
  add("task.assignee_changed", "task:t1", "10:02:03", { from: null, to: "engineer-a" });
  add("job.queued", "job:j1", "10:02:05", { wake_at: `${D}10:02:03.000Z` }, { actor: "agent:engineer-a" });
  add("job.started", "job:j1", "10:02:32", {}, { actor: "agent:engineer-a" });
  add("job.ended", "job:j1", "10:33:56", { state: "done", acted: true }, { actor: "agent:engineer-a" });
  add("task.assignee_changed", "task:t1", "10:34:10", { from: "engineer-a", to: "engineer-b" });
  add("wake.opened", "wake:w2", "10:34:10", { cause: "assigned" });
  add("job.queued", "job:j2", "10:35:00", { wake_at: `${D}10:34:10.000Z` }, { actor: "agent:engineer-b" });
  add("wake.bound", "wake:w2", "10:35:00", { job: "j2" });
  add("job.started", "job:j2", "10:35:06", {}, { actor: "agent:engineer-b" });
  add("job.ended", "job:j2", "10:37:27", { state: "done", acted: true }, { actor: "agent:engineer-b" });
}
function wor8567End(add) {
  add("wake.opened", "wake:w3", "12:21:20", { cause: "comment", author: "account:o1" });
  add("job.queued", "job:j3", "12:21:21", { wake_at: `${D}12:21:20.000Z` }, { actor: "agent:engineer-b" });
  add("job.started", "job:j3", "12:21:40", {}, { actor: "agent:engineer-b" });
  add("job.ended", "job:j3", "12:30:00", { state: "done", acted: true }, { actor: "agent:engineer-b" });
  add("task.status_changed", "task:t1", "12:30:00", { from: "in_progress", to: "done" });
}
const secs = (s) => (Date.parse(s.end) - Date.parse(s.start)) / 1000;

test("waterfall has queued 29s, two working stages with their agents, and the idle gap 10:37:27-12:21:20 with reason unknown", () => {
  const { add, flow } = setup();
  wor8567(add); wor8567End(add);
  const w = flow.task("t1");
  assert.equal(w.root, "t1");
  const queued = w.stages.filter((s) => s.name === "queued");
  assert.equal(secs(queued[0]), 29);
  assert.deepEqual(w.stages.filter((s) => s.name === "working").map((s) => [s.actor, s.start.slice(11, 19), s.end.slice(11, 19)]),
    [["agent:engineer-a", "10:02:32", "10:33:56"], ["agent:engineer-b", "10:35:06", "10:37:27"], ["agent:engineer-b", "12:21:40", "12:30:00"]]);
  // The handoff's 14 s between the first job's end and the reassignment's wake is idle too; nothing recorded why.
  assert.deepEqual(w.idle.map((i) => [i.start.slice(11, 19), i.end.slice(11, 19), i.reason, i.holder]),
    [["10:33:56", "10:34:10", "unknown", "engineer-a"], ["10:37:27", "12:21:20", "unknown", "engineer-b"]]);
});

test("an open owner record makes the gap's reason owner; idle now with nothing pending is orphaned", () => {
  const { add, flow } = setup();
  wor8567(add);
  add("record.filed", "record:k1", "10:37:00", { kind: "merge", tier: 2 });
  let w = flow.task("t1");
  assert.deepEqual(w.idle.at(-1), { task: "t1", start: `${D}10:37:27.000Z`, end: null, reason: "owner", holder: "engineer-b" });
  add("record.decided", "record:k1", "11:00:00", { decision: "approve", decider: "owner" }, { actor: "account:o1" });
  w = flow.task("t1");
  assert.deepEqual(w.idle.slice(-2).map((i) => [i.start.slice(11, 19), i.end?.slice(11, 19) ?? null, i.reason]), [["10:37:27", "11:00:00", "owner"], ["11:00:00", null, "orphaned"]]);
  assert.deepEqual(w.stages.filter((s) => s.name === "owner").map((s) => [s.actor, secs(s)]), [["account:o1", 23 * 60]]);
  assert.deepEqual(flow.idleNow().items, [{ task: "t1", identifier: "WOR-8567", since: `${D}10:37:27.000Z`, reason: "orphaned", holder: "engineer-b" }]);
});

test("two overlapping records on one task pair by subject", () => {
  const { add, flow } = setup();
  add("record.filed", "record:k1", "10:00:00", { tier: 1 });
  add("record.filed", "record:k2", "10:01:00", { tier: 2 });
  add("record.decided", "record:k2", "10:03:00", { decision: "approve", decider: "owner" }, { actor: "account:o1" });
  add("record.decided", "record:k1", "10:05:00", { decision: "approve", decider: "reviewer" }, { actor: "module:ai-reviewer" });
  assert.deepEqual(flow.task("t1").stages.map((s) => [s.name, s.subject, s.start.slice(11, 19), s.end.slice(11, 19), s.actor]),
    [["review", "record:k1", "10:00:00", "10:05:00", "module:ai-reviewer"], ["owner", "record:k2", "10:01:00", "10:03:00", "account:o1"]]);
});

test("empty log gives an empty waterfall, summary and idle list", () => {
  const { flow } = setup();
  assert.deepEqual(flow.task("t1"), { task: "t1", root: "t1", facts: [], stages: [], idle: [] });
  const s = flow.summary({ since: `${D}00:00:00.000Z` });
  assert.deepEqual([s.stages, s.dora, s.churn, s.fleet.completions, s.fleet.first_pass_grade], [[], null, null, 0, null]);
  assert.deepEqual(flow.idleNow(), { items: [] });
});

test("item walks to the root and includes its descendants", () => {
  const { add, flow } = setup();
  add("task.created", "task:root", "09:00:00", {}, { task: "root" });
  add("task.created", "task:t1", "09:10:00", { parent: "root" });
  add("task.created", "task:t2", "09:20:00", { parent: "t1" }, { task: "t2" });
  const w = flow.item("t1");
  assert.equal(w.root, "root");
  assert.deepEqual(w.facts.map((f) => f.subject), ["task:root", "task:t1", "task:t2"]);
});

test("summary: p50/p75 per stage, fewer than 5 gives samples, DORA from deploys and a linked revert", () => {
  const { add, flow } = setup();
  for (let i = 1; i <= 6; i++) {
    add("job.started", `job:j${i}`, `1${i}:00:00`, {}, { task: `t${i}` });
    add("job.ended", `job:j${i}`, `1${i}:${String(i * 5).padStart(2, "0")}:00`, { model: "m", cost_usd: 1, acted: true }, { task: `t${i}` });
  }
  add("record.filed", "record:k1", "10:00:00", { tier: 1 });
  add("record.decided", "record:k1", "10:02:00", { decision: "approve", decider: "reviewer" });
  const s = flow.summary({ since: `${D}00:00:00.000Z`, to: `${D}23:00:00.000Z` });
  const working = s.stages.find((r) => r.name === "working");
  assert.deepEqual([working.n, working.work_p50, working.work_p75, working.wait_p50, working.samples], [6, 900, 1500, 0, undefined]);
  assert.deepEqual(working.slow.map((x) => x.seconds), [1800, 1500]);
  const review = s.stages.find((r) => r.name === "review");
  assert.deepEqual([review.n, review.samples, review.work_p50], [1, [120], undefined]);
  assert.equal(s.dora, null);

  add("pr.opened", "pr:acme/app#3", "08:00:00", { repo: "acme/app", number: 3 });
  add("pr.merged", "pr:acme/app#3", "09:00:00", { sha: "abc1234def" });
  add("deploy.applied", "deploy:1", "09:30:00", { generation: 1, health: "ok" }, { task: null });
  add("pr.deployed", "pr:acme/app#3", "09:30:00", { pr: "acme/app#3", generation: 1 });
  add("deploy.applied", "deploy:2", "15:00:00", { generation: 2, health: "ok" }, { task: null });
  add("pr.reverted", "pr:acme/app#4", "14:00:00", { of_pr: "acme/app#3" });
  const d = flow.summary({ since: `${D}00:00:00.000Z`, to: `${D}23:00:00.000Z` }).dora;
  assert.equal(d.failure_rate, 0.5);
  assert.equal(d.lead_p50, 5400);
  assert.ok(Math.abs(d.deploys_per_day - 2 / (23 / 24)) < 1e-9);
});

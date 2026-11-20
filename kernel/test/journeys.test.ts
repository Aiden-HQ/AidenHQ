// Journeys (journeys.ts): one PR's phases from its issue to its deploy, its rounds and idle, and the insights over them.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openFacts } from "../src/facts.ts";
import { createFlow } from "../src/flow.ts";
import { KERNEL_STAGES } from "../src/flow-stages.ts";
import { createBackplane } from "../src/backplane.ts";

const PR = {
  name: "pr", label: "Pull requests", subject: "pr", module: "github", end: ["pr.deployed", "pr.closed"],
  phases: [
    { name: "triage", label: "Triage", from: ["issue.opened"] },
    { name: "pickup", label: "Pickup", from: ["issue.labeled", "task.created"] },
    { name: "coding", label: "Coding", from: ["job.started"] },
    { name: "review", label: "AI review", from: ["record.filed"], where: { kind: ["github.pr", "github.push"] } },
    { name: "open", label: "PR open", from: ["pr.opened"] },
    { name: "ci", label: "CI", from: ["pr.checks_started", "pr.pushed"] },
    { name: "merge", label: "Merge review", from: ["record.filed"], where: { kind: ["github.merge"] } },
    { name: "deploy", label: "Deploy", from: ["pr.merged"] },
  ],
};
const D = "2026-11-19T";
const NOW = `${D}23:00:00.000Z`;
const DAY = `${D}00:00:00.000Z`;

function setup() {
  const db = new DatabaseSync(":memory:");
  const facts = openFacts(db, () => new Date(NOW));
  let n = 0;
  const add = (type, subject, at, data = {}, over = {}) => facts.record({ type, subject, version: String(n++), at: `${D}${at}.000Z`, actor: "unknown", task: null, data, ...over });
  return { db, add, flow: createFlow({ db, stages: () => KERNEL_STAGES, journeys: () => [PR], now: () => new Date(NOW), cacheMs: 0 }) };
}

/** An agent PR: issue, label, task, job, three review rounds, the PR, two CI rounds, merge review, merged, deployed. */
function agentPr(add) {
  const t = { task: "t1" }, agent = { task: "t1", actor: "agent:engineer-a" };
  add("issue.opened", "issue:acme/widgets#7", "08:00:00", { author: "someone", author_kind: "outside" });
  add("issue.labeled", "issue:acme/widgets#7", "08:10:00", { label: "agent", by: "owner" });
  add("task.created", "task:t1", "08:11:00", { identifier: "WOR-1", source_marker: "maintainer-issue:Acme/Widgets#7" }, t);
  add("job.queued", "job:j1", "08:11:05", {}, agent);
  add("job.started", "job:j1", "08:11:10", {}, agent);
  add("job.ended", "job:j1", "08:30:00", { cost_usd: 1, model: "m1" }, agent);
  // each rejection sends the Engineer back: a rework job, then the refile
  for (const [i, h] of [[1, "08"], [2, "09"], [3, "10"]]) {
    if (i > 1) { add("job.started", `job:j${i}`, `${h}:00:00`, {}, agent); add("job.ended", `job:j${i}`, `${h}:20:00`, { cost_usd: 0.5, model: "m1" }, agent); }
    add("record.filed", `record:r${i}`, `${h}:30:00`, { kind: "github.pr", state: "review" }, agent);
    add("record.decided", `record:r${i}`, `${h}:40:00`, i < 3 ? { decision: "rejected", decider: "reviewer", code: "scope" } : { decision: "approved", decider: "reviewer" }, t);
  }
  add("pr.opened", "pr:acme/widgets#12", "10:45:00", { repo: "Acme/Widgets", number: 12 }, t); // the backfill's first version, re-sent below
  add("pr.opened", "pr:acme/widgets#12", "10:45:00", { repo: "Acme/Widgets", number: 12, title: "Fix the widget", author: "aidenhq-bot", author_kind: "agent" }, t);
  add("pr.checks_started", "pr:acme/widgets#12@h1", "10:46:00", { head: "h1" }, t);
  add("pr.checks_completed", "pr:acme/widgets#12@h1", "10:50:00", { head: "h1", conclusion: "failure" }, t);
  add("pr.pushed", "pr:acme/widgets#12", "11:00:00", { head: "h2", before: "h1" }, t);
  add("pr.checks_started", "pr:acme/widgets#12@h2", "11:00:05", { head: "h2" }, t);
  add("pr.checks_completed", "pr:acme/widgets#12@h2", "11:05:00", { head: "h2", conclusion: "success" }, t);
  add("record.filed", "record:m1", "11:10:00", { kind: "github.merge", state: "review", pr: "acme/widgets#12" }, agent);
  add("record.decided", "record:m1", "11:30:00", { decision: "approved", decider: "reviewer" }, t);
  add("pr.merged", "pr:acme/widgets#12", "11:31:00", { sha: "abcdef1" }, t);
  add("deploy.applied", "deploy:5", "11:45:00", { generation: 5, health: "good" });
  add("pr.deployed", "pr:acme/widgets#12", "11:45:00", { pr: "acme/widgets#12", generation: 5 });
  add("task.status_changed", "task:t1", "11:46:00", { to: "done" }, t);
}
function ownerAndOpen(add) {
  add("pr.pushed", "pr:acme/widgets#13", "11:50:00", { head: "o0" }); // before it opened: prehistory
  add("pr.opened", "pr:acme/widgets#13", "12:00:00", { repo: "acme/widgets", number: 13, title: "Tidy", author: "owner", author_kind: "owner" });
  add("pr.checks_started", "pr:acme/widgets#13@o1", "12:01:00", { head: "o1" });
  add("pr.merged", "pr:acme/widgets#13", "12:30:00", { sha: "0123abc" });
  add("pr.opened", "pr:acme/widgets#14", "13:00:00", { repo: "acme/widgets", number: 14, author: "owner", author_kind: "owner" });
  add("pr.checks_started", "pr:acme/widgets#14@p1", "13:01:00", { head: "p1" });
}
const span = (b) => [b.phase, b.start.slice(11, 19), b.end.slice(11, 19), b.rounds];

test("an agent PR's journey: every phase once, three review rounds, two CI rounds, idle on the reviewer, ended at its deploy", () => {
  const { db, add, flow } = setup();
  agentPr(add); ownerAndOpen(add);
  // a PR whose review round no fact links to it: the task's done pr write names it in its outcome
  db.exec("CREATE TABLE records (task TEXT, kind TEXT, args TEXT, outcome TEXT, state TEXT, created_at TEXT)");
  db.prepare("INSERT INTO records VALUES ('t2', 'github.pr', '{}', ?, 'done', ?)").run(JSON.stringify({ ok: true, text: "opened https://github.com/acme/widgets/pull/15" }), `${D}13:30:00.000Z`);
  add("record.filed", "record:r9", "13:30:00", { kind: "github.pr", state: "review" }, { task: "t2" });
  add("pr.opened", "pr:acme/widgets#15", "14:00:00", { repo: "acme/widgets", number: 15, author_kind: "agent" });
  assert.deepEqual(flow.journey({ name: "pr", since: DAY }).items.find((i) => i.number === 15).blocks.map((b) => [b.phase, b.rounds]), [["review", 1], ["open", 1]]);
  const list = flow.journey({ name: "pr", since: DAY });
  assert.deepEqual(list.phases.map((p) => p.name), PR.phases.map((p) => p.name));
  const pr = list.items.find((i) => i.number === 12);
  assert.deepEqual(pr.blocks.map(span), [
    ["triage", "08:00:00", "08:10:00", 1], ["pickup", "08:10:00", "08:11:10", 1], ["coding", "08:11:10", "08:30:00", 1],
    ["review", "08:30:00", "10:45:00", 3], ["open", "10:45:00", "10:46:00", 1], ["ci", "10:46:00", "11:10:00", 2],
    ["merge", "11:10:00", "11:31:00", 1], ["deploy", "11:31:00", "11:45:00", 1]]);
  assert.deepEqual([pr.state, pr.task, pr.identifier, pr.author_kind, pr.title, pr.end, pr.total_s, pr.url],
    ["deployed", "t1", "WOR-1", "agent", "Fix the widget", `${D}11:45:00.000Z`, 3 * 3600 + 45 * 60, "https://github.com/Acme/Widgets/pull/12"]);
  assert.equal(pr.blocks.find((b) => b.phase === "merge").idle.reviewer, 20 * 60, "the merge record waited 20 minutes on the reviewer");

  const owner = list.items.find((i) => i.number === 13), open = list.items.find((i) => i.number === 14);
  assert.deepEqual(owner.blocks.map(span), [["open", "12:00:00", "12:01:00", 1], ["ci", "12:01:00", "12:30:00", 1], ["deploy", "12:30:00", "23:00:00", 1]]);
  assert.deepEqual([owner.state, owner.end, owner.task], ["merged", null, null]);
  assert.deepEqual([open.state, open.blocks.map((b) => b.phase)], ["open", ["open", "ci"]]);

  assert.deepEqual(flow.journey({ name: "pr", since: DAY, authors: ["agent"] }).items.map((i) => i.number), [15, 12]);
  assert.deepEqual(flow.journey({ name: "pr", since: DAY, sort: "rounds" }).items.map((i) => i.number), [12, 13, 14, 15]);
  assert.deepEqual(flow.journey({ name: "pr", since: DAY, sort: "slowest", limit: 1 }).items.map((i) => i.number), [13], "the owner's PR has waited 10.5 hours for a deploy");
  assert.equal(flow.journey({ name: "nope", since: DAY }), undefined);
});

test("insights: phase percentiles, rounds, rejections, funnel, cost, DORA's five and the aging list", () => {
  const { add, flow } = setup();
  agentPr(add); ownerAndOpen(add);
  const i = flow.summary({ since: DAY, to: "2026-11-20T00:00:00.000Z" }).insights;
  const review = i.phases.find((p) => p.name === "review");
  assert.deepEqual([review.n, review.p50, review.rounds_mean], [1, 2 * 3600 + 15 * 60, 3]);
  assert.deepEqual(i.rounds.review, { 3: 1 });
  assert.deepEqual(i.rejections, [{ reason: "scope", n: 2 }]);
  assert.deepEqual(i.funnel.map((s) => s.n), [1, 3, 1, 2, 2, 1]);
  assert.deepEqual(i.scatter.map((p) => p.subject), ["pr:acme/widgets#12"]);
  assert.equal(i.cost.by_agent[0].key, "engineer-a");
  assert.equal(i.cost.by_agent[0].usd, 2);
  assert.deepEqual(i.cost.per_merged.map((w) => w.usd), [2]);
  assert.equal(i.dora5.deploys_per_day.value, 1);
  assert.equal(i.dora5.lead_time_s.value, 60 * 60);
  assert.equal(i.dora5.rework_rate.value, 0);
  assert.equal(i.dora5.deploys_per_day.previous, 0, "the day before is loaded: no deploys, a real zero");
  assert.deepEqual(i.aging.map((a) => [a.subject, a.phase]), [["pr:acme/widgets#14", "ci"]]);
  assert.deepEqual(i.throughput.map((d) => [d.opened, d.merged]), [[3, 2]]);
  assert.deepEqual(i.cfd[0].counts, { done: 1, deploy: 1, ci: 1 });
  assert.equal(i.first_pass[0].rate, 0);
  assert.deepEqual(i.bottlenecks.map((b) => b.kind), ["idle", "rounds", "slow"]);
  assert.match(i.bottlenecks[1].text, /^AI review took 3\.0 rounds/);
});

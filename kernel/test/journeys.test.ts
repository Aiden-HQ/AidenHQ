// Journeys (journeys.ts): one PR's phases from its issue to its deploy, its rounds and idle, and the insights over them; one piece
// of work's (a root task, its subtasks and their PRs), from its issue to its deploy.
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

function setup(journeys = [PR]) {
  const db = new DatabaseSync(":memory:");
  const facts = openFacts(db, () => new Date(NOW));
  let n = 0;
  const add = (type, subject, at, data = {}, over = {}) => facts.record({ type, subject, version: String(n++), at: `${D}${at}.000Z`, actor: "unknown", task: null, data, ...over });
  return { db, add, flow: createFlow({ db, stages: () => KERNEL_STAGES, journeys: () => journeys, now: () => new Date(NOW), cacheMs: 0 }) };
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
  db.exec("CREATE TABLE records (task TEXT, kind TEXT, args TEXT, outcome TEXT, state TEXT, created_at TEXT, identifier TEXT)");
  db.prepare("INSERT INTO records VALUES ('t2', 'github.pr', '{}', ?, 'done', ?, 'WOR-2')").run(JSON.stringify({ ok: true, text: "opened https://github.com/acme/widgets/pull/15" }), `${D}13:30:00.000Z`);
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
  assert.deepEqual(i.funnel.map((s) => [s.step, s.n]), [["started", 3], ["triage", 1], ["pickup", 1], ["coding", 1], ["review", 1], ["open", 3], ["ci", 3], ["merge", 1], ["deploy", 2], ["done", 1]]);
  assert.deepEqual(i.scatter.map((p) => p.subject), ["pr:acme/widgets#12"]);
  assert.equal(i.cost.by_agent[0].key, "engineer-a");
  assert.equal(i.cost.by_agent[0].usd, 2);
  assert.deepEqual(i.cost.per_delivered.map((w) => w.usd), [2]);
  assert.equal(i.dora5.deploys_per_day.value, 1);
  assert.equal(i.dora5.lead_time_s.value, 60 * 60);
  assert.equal(i.dora5.rework_rate.value, 0);
  assert.equal(i.dora5.deploys_per_day.previous, 0, "the day before is loaded: no deploys, a real zero");
  assert.deepEqual(i.aging.map((a) => [a.subject, a.phase]), [["pr:acme/widgets#14", "ci"]]);
  assert.deepEqual(i.throughput.map((d) => [d.started, d.delivered]), [[3, 2]]);
  assert.deepEqual(i.cfd[0].counts, { done: 1, deploy: 1, ci: 1 });
  assert.equal(i.first_pass[0].rate, 0);
  assert.deepEqual(i.bottlenecks.map((b) => b.kind), ["idle", "rounds", "slow"]);
  assert.match(i.bottlenecks[1].text, /^AI review took 3\.0 rounds/);
});

const WORK = {
  name: "work", label: "Work", subject: "task", module: "tasks", end: ["task.status_changed"], end_where: { to: ["done", "cancelled"] },
  phases: [
    { name: "triage", label: "Triage", from: ["issue.opened"] },
    { name: "queued", label: "Queued", from: ["issue.labeled", "task.created"] },
    { name: "working", label: "Working", from: ["job.started"] },
    { name: "review", label: "AI review", from: ["record.filed"], where: { kind: ["github.pr", "github.push"] } },
    { name: "open", label: "PR open", from: ["pr.opened"] },
    { name: "ci", label: "CI", from: ["pr.checks_started", "pr.pushed"] },
    { name: "merge", label: "Merge review", from: ["record.filed"], where: { kind: ["github.merge"] } },
    { name: "deploy", label: "Deploy", from: ["pr.merged"] },
    { name: "finish", label: "Finishing", from: ["pr.deployed", "grade.requested"] },
  ],
};

test("a piece of work: its issue, its root's and subtask's jobs and the subtask's PR, done once the PR deployed; a chat's subtask is its own root", () => {
  const { add, flow } = setup([WORK, PR]);
  const w = (task) => ({ task, actor: "agent:engineer-a" });
  add("issue.opened", "issue:acme/widgets#7", "08:00:00", { author_kind: "outside" });
  add("issue.labeled", "issue:acme/widgets#7", "08:10:00", { label: "agent" });
  add("task.created", "task:w1", "08:11:00", { parent: null, identifier: "WOR-1", chat: false, source_marker: "maintainer-issue:Acme/Widgets#7" }, { task: "w1" });
  add("job.started", "job:j1", "08:12:00", {}, w("w1"));
  add("task.created", "task:w2", "08:19:00", { parent: "w1", identifier: "WOR-2", chat: false }, { task: "w2" }); // delegated: a second round of work
  add("job.ended", "job:j1", "08:20:00", { cost_usd: 1 }, w("w1"));
  add("job.started", "job:j2", "08:20:00", {}, w("w2"));
  add("job.ended", "job:j2", "08:50:00", { cost_usd: 2 }, w("w2"));
  add("record.filed", "record:r1", "08:50:00", { kind: "github.pr", state: "review" }, w("w2"));
  add("record.decided", "record:r1", "08:55:00", { decision: "approved", decider: "reviewer" }, { task: "w2" });
  add("pr.opened", "pr:acme/widgets#12", "08:56:00", { repo: "acme/widgets", number: 12, author_kind: "agent" }, { task: "w2" });
  add("pr.checks_started", "pr:acme/widgets#12@h1", "08:57:00", { head: "h1" }, { task: "w2" });
  add("record.filed", "record:m1", "09:05:00", { kind: "github.merge", state: "review", pr: "acme/widgets#12" }, w("w2"));
  add("pr.merged", "pr:acme/widgets#12", "09:11:00", { sha: "abc" });
  add("task.status_changed", "task:w2", "09:12:00", { to: "done" }, { task: "w2" });
  add("task.status_changed", "task:w1", "09:15:00", { to: "done" }, { task: "w1" });
  add("pr.deployed", "pr:acme/widgets#12", "09:30:00", { pr: "acme/widgets#12", generation: 5 });
  // a chat (a conversation, not work) and the request it delegated
  add("task.created", "task:c1", "07:00:00", { parent: null, identifier: "WOR-3", chat: true }, { task: "c1" });
  add("task.created", "task:w4", "10:00:00", { parent: "c1", identifier: "WOR-4", chat: false }, { task: "w4" });
  add("job.started", "job:j4", "10:01:00", {}, w("w4"));
  add("task.status_changed", "task:w4", "10:06:00", { to: "done" }, { task: "w4" });
  // done, but its merged PR (of a repo that deploys) not yet deployed: still open, in the deploy phase
  add("task.created", "task:w5", "11:00:00", { parent: null, identifier: "WOR-5", chat: false }, { task: "w5" });
  add("pr.opened", "pr:acme/widgets#13", "11:10:00", { repo: "acme/widgets", number: 13 }, { task: "w5" });
  add("pr.merged", "pr:acme/widgets#13", "11:20:00", { sha: "def" }, { task: "w5" });
  add("task.status_changed", "task:w5", "11:25:00", { to: "done" }, { task: "w5" });

  const list = flow.journeys().journeys;
  assert.equal(list[0].name, "work", "a piece of work's journey comes first");
  const items = flow.journey({ name: "work", since: DAY }).items, of = (id) => items.find((i) => i.identifier === id);
  assert.deepEqual(items.map((i) => i.identifier).sort(), ["WOR-1", "WOR-4", "WOR-5"], "one item per root; the chat isn't one");
  const w1 = of("WOR-1");
  assert.deepEqual(w1.blocks.map(span), [
    ["triage", "08:00:00", "08:10:00", 1], ["queued", "08:10:00", "08:12:00", 1], ["working", "08:12:00", "08:50:00", 2], ["review", "08:50:00", "08:56:00", 1],
    ["open", "08:56:00", "08:57:00", 1], ["ci", "08:57:00", "09:05:00", 1], ["merge", "09:05:00", "09:11:00", 1], ["deploy", "09:11:00", "09:30:00", 1]]);
  assert.deepEqual([w1.subject, w1.task, w1.state, w1.end, w1.links.map((l) => l.url)],
    ["task:w1", "w1", "done", `${D}09:30:00.000Z`, ["https://github.com/acme/widgets/issues/7", "https://github.com/acme/widgets/pull/12"]]);
  assert.deepEqual([of("WOR-4").blocks.map(span), of("WOR-4").state], [[["queued", "10:00:00", "10:01:00", 1], ["working", "10:01:00", "10:06:00", 1]], "done"]);
  assert.deepEqual([of("WOR-5").state, of("WOR-5").end, of("WOR-5").blocks.at(-1).phase], ["open", null, "deploy"]);

  const i = flow.summary({ since: DAY, to: "2026-11-20T00:00:00.000Z", journey: "work" }).insights;
  assert.deepEqual(i.funnel.map((s) => [s.step, s.n]).filter(([, n]) => n), [["started", 3], ["triage", 1], ["queued", 3], ["working", 2], ["review", 1], ["open", 2], ["ci", 1], ["merge", 1], ["deploy", 2], ["done", 2]]);
  assert.equal(i.cost.by_agent[0].usd, 3, "the root's and the subtask's jobs");
  assert.deepEqual(i.aging.map((a) => a.identifier), ["WOR-5"]);
});

// A session's job lives on (kernel: the `session` profile): a timer or a wait that comes due while it runs reaches it as a wake
// notice on its task, never a second job; and its job is never stopped for want of progress, which a crew job is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDispatch, noticeId } from "../service/src/loop.ts";

function fake({ jobs = [], directory = {} } = {}) {
  const task = { id: "t1", identifier: "WOR-1", title: "Watch acme/widgets#1", description: "When it merges, merge #2.", status: "in_progress", assigneeAgentId: "ses", createdByUserId: "u1" };
  const k = { inbox: [], wakes: [], dropped: [], started: [], stopped: [] };
  k.kernel = {
    claim: async () => k.inbox.splice(0),
    drop: async (key, why) => void k.dropped.push({ key, why }),
    task: async () => task,
    children: async () => [],
    comments: async () => [],
    agent: async (id) => ({ id, name: id }),
    directory: async () => directory,
    connectionsDown: async () => [],
    wake: async (t, text, id) => void k.wakes.push({ task: t, text, id }),
    start: async (req) => (k.started.push(req), { job: { id: "j-new", task: "t1", agent: "ses", state: "running", at: 1, acked: false } }),
    open: async () => jobs,
    jobsOf: async () => jobs,
    stop: async (job) => void k.stopped.push(job),
    input: async () => ({ sent: true }), note: async () => {}, post: async () => {}, ack: async () => {}, fileTask: async () => {}, notify: async () => {}, schedule: async () => {},
  };
  k.dispatch = createDispatch({ kernel: k.kernel, db: new DatabaseSync(":memory:"), owner: "Dana" });
  return k;
}

test("a due wait on a live session becomes a wake notice", async () => {
  const k = fake({ jobs: [{ id: "j1", task: "t1", agent: "ses", state: "running", at: 1, acked: false, progress: {} }], directory: { ses: { profile: "session" } } });
  const row = { key: "wait:T:123", task: "t1", agent: "ses", cause: "wait: PR #1 to merge", at: 123, live_job: "j1" };
  k.inbox.push(row);
  await k.dispatch.tick();
  k.inbox.push(row); // handled again (its drop's answer lost): filed again with the same id, which the kernel dedupes
  await k.dispatch.tick();
  assert.deepEqual(k.wakes, [1, 2].map(() => ({ task: "t1", text: "Your wait is up: PR #1 to merge", id: noticeId("wait:T:123") })));
  assert.match(noticeId("wait:T:123"), /^w-[0-9a-f]{40}$/);
  assert.deepEqual(k.dropped.map((d) => d.key), ["wait:T:123", "wait:T:123"]);
  assert.equal(k.started.length, 0, "no second job");
});

test("a session job is never stopped for no progress; a crew job is", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-25T10:00:00Z") });
  const job = (id, agent) => ({ id, task: "t1", agent, state: "running", at: 1, acked: false, progress: { steps: [] } });
  const k = fake({ jobs: [job("j-ses", "ses"), job("j-crew", "crew")], directory: { ses: { profile: "session" }, crew: { profile: "crew" } } });
  // The task read names no assignee, so neither run reads as moved to another agent.
  k.kernel.task = async () => ({ id: "t1", identifier: "WOR-1", status: "in_progress", assigneeAgentId: undefined });
  await k.dispatch.tick();
  t.mock.timers.tick(40 * 60_000);
  await k.dispatch.tick();
  assert.deepEqual(k.stopped, ["j-crew"]);
});

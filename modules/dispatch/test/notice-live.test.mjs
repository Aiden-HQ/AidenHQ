// A module's wake notice (POST /v1/wakes {task, text}: a comment marked aidenhq-wake, e.g. primer's comment wake loop) that lands
// while the task's run is live goes into that run as a notice, never a second job and never the owner's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDispatch } from "../service/src/loop.ts";

test("a wake notice during a live run is passed to that run as a notice; no second job", async () => {
  const task = { id: "t1", identifier: "WOR-1", title: "Write the Q3 plan", description: "Publish it on Primer.", status: "in_progress", assigneeAgentId: "eng", createdByUserId: "u1" };
  const comments = [], inputs = [], started = [], jobs = new Map();
  const inbox = [{ key: "issue:t1:1", task: "t1", agent: "eng", cause: "assigned", at: Date.now() }];
  const kernel = {
    claim: async () => inbox.splice(0),
    drop: async () => {},
    task: async () => task,
    children: async () => [],
    comments: async () => comments,
    agent: async (id) => ({ id, name: "Ada" }),
    directory: async () => ({}),
    start: async (req) => { const job = { id: `j${jobs.size + 1}`, task: "t1", agent: "eng", state: "running", at: jobs.size + 1, acked: false }; jobs.set(job.id, job); started.push(req); return { job }; },
    open: async () => [...jobs.values()].filter((j) => !j.acked),
    jobsOf: async () => [...jobs.values()],
    input: async (job, b) => (inputs.push({ job, ...b }), { sent: true }),
    note: async () => {}, post: async () => {}, ack: async () => {}, wake: async () => {}, fileTask: async () => {}, notify: async () => {}, stop: async () => {},
  };
  const dispatch = createDispatch({ kernel, db: new DatabaseSync(":memory:"), owner: "Dana" });
  await dispatch.tick();
  assert.equal(started.length, 1);
  comments.push({ id: "n1", authorType: "user", body: "[wake] New comment on Primer document d1 (thread th1, comment c1; 1 comment not yet addressed by a version).\n\n<!-- aidenhq-wake -->", createdAt: "2026-11-19T10:00:00Z" });
  inbox.push({ key: "comment:n1", task: "t1", agent: "eng", cause: "comment", at: Date.now(), live_job: "j1" });
  await dispatch.tick();
  assert.equal(started.length, 1, "no second job");
  assert.deepEqual(inputs.map((i) => [i.job, i.from, i.wake]), [["j1", "wake notice", "comment:n1"]]);
  assert.match(inputs[0].text, /document d1 \(thread th1, comment c1;/);
});

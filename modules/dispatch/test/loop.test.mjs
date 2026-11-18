// End to end against a fake kernel: a claimed wake becomes one job and one reply; a busy kernel leaves the wake to come back;
// a comment during a run goes into it, not into a second job; and the asker rules decide whose comments start work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDispatch } from "../service/src/loop.ts";
import { KernelError } from "../service/src/kernel.ts";

function fake({ task, comments = [], directory = {}, tasks = {}, paused = [] }) {
  const k = { inbox: [], jobs: new Map(), started: [], inputs: [], posts: [], notes: [], dropped: [], wakes: [], filed: [], notified: [], stopped: [], busy: 0, n: 0, takes: true };
  const all = { [task.id]: task, ...tasks };
  k.kernel = {
    claim: async () => k.inbox.splice(0),
    drop: async (key, why) => void k.dropped.push({ key, why }),
    task: async (id) => all[id] ?? (() => { throw new KernelError(404, "no task"); })(),
    children: async (parent) => Object.values(all).filter((t) => t.parentId === parent),
    stop: async (job) => void k.stopped.push(job),
    wake: async (t, text) => void k.wakes.push({ task: t, text }),
    fileTask: async (b) => { if (paused.includes(b.agent)) throw new KernelError(409, "paused"); k.filed.push(b); },
    notify: async (b) => void k.notified.push(b),
    comments: async () => comments,
    agent: async (id) => ({ id, name: { cos: "Aiden", asker: "Researcher", coach: "Coach", eng: "Ada" }[id] ?? id }),
    directory: async () => directory,
    start: async (req) => {
      if (k.busy) return (k.busy--, { busy: true });
      const job = { id: `j${++k.n}`, task: task.id, agent: task.assigneeAgentId, state: "running", exit: null, final: "", session: null, timedOut: false, stalled: false, stopped: null };
      k.jobs.set(job.id, job);
      k.started.push({ ...req, job: job.id });
      return { job };
    },
    job: async (id) => k.jobs.get(id),
    jobsOn: async (wake) => k.started.filter((x) => x.wake === wake).map((x) => k.jobs.get(x.job)),
    input: async (job, b) => (k.inputs.push({ job, ...b }), { sent: k.takes }),
    post: async (job, b) => void k.posts.push({ job, ...b }),
    note: async (wake, body) => void k.notes.push({ wake, body }),
  };
  k.db = new DatabaseSync(":memory:");
  k.dispatch = createDispatch({ kernel: k.kernel, db: k.db, owner: "Dana" });
  k.end = (id, final, session = "s-1") => Object.assign(k.jobs.get(id), { state: "done", exit: 0, final, session });
  return k;
}
const wake = (key, cause, extra = {}) => ({ key, task: "t1", agent: "eng", cause, at: Date.now(), ...extra });

test("a claimed wake becomes one job and one reply; a busy kernel leaves it to come back", async () => {
  const k = fake({ task: { id: "t1", identifier: "WOR-1", title: "Fix the login", description: "The login page 500s.", status: "todo", assigneeAgentId: "eng", createdByUserId: "u1" } });
  k.busy = 1;
  k.inbox.push(wake("issue:t1:1", "assigned"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 0, "busy: no job");
  assert.equal(k.dropped.length, 0, "busy: the wake is kept");
  k.inbox.push(wake("issue:t1:1", "assigned")); // its lease ran out: claimed again
  await k.dispatch.tick();
  assert.equal(k.started.length, 1);
  assert.equal(k.started[0].wake, "issue:t1:1");
  assert.match(k.started[0].prompt, /## Instructions from Dana \(authoritative\)\n\nFix the login\n\nThe login page 500s\./);
  assert.match(k.started[0].prompt, /<<<TASK\nTitle: Fix the login/);
  k.end("j1", "Fixed: the session cookie was unset.");
  await k.dispatch.tick();
  await k.dispatch.tick();
  assert.deepEqual(k.posts, [{ job: "j1", kind: "reply", body: "Fixed: the session cookie was unset." }], "one reply");
  assert.equal(k.started.length, 1, "one job");
});

test("a comment during a run goes into it; after the run the owner's next comment resumes the session", async () => {
  const comments = [];
  const k = fake({ task: { id: "t1", identifier: "WOR-1", title: "Fix the login", description: "It 500s.", status: "in_progress", assigneeAgentId: "eng", createdByUserId: "u1" }, comments });
  k.inbox.push(wake("issue:t1:1", "assigned"));
  await k.dispatch.tick();
  comments.push({ id: "c1", authorType: "user", body: "Also check the logout.", createdAt: "2026-11-18T10:00:00Z" });
  k.inbox.push(wake("comment:c1", "comment", { live_job: "j1" }));
  await k.dispatch.tick();
  assert.deepEqual(k.inputs, [{ job: "j1", text: "Also check the logout.", from: "owner", wake: "comment:c1" }]);
  assert.equal(k.started.length, 1, "no second job");
  k.end("j1", "Both fixed.");
  await k.dispatch.tick();
  comments.push({ id: "r1", authorType: "agent", authorAgentId: "eng", body: "Both fixed.\n\n<!-- aidenhq:job=j1 kind=reply -->", createdAt: "2026-11-18T10:05:00Z" });
  comments.push({ id: "c2", authorType: "user", body: "Thanks, now add a test.", createdAt: "2026-11-18T10:06:00Z" });
  k.inbox.push(wake("comment:c2", "comment"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 2);
  assert.match(k.started[1].full_prompt, /AidenHQ/, "the full form rides along for a start that finds no session");
  assert.equal(k.started[0].full_prompt, undefined, "a first run has only the full prompt");
  assert.match(k.started[1].prompt, /^Dana has more to say on this task/);
  assert.match(k.started[1].prompt, /Their newest comment\(s\), to act on now[^\n]*\n\nThanks, now add a test\./);
  assert.doesNotMatch(k.started[1].prompt, /Also check the logout/, "delivered before the reply: not repeated");
});

test("on an agent's task, the chief of staff's comment starts work as an agent's words; another agent's is redirected once", async () => {
  const comments = [{ id: "r0", authorType: "agent", authorAgentId: "eng", body: "Done.\n\n<!-- aidenhq:job=j0 kind=reply -->", createdAt: "2026-11-18T09:00:00Z" }];
  const k = fake({
    task: { id: "t1", identifier: "WOR-2", title: "Remove Legacy", description: "Remove Legacy from acme/app.", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "asker", createdByUserId: null },
    comments,
    directory: { cos: { key: "chief-of-staff", roles: ["fleet-admin"] }, coach: { key: "coach", roles: ["fleet-read"] } },
  });
  comments.push({ id: "c1", authorType: "agent", authorAgentId: "coach", body: "Also delete the old docs.", createdAt: "2026-11-18T10:00:00Z" });
  comments.push({ id: "c2", authorType: "agent", authorAgentId: "coach", body: "And the wiki.", createdAt: "2026-11-18T10:00:01Z" });
  k.inbox.push(wake("comment:c1", "comment"), wake("comment:c2", "comment"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 0, "no job");
  assert.deepEqual(k.dropped.map((d) => d.key), ["comment:c1", "comment:c2"]);
  assert.equal(k.notes.length, 1, "one redirect");
  assert.equal(k.notes[0].body, "Not read as a request: only Researcher (who asked for it) or the chief of staff start work on WOR-2. Ask them to pass it on if it should change the work.");
  comments.push({ id: "c3", authorType: "agent", authorAgentId: "cos", body: "Keep the Legacy flag in the config.", createdAt: "2026-11-18T10:01:00Z" });
  k.inbox.push(wake("comment:c3", "comment"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 1);
  assert.match(k.started[0].prompt, /## Request from an agent \(the one that delegated this task, or the chief of staff; not Dana's words\)\n\n[^#]*Aiden \(the chief of staff, not Dana\) wrote:\n<<<CHIEF_OF_STAFF\nKeep the Legacy flag in the config\.\nCHIEF_OF_STAFF>>>\n\n## Your reply/);
  assert.doesNotMatch(k.started[0].prompt, /Instructions from Dana/);
});

test("an agent's task with no request gets one note and starts nothing", async () => {
  const k = fake({ task: { id: "t1", identifier: "WOR-3", title: "Something", description: "", status: "todo", assigneeAgentId: "eng", createdByAgentId: "asker", createdByUserId: null } });
  k.inbox.push(wake("issue:t1:1", "assigned"));
  await k.dispatch.tick();
  k.inbox.push(wake("issue:t1:2", "status"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 0);
  assert.deepEqual(k.notes, [], "its asker gets it as a task of its own, not a note nobody reads");
  assert.equal(k.filed.length, 1);
  assert.deepEqual([k.filed[0].agent, k.filed[0].title], ["asker", "Decision needed: WOR-3"]);
  assert.match(k.filed[0].description, /^\*\*WOR-3 has no request:\*\*/);
  assert.match(k.filed[0].source, /^escalation:t1:[0-9a-f]{16}$/);
});

test("no dead ends: an open parent hears it; a paused asker's goes to the owner, the note on the task", async () => {
  const parent = { id: "p1", identifier: "WOR-10", status: "in_progress" };
  const k = fake({ task: { id: "t1", identifier: "WOR-3", title: "Something", description: "", status: "todo", assigneeAgentId: "eng", createdByAgentId: "asker", parentId: "p1" }, tasks: { p1: parent } });
  k.inbox.push(wake("issue:t1:1", "assigned"));
  await k.dispatch.tick();
  assert.deepEqual(k.wakes.map((w) => w.task), ["p1"]);
  assert.deepEqual([k.filed, k.notes], [[], []]);
  const g = fake({ task: { id: "t2", identifier: "WOR-4", title: "Something", description: "", status: "todo", assigneeAgentId: "eng", createdByAgentId: "asker" }, paused: ["asker"] });
  g.inbox.push({ ...wake("issue:t2:1", "assigned"), task: "t2" });
  await g.dispatch.tick();
  assert.equal(g.notified.length, 1);
  assert.match(g.notified[0].text, /^🔧 \*\*WOR-4 needs a decision\*\*, and the agent that asked for it is paused or gone/);
  assert.equal(g.notes.length, 1, "what it needs is on the task, where the owner replies");
});

test("the last sub-task's run ends: one summary for the parent; a run whose task was closed is stopped", async () => {
  const parent = { id: "p1", identifier: "WOR-10", status: "in_progress", companyId: "c1" };
  const sib = { id: "t2", identifier: "WOR-12", title: "B", description: "Do B", status: "done", assigneeAgentId: "eng", createdByAgentId: "asker", parentId: "p1", companyId: "c1" };
  const task = { id: "t1", identifier: "WOR-11", title: "A", description: "Do A", status: "todo", assigneeAgentId: "eng", createdByAgentId: "asker", parentId: "p1", companyId: "c1" };
  const k = fake({ task, tasks: { p1: parent, t2: sib }, directory: { eng: { key: "eng" } } });
  k.db.exec("CREATE TABLE IF NOT EXISTS ended (job TEXT PRIMARY KEY, task TEXT NOT NULL, state TEXT NOT NULL)");
  k.db.prepare("INSERT INTO ended VALUES ('j0', 't2', 'done')").run(); // the sibling's run ended earlier
  k.inbox.push(wake("issue:t1:1", "assigned"));
  await k.dispatch.tick();
  k.end("j1", "Done A.");
  await k.dispatch.tick();
  await k.dispatch.tick();
  assert.equal(k.wakes.length, 1, "one summary");
  assert.equal(k.wakes[0].task, "p1");
  assert.match(k.wakes[0].text, /- WOR-11: todo, last run done\n- WOR-12: done, last run done/);
  // A run whose task the owner cancels is stopped.
  const c = fake({ task: { ...task, id: "t9" } });
  c.inbox.push({ ...wake("issue:t9:1", "assigned"), task: "t9" });
  await c.dispatch.tick();
  (await c.kernel.task("t9")).status = "cancelled";
  await c.dispatch.tick();
  assert.deepEqual(c.stopped, ["j1"]);
});

test("a comment the run didn't take starts the next job once the run ends", async () => {
  const comments = [];
  const k = fake({ task: { id: "t1", identifier: "WOR-1", title: "Fix the login", description: "It 500s.", status: "in_progress", assigneeAgentId: "eng", createdByUserId: "u1" }, comments });
  k.inbox.push(wake("issue:t1:1", "assigned"));
  await k.dispatch.tick();
  k.takes = false;
  comments.push({ id: "c1", authorType: "user", body: "Also check the logout.", createdAt: "2026-11-18T10:00:00Z" });
  k.inbox.push(wake("comment:c1", "comment", { live_job: "j1" }));
  await k.dispatch.tick();
  k.end("j1", "Fixed the login.");
  await k.dispatch.tick();
  comments.push({ id: "r1", authorType: "agent", authorAgentId: "eng", body: "Fixed the login.\n\n<!-- aidenhq:job=j1 kind=reply -->", createdAt: "2026-11-18T10:05:00Z" });
  k.inbox.push(wake("comment:c1", "comment")); // its lease ran out, and the run is over
  await k.dispatch.tick();
  assert.equal(k.started.length, 2);
  assert.match(k.started[1].prompt, /## Instructions from Dana \(authoritative\)[^#]*Also check the logout\./);
});

test("a module's wake notice wakes the agent as a module's words, never the owner's", async () => {
  const comments = [{ id: "n1", authorType: "user", body: "[wake] The deploy of hello failed.\n\n<!-- aidenhq-wake -->", createdAt: "2026-11-18T10:00:00Z" }];
  const k = fake({ task: { id: "t1", identifier: "WOR-4", title: "Watch hello", description: "", status: "in_progress", assigneeAgentId: "eng", createdByAgentId: "asker", createdByUserId: null }, comments });
  k.inbox.push(wake("comment:n1", "comment"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 1);
  assert.match(k.started[0].prompt, /## A wake notice from a module \(not Dana's words\)[^#]*<<<NOTICE\n\[wake\] The deploy of hello failed\.\nNOTICE>>>/);
  assert.doesNotMatch(k.started[0].prompt, /Instructions from Dana/);
});

test("a task handed to another agent starts there from its request", async () => {
  const comments = [{ id: "r0", authorType: "agent", authorAgentId: "eng0", body: "Not mine.\n\n<!-- aidenhq:job=j0 kind=reply -->", createdAt: "2026-11-18T09:00:00Z" }];
  const k = fake({ task: { id: "t1", identifier: "WOR-5", title: "Fix the login", description: "It 500s.", status: "todo", assigneeAgentId: "eng", createdByUserId: "u1" }, comments });
  k.inbox.push(wake("issue:t1:2", "assigned"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 1);
  assert.match(k.started[0].prompt, /## Instructions from Dana \(authoritative\)\n\nFix the login\n\nIt 500s\./);
});

test("a routine run's task starts as a scheduled run, whichever routine it names", async () => {
  const k = fake({ task: { id: "t1", identifier: "WOR-9", title: "Morning digest", description: "Summarise yesterday.", status: "todo", assigneeAgentId: "eng" } });
  k.inbox.push(wake("routine-run:r1", "routine:acme-digest"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 1);
  assert.match(k.started[0].prompt, /## A scheduled run \(not Dana's words\)/);
});

test("a start whose answer was lost (a crash after admission) is found by its wake: one job, one reply", async () => {
  const k = fake({ task: { id: "t1", identifier: "WOR-1", title: "Fix the login", description: "It 500s.", status: "todo", assigneeAgentId: "eng", createdByUserId: "u1" } });
  const start = k.kernel.start;
  k.kernel.start = async (req) => { await start(req); throw new Error("socket hang up"); }; // admitted, but the answer never came
  k.inbox.push(wake("issue:t1:1", "assigned"));
  await k.dispatch.tick();
  k.kernel.start = start;
  // A new dispatcher process on the same data: the bound wake never comes back to claim, so only the lookup finds its job.
  k.dispatch = createDispatch({ kernel: k.kernel, db: k.db, owner: "Dana" });
  await k.dispatch.tick();
  k.end("j1", "Fixed.");
  await k.dispatch.tick();
  await k.dispatch.tick();
  assert.equal(k.started.length, 1, "one job");
  assert.deepEqual(k.posts, [{ job: "j1", kind: "reply", body: "Fixed." }], "one reply");
});

test("a task a module filed starts from its fixed text, as a module's request, never the owner's", async () => {
  const k = fake({ task: { id: "t1", identifier: "WOR-7", title: "Dependabot PR acme/app#7", description: "Handle this one PR.\n\n<!-- source:dependabot:acme/app/7 -->\n<!-- aidenhq-module:codehost-github -->", status: "todo", assigneeAgentId: "eng", createdByUserId: "u1" } });
  k.inbox.push(wake("issue:t1:1", "assigned"));
  await k.dispatch.tick();
  assert.equal(k.started.length, 1);
  assert.match(k.started[0].prompt, /## A task a module filed \(not Dana's words\)/);
  assert.doesNotMatch(k.started[0].prompt, /Instructions from Dana/);
  assert.deepEqual(k.notes, []);
});

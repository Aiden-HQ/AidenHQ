// An agent-filed task under the owner's task is the agent's to finish: done closes it, and a handoff
// keeps it and asks its delegator (the chief of staff when nobody delegated it), never the owner. Only a part the owner gave
// the agent stays open for the owner's replies.
// The tasks module against a fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, waits } from "./helpers.ts";

async function call(tool, args, createdByAgentId, status = "in_progress", roles = [], parentStatus = "todo") {
  const patches = [];
  const issues = {
    cur: { id: "cur", identifier: "WOR-2", title: "Follow up the review", status, parentId: "par", assigneeAgentId: "me", createdByAgentId },
    par: { id: "par", identifier: "WOR-1", title: "Ship the schema", status: parentStatus, assigneeUserId: "owner", assigneeAgentId: null },
  };
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Roadmap Keeper" });
      if (url.startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (m && m[2] && req.method === "GET") return send([]);
      if (m && m[2]) return send({ id: "c1" });
      if (m && req.method === "PATCH") {
        const patch = JSON.parse(body);
        patches.push({ issue: m[1], ...patch });
        return send(Object.assign(issues[m[1]], patch));
      }
      if (m) return send(issues[m[1]] ?? {});
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const r = await bridge({ handler, agents: { me: { key: roles.includes("fleet-settle") ? "fleet-steward" : "roadmap-keeper", roles } }, task: "cur", acceptWaits: true }).call(tool, args);
  return { error: r.result?.isError ? r.result.content[0].text : undefined, patches };
}

/** A handoff of one task out of `issues`, as the Fleet Steward (`fleet-settle`) or an ordinary agent. */
async function handoff(issues, roles = ["fleet-settle"], task = "cur", issue = "cur") {
  const patches = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: roles.includes("fleet-settle") ? "Fleet Steward" : "Roadmap Keeper" });
      if (url.startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (m && m[2]) return send(req.method === "GET" ? [] : { id: "c1" });
      if (m && req.method === "PATCH") {
        const patch = JSON.parse(body);
        patches.push({ issue: m[1], ...patch });
        return send(Object.assign(issues[m[1]], patch));
      }
      if (m) return send(issues[m[1]] ?? {});
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const r = await bridge({ handler, agents: { me: { key: roles.includes("fleet-settle") ? "fleet-steward" : "roadmap-keeper", roles } }, task, acceptWaits: true }).call("task_handoff", { issue, comment: "Over to you." });
  return { error: r.result?.isError ? r.result.content[0].text : undefined, patches };
}

test("task_finish closes a task this agent filed under the owner's task", async () => {
  const { error, patches } = await call("task_finish", { comment: "Done: answers transcribed." }, "me");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done", comment: "Done: answers transcribed." }]);
});

test("a handoff of an agent-filed task stays with the agent and asks its delegator, never the owner", async () => {
  const { error, patches } = await call("task_handoff", { issue: "cur", comment: "Run the slash command /deploy." }, "me");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "todo", comment: "Run the slash command /deploy." }]);
  assert.deepEqual(waits.at(-1), { for: "delegator", reason: "handed back: waiting on the delegator's call", question: "Run the slash command /deploy." });
});

test("a task this agent filed and then handed off can still be finished with done", async () => {
  const { error, patches } = await call("task_finish", { comment: "Done." }, "me", "todo");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done", comment: "Done." }]);
});

test("a task another agent filed, now assigned to this agent, is this agent's to finish", async () => {
  const { error, patches } = await call("task_finish", { comment: "Done." }, "someone-else", "todo");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done", comment: "Done." }]);
});

test("a part the owner gave the agent still stays open for the owner's replies", async () => {
  const { error, patches } = await call("task_finish", { comment: "Done." }, null);
  assert.match(error, /your part of the user's task/);
  assert.deepEqual(patches, []);
});

test("once the owner closes their task, the agent's part of it is finished or cancelled, never handed back", async () => {
  // The owner's own parent: its part, parked on their reply, is the agent's to close once nobody waits on it.
  for (const [tool, status] of [["task_finish", "done"], ["task_cancel", "cancelled"]]) {
    const { error, patches } = await call(tool, { comment: "The owner closed the task." }, null, "backlog", [], "done");
    assert.equal(error, undefined);
    assert.deepEqual(patches, [{ issue: "cur", status, comment: "The owner closed the task." }]);
  }
  const before = waits.length;
  const { error, patches } = await call("task_handoff", { issue: "cur", comment: "Over to you." }, null, "backlog", [], "cancelled");
  assert.match(error, /the user closed the task WOR-2 is part of.*task_finish.*task_cancel/);
  assert.deepEqual([patches, waits.length], [[], before]);
});

test("a handoff whose wait the kernel refuses says so, so the agent can record the wait itself", async () => {
  // The fake kernel has no /v1/wait: every try fails.
  const patches = [];
  const issue = { id: "cur", identifier: "WOR-2", title: "t", status: "in_progress", parentId: "par", assigneeAgentId: "me" };
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Roadmap Keeper" });
      if (url.startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (m?.[2]) return send(req.method === "GET" ? [] : { id: "c1" });
      if (m && req.method === "PATCH") return (patches.push(JSON.parse(body)), send(Object.assign(issue, JSON.parse(body))));
      if (m) return send(m[1] === "par" ? { id: "par", identifier: "WOR-1", status: "todo", assigneeUserId: "owner" } : issue);
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const r = await bridge({ handler, agents: { me: { key: "roadmap-keeper", roles: [] } }, task: "cur" }).call("task_handoff", { issue: "cur", comment: "Waiting." });
  assert.equal(r.result?.isError, undefined);
  // The fallback must be an owner wait, not an event: an `on` wait wakes the task in 24 hours as idle work.
  assert.match(r.result.content[0].text, /wait_error.*task_wait \(for: owner, question: the handoff's words\), not an event wait/);
  assert.equal(patches.length, 1);
});

// The Fleet Steward (`fleet-settle`) has one ending of its own: its part of the user's task goes back to them as
// `todo` with an owner wait. Everything else it settles itself or routes, and its refusal names only paths that task has.

const ownPart = { id: "cur", identifier: "WOR-2", title: "Follow up the review", status: "in_progress", parentId: "par", assigneeAgentId: "me" };
const par = { id: "par", identifier: "WOR-1", title: "Ship the schema", status: "todo", assigneeUserId: "owner", assigneeAgentId: null };

test("a fleet settler hands off its own part as todo, without giving it to the owner", async () => {
  const before = waits.length;
  const { error, patches } = await handoff({ cur: { ...ownPart }, par: { ...par } });
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "todo", comment: "Over to you." }]);
  // The wait is on the owner's reply, so the part is not idle work while it waits.
  assert.equal(waits.length, before + 1);
  assert.deepEqual(waits.at(-1), { for: "owner", asked: true, handoff: true, reason: "the user's reply to my handoff", question: "Over to you." });
});

test("a fleet settler cannot hand a task that is not its own part to the owner", async () => {
  const { error, patches } = await call("task_handoff", { issue: "cur", comment: "Over to you." }, "me", "in_progress", ["fleet-settle"]);
  // It holds this task, so finishing or cancelling it is a path the kernel takes; route is not named for a task it holds.
  assert.match(error, /Finish it with task_finish, or cancel it with task_cancel/);
  assert.doesNotMatch(error, /task_route/);
  assert.deepEqual(patches, []);
});

test("a fleet settler's refusal names route and cancel for another agent's task, never a finish the kernel refuses", async () => {
  // Another agent filed and holds it: the kernel finishes a settler's close only once the task waits in review.
  const { error, patches } = await handoff({ cur: { id: "cur", identifier: "WOR-2", title: "Someone else's", status: "in_progress", assigneeAgentId: "other", createdByAgentId: "other" } });
  assert.match(error, /task_route it to the agent that does the work, or cancel it with task_cancel; task_finish only once it waits in review/);
  assert.deepEqual(patches, []);
});

test("a fleet settler's refusal names no move on a task that is already closed", async () => {
  // task_route refuses a closed task and a settler moves open work only: neither route, finish nor cancel is a path.
  for (const status of ["done", "cancelled"]) {
    const { error, patches } = await handoff({ cur: { id: "cur", identifier: "WOR-2", title: "Closed", status, assigneeAgentId: "other", createdByAgentId: "other" } });
    assert.match(error, new RegExp(`it is ${status}, and a fleet settler moves open work only`));
    assert.doesNotMatch(error, /task_route|Finish it with task_finish|task_finish it/);
    assert.deepEqual(patches, []);
  }
});

test("a fleet settler's refusal offers task_finish for another agent's task only once it waits in review", async () => {
  for (const [status, finish] of [["in_review", true], ["in_progress", false], ["blocked", false], ["todo", false]]) {
    const { error, patches } = await handoff({ cur: { id: "cur", identifier: "WOR-2", title: "Another agent's", status, assigneeAgentId: "other", createdByAgentId: "other" } });
    assert.match(error, /task_route it to the agent that does the work, or cancel it with task_cancel/);
    if (finish) assert.match(error, /task_finish it \(it waits in review\)/);
    else {
      // Named only as a condition it does not yet meet, never offered as a path now.
      assert.doesNotMatch(error, /task_finish it \(/);
      assert.match(error, /task_finish only once it waits in review/);
    }
    assert.deepEqual(patches, []);
  }
});

test("a fleet settler's refusal does not name a status change on a task no agent filed", async () => {
  const { error, patches } = await handoff({ cur: { id: "cur", identifier: "WOR-2", title: "Owner's own task", status: "in_progress", assigneeAgentId: "other", createdByUserId: "owner" } });
  assert.match(error, /not yours to change: comment on it with task_comment/);
  assert.doesNotMatch(error, /task_finish|task_cancel/);
  assert.deepEqual(patches, []);
});

test("a closed own-part is refused before its comment, so a handoff cannot reopen it", async () => {
  // The own-part branch moves the part to `todo`: on a part the owner already closed that would reopen their work.
  for (const status of ["done", "cancelled"]) {
    const before = waits.length;
    const { error, patches } = await handoff({ cur: { ...ownPart, status }, par: { ...par } });
    assert.match(error, new RegExp(`is ${status}, and a handoff moves your part to todo, which would reopen it`));
    assert.doesNotMatch(error, /task_finish|task_cancel it/);
    assert.deepEqual(patches, []);
    assert.equal(waits.length, before);
  }
});

test("a part the owner closes while the handoff's report posts is not reopened", async () => {
  // The board has no conditional update, so the guard is a re-read right before the status write: the owner closing the
  // part while `postLeadingParts` runs must leave it closed, with its report posted and no owner wait recorded.
  const before = waits.length;
  const issues = { cur: { ...ownPart }, par: { ...par } };
  const patches = [];
  const comments = [];
  let closed = false;
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Fleet Steward" });
      if (url.startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (m && m[2] && req.method === "POST") {
        // The owner closes the part at the moment the report's first part is posted.
        comments.push(JSON.parse(body).body);
        if (!closed) {
          closed = true;
          issues[m[1]].status = "done";
        }
        return send({ id: `c${comments.length}` });
      }
      if (m && m[2]) return send([]);
      if (m && req.method === "PATCH") {
        // Record the write rather than throwing in the request handler: a throw there kills the test process, so the
        // assertion below could never report which write slipped through.
        patches.push({ issue: m[1], ...JSON.parse(body) });
        return send(Object.assign(issues[m[1]], JSON.parse(body)));
      }
      if (m) return send(issues[m[1]] ?? {});
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const r = await bridge({ handler, agents: { me: { key: "fleet-steward", roles: ["fleet-settle"] } }, task: "cur", acceptWaits: true }).call("task_handoff", { issue: "cur", comment: `Over to you.\n\n${'a long report line\n\n'.repeat(1200)}Final line.` });
  const error = r.result?.isError ? r.result.content[0].text : undefined;
  assert.match(error, /was done by the time the handoff was applied/);
  assert.deepEqual(patches, []);
  // The whole report is on the task, including the segment the status write normally carries.
  assert.match(comments.at(-1) ?? "", /Final line\./);
  assert.equal(issues.cur.status, "done");
  assert.equal(waits.length, before);
});

test("a fleet settler cannot hand off a part that is not this run's task", async () => {
  const before = waits.length;
  const { error, patches } = await handoff({ other: { ...ownPart, id: "other", identifier: "WOR-3", title: "Another part" }, par: { ...par } }, ["fleet-settle"], "cur", "other");
  assert.match(error, /another task/);
  assert.deepEqual(patches, []);
  assert.equal(waits.length, before);
});

test("an ordinary agent can still hand off its own part of another task, as before", async () => {
  // The run-task guard is a settler's: it exists because the wait is recorded on the run's task. An agent without
  // fleet-settle keeps the behaviour it always had, parking its own part of any owner task as todo.
  const { error, patches } = await handoff({ other: { ...ownPart, id: "other", identifier: "WOR-3", title: "Another part" }, par: { ...par } }, [], "cur", "other");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "other", status: "todo", comment: "Over to you." }]);
});

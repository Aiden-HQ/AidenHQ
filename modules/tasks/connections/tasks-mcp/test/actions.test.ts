// Agents act and never type a status: block on named tasks, cancel, delegate-and-wait, reopen with a comment, in the tasks
// module against a fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse } from "./helpers.ts";

function world({ trial = false, me: meExtra = {} } = {}) {
  const writes = [];
  const tasks = {
    cur: { id: "cur", identifier: "WOR-1", title: "Current", status: "in_progress", assigneeAgentId: "me", createdByAgentId: "boss" },
    w2: { id: "w2", identifier: "WOR-2", title: "Other", status: "in_progress", assigneeAgentId: "eng" },
    w3: { id: "w3", identifier: "WOR-3", title: "Closed", status: "done", assigneeAgentId: "eng" },
    kid: { id: "kid", identifier: "WOR-4", title: "My child", status: "in_progress", assigneeAgentId: "eng", parentId: "cur", createdByAgentId: "me" },
    old: { id: "old", identifier: "WOR-5", title: "My done child", status: "done", assigneeAgentId: "eng", parentId: "cur", createdByAgentId: "me" },
    sibling: { id: "sibling", identifier: "WOR-7", title: "Child of mine by parent only", status: "in_progress", assigneeAgentId: "eng", parentId: "cur", createdByAgentId: "boss" },
    alien: { id: "alien", identifier: "WOR-6", title: "Not mine", status: "in_progress", assigneeAgentId: "eng", createdByAgentId: "boss" },
  };
  const byRef = (r) => Object.values(tasks).find((t) => t.id === r || t.identifier === r);
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Aiden" });
      if (url.endsWith("/agents")) return send([{ id: "eng", name: "Kai", metadata: { setupKey: "aidenhq:engineer-openrouter" }, status: "idle", reportsTo: "me" }]);
      if (req.method === "POST" && url.endsWith("/issues")) {
        writes.push(["POST issue", JSON.parse(body)]);
        return send((tasks.fresh = { id: "fresh", identifier: "WOR-9", title: "t", status: JSON.parse(body).status, createdByAgentId: "me" }));
      }
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?$/.exec(url);
      if (m && m[2] && req.method === "POST") return (writes.push(["POST comment", m[1], JSON.parse(body)]), send({ id: "c1" }));
      if (m && m[2]) return send([]);
      if (m && req.method === "PATCH") {
        const t = byRef(m[1]);
        writes.push(["PATCH", t.id, JSON.parse(body)]);
        return send(Object.assign(t, JSON.parse(body)));
      }
      if (m) return byRef(m[1]) ? send(byRef(m[1])) : send({ error: "not found" }, 404);
      send([]);
    });
  };
  const { call } = bridge({ handler, agents: { me: { key: "cos", ...meExtra, ...(trial ? { trial: true } : {}) }, eng: { key: "engineer-openrouter" } }, agent: "me", task: "cur" });
  return { call, writes };
}

test("task_block blocks the current task on named tasks", async () => {
  const { call, writes } = world();
  parse(await call("task_block", { blocked_by: ["WOR-2", "w2", "WOR-4"], comment: "Waiting on both." }));
  assert.deepEqual(writes, [["PATCH", "cur", { status: "blocked", blockedByIssueIds: ["w2", "kid"], comment: "Waiting on both." }]]);
  assert.match(parse(await call("task_block", { blocked_by: ["WOR-3"] })).error, /it is done/);
  assert.match(parse(await call("task_block", { blocked_by: ["WOR-1"] })).error, /cannot block itself/);
  assert.equal(writes.length, 1);
});

test("task_cancel cancels a child the caller delegated, refuses another's task", async () => {
  const { call, writes } = world();
  parse(await call("task_cancel", { issue: "WOR-4", comment: "No longer needed." }));
  assert.deepEqual(writes, [["PATCH", "kid", { status: "cancelled", comment: "No longer needed." }]]);
  assert.match(parse(await call("task_cancel", { issue: "WOR-6", comment: "x" })).error, /neither assigned to you nor/);
  parse(await call("task_cancel", { comment: "Obsolete." }));
  assert.deepEqual(writes.at(-1), ["PATCH", "cur", { status: "cancelled", comment: "Obsolete." }]);
  assert.equal(writes.length, 2);
});

test("task_finish with issue closes a task the caller holds, refuses another's", async () => {
  const { call, writes } = world();
  parse(await call("task_finish", { issue: "WOR-4", comment: "Accepted." }));
  assert.deepEqual(writes, [["PATCH", "kid", { status: "done", comment: "Accepted." }]]);
  assert.match(parse(await call("task_finish", { issue: "WOR-6", comment: "x" })).error, /neither assigned to you nor/);
  // A child of the current task that someone else created and holds is not the caller's to close or cancel.
  assert.match(parse(await call("task_finish", { issue: "WOR-7", comment: "x" })).error, /neither assigned to you nor/);
  assert.match(parse(await call("task_cancel", { issue: "WOR-7", comment: "x" })).error, /neither assigned to you nor/);
  assert.equal(writes.length, 1);
});

test("a trial agent finishes only its own task", async () => {
  const { call, writes } = world({ trial: true });
  assert.match(parse(await call("task_finish", { issue: "WOR-4", comment: "x" })).error, /in trial/);
  assert.equal(writes.length, 0);
  parse(await call("task_finish", { comment: "Done." }));
  assert.deepEqual(writes, [["PATCH", "cur", { status: "done", comment: "Done." }]]);
});

test("task_delegate wait blocks the parent on the child", async () => {
  const { call, writes } = world();
  const brief = { agent: "Kai", title: "Ship it", description: "Build the thing.", deliverable: { kind: "none" } };
  const r = parse(await call("task_delegate", { ...brief, wait: true }));
  assert.equal(r.out.waiting, true);
  assert.deepEqual(writes.at(-1), ["PATCH", "cur", { status: "blocked", blockedByIssueIds: ["fresh"] }]);
  writes.length = 0;
  parse(await call("task_delegate", { ...brief, title: "Another", description: "Different words entirely: tidy the garden." }));
  assert.ok(!writes.some(([k]) => k === "PATCH"), "no wait unless asked");
});


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

test("task_finish takes `issue` only from an agent that reads private data or is no Engineer", async () => {
  const pub = world({ me: { profile: "engineer" } });
  assert.match(parse(await pub.call("task_finish", { issue: "WOR-4", comment: "ok" })).error, /without private reads/);
  assert.equal(pub.writes.length, 0);
  parse(await pub.call("task_finish", { comment: "ok" }));
  assert.equal(pub.writes.at(-1)[1], "cur");
  const priv = world({ me: { profile: "engineer", private_reads: true } });
  parse(await priv.call("task_finish", { issue: "WOR-4", comment: "ok" }));
  assert.equal(priv.writes.at(-1)[1], "kid");
});

test("task_approvals reads the run's own cards for an Engineer without private data, and any task for one with it", async () => {
  const asked = [];
  const approvalBoard = (req, res) => {
    req.resume();
    req.on("end", () => {
      asked.push(new URL(req.url ?? "/", "http://x").searchParams.get("issue"));
      res.setHeader("content-type", "application/json").end(JSON.stringify({ approvals: [
        { id: "k-1", action: "merge", state: "running", live: true, target: "https://github.com/a/b/pull/1", prs: [{ repo: "a/b", number: 1, head: "a".repeat(40) }], outcome: null, wakes: true, createdAt: "2026-11-23T00:00:00Z" },
        { id: "k-3", action: "apply", state: "used", target: "instance", outcome: "applied", wakes: true, outcomeText: `{"record":"${"z".repeat(600)}"}`, createdAt: "2026-11-21T00:00:00Z" },
        { id: "k-2", action: "merge", state: "used", target: "https://github.com/a/b/pull/1", outcome: "applied", wakes: false, outcomeText: `merged-prs: [{"repo":"a/b","number":1,"head":"${"a".repeat(40)}","sha":"${"b".repeat(40)}"}]\n\nMerged https://github.com/a/b/pull/1.\n${"x".repeat(500)}`, createdAt: "2026-11-22T00:00:00Z" },
      ] }));
    });
  };
  const world = async (me) => {
    const handler = (req, res) => {
      req.resume();
      req.on("end", () => {
        const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
        if ((req.url ?? "") === "/api/agents/me") return send({ id: "me", name: "Kai" });
        if ((req.url ?? "").startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
        send({});
      });
    };
    return bridge({ handler, board: approvalBoard, agents: { me: { key: "engineer", ...me } }, task: "cur" });
  };
  asked.length = 0;
  const pub = await world({ profile: "engineer" });
  assert.match(parse(await pub.call("task_approvals", { issue: "WOR-4" })).error, /without private reads/);
  assert.deepEqual(asked, [], "refused before the board is asked");
  const own = parse(await pub.call("task_approvals", {})).out;
  assert.deepEqual(asked, ["cur"], "no issue: the run's own task");
  // Whether a card wakes the task, and the whole `merged-prs` line the rule's evidence is.
  const byId = (id: string) => own.approvals.find((a: { id: string }) => a.id === id);
  assert.deepEqual(own.approvals.map((a: { id: string; wakes: boolean }) => [a.id, a.wakes]), [["k-1", true], ["k-3", true], ["k-2", false]]);
  assert.deepEqual(byId("k-1").prs, [{ repo: "a/b", number: 1, head: "a".repeat(40) }], "the card says which PR and head it is bound to");
  assert.equal(byId("k-1").live, true, "a live card says so, whatever its state word");
  assert.equal(byId("k-3").live, undefined, "an ended card carries no live flag");
  assert.equal(byId("k-3").outcomeText.length, 300, "an outcome without merge evidence keeps its cap");
  const merged = byId("k-2").outcomeText;
  assert.ok(merged.startsWith("merged-prs: ") && merged.includes("a".repeat(40)) && merged.includes("b".repeat(40)), "the merge evidence line is never cut");
  assert.ok(merged.length < 500, "the rest of a long outcome is capped");
  asked.length = 0;
  const priv = await world({ profile: "engineer", private_reads: true });
  parse(await priv.call("task_approvals", { issue: "WOR-4" }));
  assert.deepEqual(asked, ["WOR-4"], "private reads: any task it names");
});

test("task_approvals with no directory entry for the caller reads only the run's own task", async () => {
  const asked = [];
  const approvalBoard = (req, res) => {
    req.resume();
    req.on("end", () => {
      asked.push(new URL(req.url ?? "/", "http://x").searchParams.get("issue"));
      res.setHeader("content-type", "application/json").end(JSON.stringify({ approvals: [] }));
    });
  };
  const handler = (req, res) => {
    req.resume();
    req.on("end", () => {
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if ((req.url ?? "") === "/api/agents/me") return send({ id: "me", name: "Kai" });
      if ((req.url ?? "").startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
      send({});
    });
  };
  // The caller's grant is missing from the directory (a fresh table, a stale cache): its scope can't be established.
  const unknown = bridge({ handler, board: approvalBoard, agents: {}, task: "cur" });
  assert.match(parse(await unknown.call("task_approvals", { issue: "WOR-4" })).error, /no entry for this caller/);
  assert.deepEqual(asked, [], "refused before the board is asked");
  parse(await unknown.call("task_approvals", {}));
  assert.deepEqual(asked, ["cur"], "no issue: still the run's own task");
});

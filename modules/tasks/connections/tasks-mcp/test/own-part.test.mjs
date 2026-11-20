// An agent-filed task under the owner's task is the agent's to finish: done closes it, and a handoff
// goes back to the owner. Only a part the owner gave the agent stays open for the owner's replies.
// The tasks module against a fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

async function call(tool, args, createdByAgentId, status = "in_progress") {
  const patches = [];
  const issues = {
    cur: { id: "cur", identifier: "WOR-2", title: "Follow up the review", status, parentId: "par", assigneeAgentId: "me", createdByAgentId },
    par: { id: "par", identifier: "WOR-1", title: "Ship the schema", status: "todo", assigneeUserId: "owner", assigneeAgentId: null },
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
  const r = await bridge({ handler, agents: { me: { key: "roadmap-keeper", roles: [] } }, task: "cur" }).call(tool, args);
  return { error: r.result?.isError ? r.result.content[0].text : undefined, patches };
}

test("task_finish closes a task this agent filed under the owner's task", async () => {
  const { error, patches } = await call("task_finish", { comment: "Done: answers transcribed." }, "me");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done", comment: "Done: answers transcribed." }]);
});

test("task_set_status done closes a task this agent filed under the owner's task", async () => {
  const { error, patches } = await call("task_set_status", { issue: "cur", status: "done" }, "me");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done" }]);
});

test("a handoff of an agent-filed task gives it back to the owner instead of parking it on the agent", async () => {
  const { error, patches } = await call("task_handoff", { issue: "cur", comment: "Waiting on your call." }, "me");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", assigneeUserId: "owner", assigneeAgentId: null, status: "todo", comment: "Waiting on your call." }]);
});

test("a task this agent filed and then handed off can still be finished with done", async () => {
  const { error, patches } = await call("task_set_status", { issue: "cur", status: "done" }, "me", "todo");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done" }]);
});

test("a task another agent filed, now assigned to this agent, is this agent's to finish", async () => {
  const { error, patches } = await call("task_set_status", { issue: "cur", status: "done" }, "someone-else", "todo");
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "cur", status: "done" }]);
});

test("a part the owner gave the agent still stays open for the owner's replies", async () => {
  const { error, patches } = await call("task_finish", { comment: "Done." }, null);
  assert.match(error, /your part of the user's task/);
  assert.deepEqual(patches, []);
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
  assert.match(r.result.content[0].text, /wait_error.*call task_wait/);
  assert.equal(patches.length, 1);
});

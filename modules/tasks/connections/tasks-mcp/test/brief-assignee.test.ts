// WOR-9033 (Aiden-HQ/AidenHQ#1004): a task an agent sees names the agent that holds it — its key, with its display name when
// Paperclip lists it — never the literal "agent", which no caller can resolve back to the key that must be woken. The owner's
// own task stays "user" and an unassigned one stays null.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse } from "./helpers.ts";

const engineer = { id: "eng-1", name: "Kai", metadata: { setupKey: "aidenhq:engineer-openrouter", runnerEngine: true }, status: "idle" };
const devops = { id: "ops-1", name: "Ada", metadata: { setupKey: "aidenhq:devops" }, status: "idle" };
const AGENTS = [engineer, devops];
const issues = {
  cos: { id: "cos", identifier: "WOR-1", title: "the chief's task", status: "in_progress", assigneeAgentId: "co-1" },
  eng: { id: "eng", identifier: "WOR-2", title: "the engineer's task", status: "todo", assigneeAgentId: "eng-1" },
  ops: { id: "ops", identifier: "WOR-3", title: "the devops task", status: "todo", assigneeAgentId: "ops-1", activeRecoveryAction: { id: "ra", cause: "stranded_assigned_issue" } },
  owner: { id: "owner", identifier: "WOR-4", title: "the owner's task", status: "todo", assigneeUserId: "owner" },
  none: { id: "none", identifier: "WOR-5", title: "nobody's yet", status: "backlog" },
};
const handler = (req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = req.url ?? "";
    const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
    if (url === "/api/agents/me") return send({ id: "co-1", companyId: "c", name: "Aiden" });
    if (url.endsWith("/agents")) return send(AGENTS);
    if (url.endsWith("/labels")) return send([]);
    if (url === "/api/companies/c") return send({ defaultResponsibleUserId: "owner" });
    if (req.method === "GET" && url.startsWith("/api/companies/") && url.includes("/issues?")) return send(Object.values(issues));
    const byIdent = (ref) => Object.values(issues).find((i) => i.id === ref || i.identifier === ref);
    const m = /^\/api\/issues\/([^/?]+)$/.exec(url);
    if (m && req.method === "GET") { const i = byIdent(m[1]); return i ? send(i) : send({}, 404); }
    // task_create: what was asked for comes back as Paperclip's create answer.
    if (req.method === "POST" && /\/companies\/[^/]+\/issues$/.test(url)) return send({ ...JSON.parse(body), id: "new", identifier: "WOR-9", status: "todo", createdAt: "", updatedAt: "" }, 201);
    send({}, 404);
  });
};
const agents = { "co-1": { key: "chief-of-staff", roles: [] }, "eng-1": { key: "engineer-openrouter" }, "ops-1": { key: "devops" } };
const call = (name, args) => bridge({ handler, agents, agent: "co-1", task: "cos" }).call(name, args).then(parse);

test("task_get names the holder's key and display name, never \"agent\"", async () => {
  const eng = await call("task_get", { issue: "WOR-2" });
  assert.deepEqual([eng.out.assignee, eng.out.assignee_name], ["engineer-openrouter", "Kai"]);
  const ops = await call("task_get", { issue: "WOR-3" });
  assert.deepEqual([ops.out.assignee, ops.out.assignee_name], ["devops", "Ada"]);
  // The reporter's step 1: a task created for a named agent reads back with that key.
  assert.ok(!JSON.stringify([eng.out, ops.out]).includes('"assignee":"agent"'));
});

test("task_get keeps the owner and unassigned semantics", async () => {
  const owner = await call("task_get", { issue: "WOR-4" });
  assert.deepEqual([owner.out.assignee, owner.out.assignee_name], ["user", undefined]);
  const none = await call("task_get", { issue: "WOR-5" });
  assert.deepEqual([none.out.assignee, none.out.assignee_name], [null, undefined]);
});

test("task_list names each task's holder key", async () => {
  const r = await call("task_list", {});
  const byIdent = Object.fromEntries(r.out.tasks.map((t) => [t.identifier, t]));
  assert.deepEqual([byIdent["WOR-2"].assignee, byIdent["WOR-2"].assignee_name], ["engineer-openrouter", "Kai"]);
  assert.equal(byIdent["WOR-4"].assignee, "user");
  assert.equal(byIdent["WOR-5"].assignee, null);
});

test("task_create returns the created task's assignee key", async () => {
  const r = await call("task_create", { title: "Fix the sweep", description: "Do it on acme/app.", marker: "test:assignee", assignee: "devops" });
  assert.equal(r.out.assignee, "devops");
  assert.equal(r.out.assignee_name, "Ada");
});

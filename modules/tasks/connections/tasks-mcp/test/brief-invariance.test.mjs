// A brief that claims part of the tree is untouched while its own tests or requirements change that part reads as a
// contradiction: the reviewer takes the claim literally and rejects the extra change as out of scope. The task tools flag it
// where it is filed, while the delegator can still reword it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

const engineer = { id: "eng", name: "Engineer", metadata: { setupKey: "aidenhq:engineer-openrouter", persona: { name: "Linus" } }, status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: false, enabled: false } } };
const handler = (req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = req.url ?? "";
    const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
    if (url === "/api/agents/me") return send({ id: "cos", name: "Aiden" });
    if (url.endsWith("/agents")) return send([engineer, { id: "lib", name: "Librarian", metadata: { setupKey: "aidenhq:librarian" }, status: "idle" }]);
    if (url.endsWith("/labels")) return send([]);
    if (req.method === "POST" && url.endsWith("/issues")) return send({ id: "new", identifier: "WOR-9", title: "t", status: "todo" });
    if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-5", title: "t", status: "in_progress", assigneeAgentId: "cos", parentId: null });
    send([]);
  });
};
const agents = { cos: { key: "chief-of-staff", roles: [] }, eng: { key: "engineer-openrouter", roles: [], graded: true }, lib: { key: "librarian", roles: [] } };
const call = (name, args) => bridge({ handler, agents, agent: "cos", task: "cur" }).call(name, args);
const delegate = (description) => call("task_delegate", { agent: "Linus", title: "Narrow the token", description, deliverable: { kind: "pr", ref: "acme/app" } });
const WARN = /name every change in the change section, and leave out claims that another part of the tree is untouched/;

const settle = "Narrow the role-lookup token to metadata: read.";

test("a brief that claims nothing else changes while its Tests ask for a change is flagged, and still filed", async () => {
  for (const claim of [
    "Everything on the branch is settled and reviewed except one thing. Keep the tree exactly as it is.",
    "The only change is the token scope.",
    "Nothing else changes.",
    "The work is limited to the token scope.",
  ]) {
    const r = await delegate(`${settle}\n\n${claim}\n\n## Tests\n\nThe issue comment removes the planted hostname and email before it is sent.\n`);
    assert.equal(r.result?.isError, undefined, claim);
    assert.match(r.result.content[0].text, WARN, claim);
  }
});

test("a brief that names each change, claims nothing, or only tests the one change, is not flagged", async () => {
  const named = await delegate(`${settle} Remove the planted hostname and email from the issue comment before it is sent.\n\n## Tests\n\nThe issue comment removes the planted hostname and email.\n`);
  assert.doesNotMatch(named.result.content[0].text, WARN);
  const noTests = await delegate(`${settle}\n\nKeep the tree exactly as it is: nothing else changes.\n`);
  assert.doesNotMatch(noTests.result.content[0].text, WARN);
  const oneChange = await delegate(`${settle} The token is narrowed on the branch.\n\nThis is the only change.\n\n## Tests\n\nThe role-lookup token reads metadata only.\n`);
  assert.doesNotMatch(oneChange.result.content[0].text, WARN);
});

test("task_create flags an Engineer brief the same way; a task for another agent is not", async () => {
  const brief = `${settle}\n\nKeep the rest exactly as it is.\n\n## Requirements\n\nThe comment drops the planted hostname.\n`;
  const created = await call("task_create", { title: "t", marker: "test:brief", assignee: "engineer-openrouter", description: brief, deliverable: { kind: "pr", ref: "acme/app" } });
  assert.match(created.result.content[0].text, WARN);
  const other = await call("task_create", { title: "t", marker: "test:other", assignee: "librarian", description: brief, deliverable: { kind: "report" } });
  assert.doesNotMatch(other.result.content[0].text, WARN);
});

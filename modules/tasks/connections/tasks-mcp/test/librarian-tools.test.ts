// The librarian's task tools against a fake Paperclip: handbooks read through the instructions bundle, a rule proposal
// can only be assigned to the Platform Engineer, and both need the librarian role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.ts";

const AGENTS = [
  { id: "me", name: "Librarian", metadata: { setupKey: "aidenhq:librarian" } },
  { id: "arch", name: "Platform Engineer", metadata: { setupKey: "aidenhq:fleet-engineer" } },
  { id: "cos", name: "Chief of Staff", metadata: { setupKey: "aidenhq:chief-of-staff" } },
];

async function call(roles, tool, args, repos) {
  const created = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send(AGENTS[0]);
      if (/\/agents$/.test(url)) return send(AGENTS);
      if (url.includes("/instructions-bundle/file")) return send({ content: `handbook of ${url.split("/")[3]}` });
      if (req.method === "POST" && url.endsWith("/issues")) return (created.push(JSON.parse(body)), send({ identifier: "WOR-9" }));
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-1", assigneeAgentId: "me" });
      if (url.includes("/issues")) return send([]);
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const agents = { me: { key: "librarian", roles }, arch: { key: "fleet-engineer", roles: ["platform-engineer"] } };
  const r = await bridge({ handler, agents, task: "cur", repos }).call(tool, args);
  const text = r.result.content[0].text;
  return { error: r.result.isError ? text : undefined, text, created };
}
test("the librarian reads a handbook and files a rule proposal for the Platform Engineer, nobody else", async () => {
  const h = await call(["librarian"], "handbook_read", { agent_key: "chief-of-staff" });
  assert.match(h.text, /handbook of cos/);
  const p = await call(["librarian"], "task_propose_rule", { title: "Fix rule", description: "current / replacement", marker: "rule:x" });
  assert.equal(p.created[0].assigneeAgentId, "arch");
  assert.equal(p.created[0].parentId, "cur");
});
test("without the librarian role both are refused", async () => {
  assert.match((await call([], "handbook_read", { agent_key: "chief-of-staff" })).error, /librarian role/);
  const p = await call([], "task_propose_rule", { title: "t", description: "d" });
  assert.match(p.error, /librarian role/);
  assert.deepEqual(p.created, []);
});

// task_route (role fleet-settle): a stuck open task goes back to todo with the settler's comment, held by the agent named or
// its own; a closed task stays closed, and an agent without the role is refused. The tasks module against a fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.ts";

async function route(args, { status = "todo", roles = ["fleet-settle"] } = {}) {
  const patches = [];
  const issues = { "WOR-5": { id: "t", identifier: "WOR-5", status, assigneeAgentId: null, assigneeUserId: "owner", createdByAgentId: "rm" } };
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Fleet Steward" });
      if (/^\/api\/companies\/[^/]+\/agents/.test(url)) return send([{ id: "rm", name: "Reviewer Manager", status: "idle", metadata: { setupKey: "aidenhq:reviewer-manager" } }]);
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (m && m[2]) return send({ id: "c1" });
      if (m && req.method === "PATCH") { const p = JSON.parse(body); patches.push({ issue: m[1], ...p }); return send(Object.assign(issues[m[1]], p)); }
      if (m) return send(issues[m[1]] ?? {});
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const r = await bridge({ handler, agents: { me: { key: "fleet-steward", roles } }, task: "cur" }).call("task_route", args);
  return { error: r.result?.isError ? r.result.content[0].text : undefined, patches };
}

test("a handback goes back to work with the agent that does it", async () => {
  const { error, patches } = await route({ issue: "WOR-5", to: "reviewer-manager", comment: "Run the audit yourself." });
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ issue: "WOR-5", status: "todo", assigneeAgentId: "rm", assigneeUserId: null, comment: "Run the audit yourself." }]);
});

test("a closed task stays closed, and an agent without the role is refused", async () => {
  for (const status of ["done", "cancelled"]) {
    const { error, patches } = await route({ issue: "WOR-5", to: "reviewer-manager", comment: "Again." }, { status });
    assert.match(error, new RegExp(`is ${status}: task_route moves open work only`));
    assert.deepEqual(patches, []);
  }
  const { error, patches } = await route({ issue: "WOR-5", to: "reviewer-manager", comment: "Mine now." }, { roles: [] });
  assert.match(error, /fleet-settle/);
  assert.deepEqual(patches, []);
});

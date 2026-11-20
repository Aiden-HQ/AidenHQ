// A task delegated from a long-lived parent chat can carry that chat as its first-class blocker. The chat never
// closes, so every status write was refused and the task could not be moved, woken or cancelled again. The tools
// treat the task's own parent as not a blocking dependency: they release it, name it, and retry the write; any
// other live blocker still refuses. The tasks module against a fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

async function call({ blockers, args = { comment: "Done." }, tool = "task_finish" }) {
  const issues = new Map(blockers.map((b) => [b.id, b]));
  const issue = { id: "cur", identifier: "WOR-7132", title: "Fix the fleet", status: "blocked", assigneeAgentId: "me", createdByAgentId: "delegator", parentId: "chat" };
  const chat = { id: "chat", identifier: "WOR-4976", title: "Operator chat", status: "in_progress", assigneeAgentId: "me" };
  const patches = [];
  const comments = [];
  const blockedBy = () => blockers.map((b) => b.id === "chat" ? parent : b);
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (status, x) => (res.statusCode = status, res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send(200, { id: "me", name: "Aiden" });
      if (url.startsWith("/api/companies/")) return send(200, { defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (!m) return send(404, {});
      if (m[1] === "chat") return m[2] && req.method === "GET" ? send(200, []) : send(200, chat);
      if (m[1] !== "cur") return send(404, {});
      if (m[2] && req.method === "GET") return send(200, comments.map((c) => ({ body: c })));
      if (m[2] && req.method === "POST") return (comments.push(JSON.parse(body).body), send(200, { id: "c1" }));
      if (req.method === "PATCH") {
        const patch = JSON.parse(body);
        patches.push(patch);
        if (Array.isArray(patch.blockedByIssueIds)) {
          blockers = blockers.filter((b) => patch.blockedByIssueIds.includes(b.id));
          return send(200, { ...issue, blockedBy: blockedBy() });
        }
        if (patch.status && patch.status !== issue.status) {
          const unresolved = blockedBy().filter((b) => b.status !== "done");
          if (unresolved.length) return send(409, { error: "Issue follow-up blocked by unresolved blockers", details: { issueId: "cur", unresolvedBlockerIssueIds: unresolved.map((b) => b.id) } });
        }
        if (patch.status) issue.status = patch.status;
        if (patch.comment) comments.push(patch.comment);
        return send(200, { ...issue, blockedBy: blockedBy() });
      }
      return send(200, { ...issue, blockedBy: blockedBy() });
    });
  };
  const r = await bridge({ handler, agents: { me: { key: "aiden", roles: [] } }, task: "cur" }).call(tool, args);
  return { error: r.result?.isError ? r.result.content[0].text : undefined, patches, comments };
}

const parent = { id: "chat", identifier: "WOR-4976", title: "Operator chat", status: "in_progress" };
const live = { id: "b2", identifier: "WOR-2430", title: "Open review", status: "in_progress" };

test("a task whose only blocker is its own parent finishes and cancels", async () => {
  for (const [tool, status] of [["task_finish", "done"], ["task_cancel", "cancelled"]]) {
    const { error, patches, comments } = await call({ blockers: [parent], tool, args: { comment: "Done." } });
    assert.equal(error, undefined);
    assert.deepEqual(patches, [{ status, comment: "Done." }, { blockedByIssueIds: [] }, { status, comment: "Done." }]);
    assert.match(comments.join("\n"), /WOR-4976 \(parent\)/);
  }
});

test("a live blocker that is not the task's parent still refuses and the relation is kept", async () => {
  const { error, patches } = await call({ blockers: [live] });
  assert.match(error, /409/);
  assert.deepEqual(patches, [{ status: "done", comment: "Done." }]);
});

test("its own parent beside a live blocker still refuses", async () => {
  const { error, patches } = await call({ blockers: [parent, live] });
  assert.match(error, /409/);
  assert.deepEqual(patches, [{ status: "done", comment: "Done." }]);
});

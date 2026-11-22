// The finish route over HTTP: which agent's close moves a graded task. The grade store itself is covered by grades.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGrading } from "../service/src/server.ts";

const KEYS = { check: "c".repeat(32), board: "b".repeat(32) };
const RUBRIC = ["merged into main", "checks green on the head", "the app serves the page"];

/** The module's own server, its kernel a map of tasks. A task is `{id, identifier, status, assigneeAgentId, createdByAgentId}`. */
async function harness(tasks, t) {
  const byRef = (ref) => Object.values(tasks).find((i) => i.id === ref || i.identifier === ref);
  const kernel = {
    issue: async (ref) => {
      const i = byRef(ref);
      if (!i) throw new Error(`no task ${ref}`);
      return i;
    },
    repos: async () => ({ agentsOrgs: ["acme"], product: "own/aidenhq" }),
  };
  const { server, grades, runner } = createGrading({ db: new DatabaseSync(":memory:"), kernel, keys: KEYS });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, key, body) => {
    const r = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  return {
    grades,
    // The kernel asking the finish check, as it does on every move to done (its body carries the task it read).
    finish: async (ref, body) => (await post("/check/finish", KEYS.check, { task: byRef(ref), ...body })).json,
    verdict: async (ref, body) => runner("POST", `/internal/grades/${encodeURIComponent(byRef(ref).identifier)}/verdict`, body),
  };
}

test("a graded task is its assignee's: the delegator's close is refused, the assignee's is held", async (t) => {
  const task = { id: "t6", identifier: "WOR-6", status: "in_review", assigneeAgentId: "eng", createdByAgentId: "cos", parentId: null };
  const h = await harness({ "WOR-6": task }, t);
  h.grades.file("t6", RUBRIC, { kind: "pr", ref: "" });
  assert.equal(h.grades.get("t6").state, "open");

  assert.deepEqual(await h.finish("WOR-6", { agent: "cos", via: "task_finish" }), {
    verdict: "deny", status: 403, reason: "this task is graded: the grader closes it once its rubric is met (only its assignee finishes it)",
  });
  assert.equal(h.grades.get("t6").state, "open");

  const held = await h.finish("WOR-6", { agent: "eng", via: "task_finish" });
  assert.deepEqual([held.verdict, held.state], ["pending", "pending"]);
  assert.equal(h.grades.get("t6").state, "pending");
  assert.deepEqual(h.grades.due(Date.now()).map((g) => g.issueId), ["t6"]);
});

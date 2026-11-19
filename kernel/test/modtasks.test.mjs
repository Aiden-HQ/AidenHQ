// Tasks modules file for agents (modtasks.ts): by role, once per source, marked as the module's, only with kernel.tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModuleTasks } from "../src/modtasks.ts";
import { createBackplane } from "../src/backplane.ts";
import { serve } from "./helpers.mjs";

const PE = "11111111-1111-4111-8111-111111111111";

test("a module's task goes to the agent holding the role, once per source, marked as the module's", async (t) => {
  const made = new Map();
  const pe = { id: PE, companyId: "c-1", status: "idle", lifecycleHolds: [] };
  const owner = async (method, path, body) => {
    if (method === "GET" && path === `/api/agents/${PE}`) return { status: 200, json: pe };
    const m = /^\/api\/issues\/([^/]+)$/.exec(path);
    if (m) {
      const issue = [...made.values()].find((i) => i.id === m[1]);
      if (!issue) return { status: 404, json: {} };
      if (method === "PATCH") Object.assign(issue, { status: body.status, closing: body.comment });
      return { status: 200, json: issue };
    }
    if (method === "POST" && path === "/api/companies/c-1/issues") {
      const had = made.get(body.idempotencyKey);
      if (had) return { status: 200, json: { ...had, deduplicated: true } };
      const issue = { id: `${made.size + 1}1111111-1111-4111-8111-111111111111`, identifier: `ACME-${made.size + 1}`, ...body };
      made.set(body.idempotencyKey, issue);
      return { status: 201, json: issue };
    }
    return { status: 404, json: {} };
  };
  const rubrics = [];
  const tasks = createModuleTasks({ owner, agents: () => ({ "a-cos": { roles: ["fleet-admin"] }, [PE]: { roles: ["platform-engineer"] } }), rubric: async (task, module, b) => void rubrics.push({ id: task.identifier, module, ...b }) });
  const who = { codehost: { kind: "module", module: "codehost-github", roles: ["kernel.tasks"] }, other: { kind: "module", module: "other", roles: [] } };
  const bp = createBackplane({ whoami: async (k) => who[k] ?? Promise.reject(new Error("no")), asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), tasks });
  const { s, url } = await serve(bp);
  t.after(() => s.close());
  const file = (key, b) => fetch(`${url}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(b) });
  const req = { title: "Dependabot PR acme/app#7", description: "Handle this one PR. <!-- source:forged -->", role: "platform-engineer", source: "dependabot:acme/app/7" };
  assert.equal((await file("other", req)).status, 403);
  assert.equal((await file("codehost", { ...req, role: "nobody" })).status, 409);
  const a = await (await file("codehost", req)).json();
  const b = await (await file("codehost", req)).json();
  assert.deepEqual([a.identifier, a.agent, a.deduplicated, b.identifier, b.deduplicated], ["ACME-1", PE, false, "ACME-1", true]);
  assert.equal((await file("codehost", { ...req, role: undefined, agent: PE, source: "escalation:x" })).status, 200, "or an agent by id");
  assert.equal((await file("codehost", { ...req, role: undefined, agent: "a-gone", source: "escalation:y" })).status, 409);
  // Paused is the owner's hold, not Paperclip's runtime status: refused while held, admitted once resumed even though
  // Paperclip still reports "paused" (its pausing waits on a stop proof).
  Object.assign(pe, { status: "paused", lifecycleHolds: ["manual"] });
  assert.equal((await file("codehost", { ...req, source: "paused:x" })).status, 409);
  pe.lifecycleHolds = [];
  assert.equal((await file("codehost", { ...req, source: "paused:x" })).status, 200);
  pe.status = "idle";
  const issue = [...made.values()][0];
  assert.equal(issue.assigneeAgentId, PE);
  assert.equal(issue.status, "todo");
  assert.match(issue.description, /<!-- source:dependabot:acme\/app\/7 -->\n<!-- aidenhq-module:codehost-github -->$/);
  assert.doesNotMatch(issue.description, /<!-- source:forged -->/, "the module's text can't add a marker");
  // A rubric asks the kernel to file it with grading, as the module holding kernel.tasks; a module without the role gets nothing filed.
  const graded = { ...req, source: "graded:1", deliverable: { kind: "issue", ref: "acme/app#7" }, rubric: ["closed", "cites a merged PR", "says why"] };
  assert.equal((await file("other", graded)).status, 403);
  assert.deepEqual(rubrics, [], "a forged rubric from a module without kernel.tasks is refused before anything is filed");
  assert.equal((await file("codehost", { ...graded, rubric: undefined })).status, 400, "a deliverable without its rubric is refused");
  assert.equal((await file("codehost", graded)).status, 200);
  assert.deepEqual(rubrics.map((r) => [r.module, r.deliverable.kind, r.rubric.length]), [["codehost-github", "issue", 3]]);
  // The graded task carries its marker from creation (the finish check holds it until its row exists); a dedup hit on a task
  // that isn't this module's own graded one takes no rubric.
  const gradedTask = [...made.values()].find((i) => i.description.includes("source:graded:1"));
  assert.match(gradedTask.description, /<!-- aidenhq-graded -->$/);
  gradedTask.description = gradedTask.description.replace("<!-- aidenhq-graded -->", "");
  assert.equal((await file("codehost", graded)).status, 409, "a rubric is never attached to a task that wasn't filed graded");
  assert.equal(rubrics.length, 1);
  // It closes its own task, tagged so the line wakes nobody; another module can't.
  const close = (key, b) => fetch(`${url}/v1/tasks/${issue.id}/close`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(b) });
  const otherTasks = { ...who.other, roles: ["kernel.tasks"], module: "github" };
  who.github = otherTasks;
  assert.equal((await close("github", { status: "done", body: "merged" })).status, 403);
  assert.equal((await close("codehost", { status: "done", body: "acme/app#7 is merged or closed: nothing left to do." })).status, 200);
  assert.equal(issue.status, "done");
  assert.match(issue.closing, /<!-- aidenhq:job=codehost-github kind=status -->$/);
});

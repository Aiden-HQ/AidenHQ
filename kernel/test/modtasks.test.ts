// Tasks modules file for agents (modtasks.ts): by role, once per source, marked as the module's, only with kernel.tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createModuleTasks } from "../src/modtasks.ts";
import { createBackplane } from "../src/backplane.ts";
import { serve } from "./helpers.ts";

const PE = "11111111-1111-4111-8111-111111111111";
/** The owner's own control-plane user, which the kernel reads from `/api/cli-auth/me` (never the task's text). */

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
  const db = new DatabaseSync(":memory:");
  const rubrics = [], posted = [];
  // The kernel's post action: what a module's comment on its own card goes through (it skips Paperclip's reopen).
  const plugin = { company: async () => "c-1", post: async (agent, params) => {
    const issue = [...made.values()].find((i) => i.id === params.issueId);
    if (!issue) return { status: 404, data: { refused: "no such task" } };
    posted.push({ agent, ...params });
    (issue.comments ??= []).push(params.body);
    return { status: 200, data: { comment: `comment-${issue.comments.length}` } };
  } };
  const tasks = createModuleTasks({ db, owner, agents: () => ({ "a-cos": { roles: ["fleet-admin"] }, [PE]: { roles: ["platform-engineer"] } }), plugin: () => plugin, rubric: async (task, module, b) => void rubrics.push({ id: task.identifier, module, ...b }) });
  const who = { codehost: { kind: "module", module: "github", roles: ["kernel.tasks"] }, other: { kind: "module", module: "other", roles: [] } };
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
  // Quiet: a holder for records, in the backlog, so its assignment wakes nobody.
  assert.equal((await file("codehost", { ...req, source: "quiet:x", quiet: true })).status, 200);
  assert.equal([...made.values()].at(-1).status, "backlog");
  assert.match(issue.description, /<!-- source:dependabot:acme\/app\/7 -->\n<!-- aidenhq-module:github -->$/);
  assert.doesNotMatch(issue.description, /<!-- source:forged -->/, "the module's text can't add a marker");
  // A rubric asks the kernel to file it with grading, as the module holding kernel.tasks; a module without the role gets nothing filed.
  const graded = { ...req, source: "graded:1", deliverable: { kind: "issue", ref: "acme/app#7" }, rubric: ["closed", "cites a merged PR", "says why"] };
  assert.equal((await file("other", graded)).status, 403);
  assert.deepEqual(rubrics, [], "a forged rubric from a module without kernel.tasks is refused before anything is filed");
  assert.equal((await file("codehost", { ...graded, rubric: undefined })).status, 400, "a deliverable without its rubric is refused");
  assert.equal((await file("codehost", graded)).status, 200);
  assert.deepEqual(rubrics.map((r) => [r.module, r.deliverable.kind, r.rubric.length]), [["github", "issue", 3]]);
  // Graded status is the kernel's own row, not the task's text: a dedup hit on a task this module didn't file graded takes no rubric.
  const gradedTask = [...made.values()].find((i) => i.description.includes("source:graded:1"));
  assert.equal(db.prepare("SELECT module FROM graded_tasks WHERE task = ?").get(gradedTask.id).module, "github");
  db.prepare("DELETE FROM graded_tasks WHERE task = ?").run(gradedTask.id);
  assert.equal((await file("codehost", graded)).status, 409, "a rubric is never attached to a task that wasn't filed graded");
  assert.equal(rubrics.length, 1);
  // It comments on its own open card as the card's agent, tagged so it wakes nobody; another module can't.
  const otherTasks = { ...who.other, roles: ["kernel.tasks"], module: "jira" };
  who.jira = otherTasks;
  const comment = (key, id, body) => fetch(`${url}/v1/tasks/${id}/comment`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ body }) });
  assert.equal((await comment("jira", issue.id, "a newer reason")).status, 403);
  assert.equal((await comment("codehost", issue.id, "  ")).status, 400);
  assert.equal((await comment("codehost", issue.id, "**ACME-1 is still blocked.** A newer reason.")).status, 200);
  assert.equal(issue.comments.length, 1);
  assert.equal(posted[0].agent, PE, "posted as the card's own agent, never the owner");
  assert.equal(posted[0].tag, `<!-- aidenhq:job=${issue.id} kind=comment -->`, "tagged so it wakes nobody");
  assert.equal((await comment("codehost", "99999999-9999-4999-8999-999999999999", "x")).status, 404);
  // It closes its own task, tagged so the line wakes nobody; another module can't.
  const close = (key, b) => fetch(`${url}/v1/tasks/${issue.id}/close`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(b) });
  assert.equal((await close("jira", { status: "done", body: "merged" })).status, 403);
  assert.equal((await close("codehost", { status: "done", body: "acme/app#7 is merged or closed: nothing left to do." })).status, 200);
  assert.equal(issue.status, "done");
  assert.match(issue.closing, /<!-- aidenhq:job=github kind=status -->$/);
  // A card its delegator closed stays closed: no comment is posted on it.
  const closed = await comment("codehost", issue.id, "a later reason");
  assert.deepEqual([closed.status, (await closed.json()).comment], [200, ""], "a closed card takes no comment");
  assert.equal(issue.comments.length, 1);
});

/**
 * A module lists and closes only its own tasks: the release train's source family is listable to the code host, and a task
 * carrying this module's marker and no other module's is its to close. A second module's marker refuses both, even when this
 * module's marker is there too; a task with no module marker at all is refused by the same guard.
 */

test("a module lists the open tasks of its own source family, and no other's", async (t) => {
  const D = "99999999-1111-4111-8111-111111111111";
  const issues = [
    { id: "a1111111-1111-4111-8111-111111111111", identifier: "ACME-1", status: "todo", createdAt: "x", description: "Pass.\n\n<!-- source:design:pass:acme:r1 -->\n<!-- aidenhq-module:design -->" },
    { id: "a2222222-1111-4111-8111-111111111111", identifier: "ACME-2", status: "todo", createdAt: "x", description: "Mentions design:pass:acme:r9 in prose only.\n<!-- source:github:x -->\n<!-- aidenhq-module:design -->" },
    { id: "a3333333-1111-4111-8111-111111111111", identifier: "ACME-3", status: "todo", createdAt: "x", description: "<!-- source:design:pass:acme:r3 -->\n<!-- aidenhq-module:other -->" },
  ];
  const owner = async (method, path) => {
    if (path === "/api/companies") return { status: 200, json: [{ id: "c-1" }] };
    if (path.startsWith("/api/companies/c-1/issues?")) return { status: 200, json: issues };
    return { status: 404, json: {} };
  };
  const tasks = createModuleTasks({ db: new DatabaseSync(":memory:"), owner, agents: () => ({ [D]: { roles: ["ui-login"] } }), plugin: () => ({}) });
  const who = { design: { kind: "module", module: "design", roles: ["kernel.tasks"] } };
  const bp = createBackplane({ whoami: async (k) => who[k] ?? Promise.reject(new Error("no")), asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), tasks });
  const { s, url } = await serve(bp);
  t.after(() => s.close());
  const list = (source) => fetch(`${url}/v1/tasks?source=${encodeURIComponent(source)}`, { headers: { authorization: "Bearer design" } });
  assert.deepEqual((await (await list("design:pass:")).json()).tasks.map((x) => [x.identifier, x.source]), [["ACME-1", "design:pass:acme:r1"]]);
  assert.equal((await list("github:")).status, 400);
  assert.equal((await list("release:instance:")).status, 400);
});

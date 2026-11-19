// Tasks modules file for agents (modtasks.ts): by role, once per source, marked as the module's, only with kernel.tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createModuleTasks } from "../src/modtasks.ts";
import { createBackplane } from "../src/backplane.ts";
import { serve } from "./helpers.mjs";

const PE = "11111111-1111-4111-8111-111111111111";
/** The owner's own control-plane user, which the kernel reads from `/api/cli-auth/me` (never the task's text). */
const OWNER = "u-owner";

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
  const rubrics = [];
  const tasks = createModuleTasks({ db, owner, agents: () => ({ "a-cos": { roles: ["fleet-admin"] }, [PE]: { roles: ["platform-engineer"] } }), rubric: async (task, module, b) => void rubrics.push({ id: task.identifier, module, ...b }) });
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
  // Graded status is the kernel's own row, not the task's text: a dedup hit on a task this module didn't file graded takes no rubric.
  const gradedTask = [...made.values()].find((i) => i.description.includes("source:graded:1"));
  assert.equal(db.prepare("SELECT module FROM graded_tasks WHERE task = ?").get(gradedTask.id).module, "codehost-github");
  db.prepare("DELETE FROM graded_tasks WHERE task = ?").run(gradedTask.id);
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

/**
 * A module lists and closes only its own tasks: the release train's source family is listable to the code host, and a task
 * carrying this module's marker and no other module's is its to close. A second module's marker refuses both, even when this
 * module's marker is there too; a task with no module marker at all (the runner-era filings) is refused by the same guard.
 */
test("the code host closes and lists only the tasks carrying its own marker and no other module's", async (t) => {
  const made = new Map();
  const owner = async (method, path, body) => {
    if (method === "GET" && path === `/api/agents/${PE}`) return { status: 200, json: { id: PE, companyId: "c-1", status: "idle" } };
    if (method === "GET" && path === "/api/companies") return { status: 200, json: [{ id: "c-1" }] };
    if (method === "GET" && path.startsWith("/api/companies/c-1/issues?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      // The control plane searches the text: `q` matches the source marker, and a task that only mentions the family too.
      return { status: 200, json: [...made.values()].filter((i) => !["done", "cancelled"].includes(i.status) && String(i.description).includes(String(q.get("q")))) };
    }
    const m = /^\/api\/issues\/([^/]+)$/.exec(path);
    if (m) {
      const issue = [...made.values()].find((i) => i.id === m[1]);
      if (!issue) return { status: 404, json: {} };
      if (method === "PATCH") Object.assign(issue, { status: body.status, closing: body.comment });
      return { status: 200, json: issue };
    }
    return { status: 404, json: {} };
  };
  const tasks = createModuleTasks({ db: new DatabaseSync(":memory:"), owner, agents: () => ({ [PE]: { roles: ["platform-engineer"] } }) });
  const who = {
    codehost: { kind: "module", module: "codehost-github", roles: ["kernel.tasks"] },
    github: { kind: "module", module: "github", roles: ["kernel.tasks"] },
  };
  const bp = createBackplane({ whoami: async (k) => who[k] ?? Promise.reject(new Error("no")), asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), tasks });
  const { s, url } = await serve(bp);
  t.after(() => s.close());
  const close = (key, id) => fetch(`${url}/v1/tasks/${id}/close`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ status: "done", body: "**Not landed:** the next merge to the product files the next bump." }) });
  const list = (key, source) => fetch(`${url}/v1/tasks?source=${encodeURIComponent(source)}`, { headers: { authorization: `Bearer ${key}` } });
  /** A task as a module filed it: its source marker, then the module markers (none: a runner-era filing). */
  const seed = (source, n, ...modules) => {
    const id = `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const marks = modules.map((module) => `<!-- aidenhq-module:${module} -->`).join("\n");
    const issue = { id, identifier: `ACME-${n}`, title: "Pin bump: this instance's product", status: "in_review", createdAt: "2026-11-17T09:00:00.000Z", description: `Moves the pin.\n\n<!-- source:${source} -->\n${marks}`, assigneeAgentId: PE, createdByUserId: OWNER };
    made.set(id, issue);
    return issue;
  };

  // Its own task: the source marker and its module marker, no other module's.
  const own = seed(`release:instance:${"d".repeat(40)}`, 1, "codehost-github");
  assert.equal((await close("codehost", own.id)).status, 200, "its own bump closes");
  assert.equal(own.status, "done");
  assert.match(own.closing, /<!-- aidenhq:job=codehost-github kind=status -->$/);

  // The runner-era filing has no module marker: the generic guard refuses it, and it is not listed either.
  const legacy = seed("release:instance:1795022489866", 2);
  assert.equal((await close("codehost", legacy.id)).status, 403, "no module marker: not this module's task");
  assert.equal(legacy.status, "in_review", "a refused close changes nothing");

  // Another module's marker alone: not the code host's.
  const foreign = seed("release:instance:1795025189924", 3, "github");
  assert.equal((await close("codehost", foreign.id)).status, 403, "never a task another module marked");

  // The reviewer's point: the release source marker plus the code host's marker plus a second module's is neither listed nor
  // closed, by either module.
  const shared = seed("release:instance:1795025189925", 4, "codehost-github", "github");
  assert.equal((await close("codehost", shared.id)).status, 403, "a second module's marker refuses the close, even with this module's");
  assert.equal((await close("github", shared.id)).status, 403, "and it is never the other module's either");
  assert.equal(shared.status, "in_review", "a refused close changes nothing");

  // A second source family keeps the train's listing to its own family: it is not returned even with this module's marker.
  const twoFamilies = seed("release:instance:1795022489926", 5, "codehost-github");
  twoFamilies.description = `${twoFamilies.description}\n<!-- source:dependabot:acme/app/9 -->`;
  const prose = seed("dependabot:acme/app/8", 6, "codehost-github");
  prose.description = "mentions release:instance: in prose only";
  // And one plain open bump the train filed itself: the only row the listing returns.
  const listed = seed("release:instance:1795022489927", 7, "codehost-github");

  const found = await (await list("codehost", "release:instance:")).json();
  assert.deepEqual(found.tasks.map((i) => i.identifier), [listed.identifier], "only the open bump carrying this module's marker alone");
  assert.ok(!found.tasks.some((i) => i.id === shared.id || i.id === foreign.id), "a task with another module's marker is never listed");
  assert.ok(!found.tasks.some((i) => i.id === legacy.id), "a task with no module marker is never listed");
  assert.ok(!found.tasks.some((i) => i.id === twoFamilies.id), "nor is one with a second source family");
  assert.ok(!found.tasks.some((i) => i.id === prose.id || i.id === own.id), "prose only, or a closed task, is never listed");
  assert.equal((await list("codehost", "dependabot:")).status, 400, "no other family is listable");
  assert.equal((await list("github", "release:instance:")).status, 400, "nor by another module");
});

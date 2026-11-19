// Tasks modules file for agents (modtasks.ts): by role, once per source, marked as the module's, only with kernel.tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
 * A stranded release-train bump: the runner-era task (or the train's, from a process that is gone) carries the train's source
 * marker and no module marker, which the old close guard refused. The code host settles it only on its own family's marker and
 * only through a card it filed; a card-less task is refused by that guard, and only the sweep's explicit `uncarded` path may
 * settle the runner's ms-stamp task with no record at all.
 */
test("the code host closes its own stranded release bump, and no other module's task or card", async (t) => {
  const made = new Map();
  const cards = new Map();
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
  const tasks = createModuleTasks({ db: new DatabaseSync(":memory:"), owner, agents: () => ({ [PE]: { roles: ["platform-engineer"] } }), applies: (task) => cards.get(task) ?? [] });
  const who = {
    codehost: { kind: "module", module: "codehost-github", roles: ["kernel.tasks"] },
    github: { kind: "module", module: "github", roles: ["kernel.tasks"] },
  };
  const bp = createBackplane({ whoami: async (k) => who[k] ?? Promise.reject(new Error("no")), asserter: { jwks: {} }, proxy: async () => {}, cp: async () => {}, grantsFile: () => ({}), tasks });
  const { s, url } = await serve(bp);
  t.after(() => s.close());
  const close = (key, id, extra) => fetch(`${url}/v1/tasks/${id}/close`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ status: "done", body: "**Not landed:** it was approved but failed: the service codehost-github isn't running.", ...extra }) });
  const list = (key, source) => fetch(`${url}/v1/tasks?source=${encodeURIComponent(source)}`, { headers: { authorization: `Bearer ${key}` } });
  const card = (id, ...modules) => cards.set(id, modules.map((module) => ({ module })));
  /** A stranded bump as the runner filed it, straight into the control plane: the source marker, no module marker, no agent creator. */
  const seed = (source, n) => {
    const id = `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const issue = { id, identifier: `ACME-${n}`, title: "Pin bump: this instance's product", status: "in_review", description: `Moves the pin.\n\n<!-- source:${source} -->`, assigneeAgentId: PE };
    made.set(id, issue);
    return issue;
  };

  // No record: the ownership guard never admits it (no empty `every()` passing by default), even with `uncarded` on a sha task.
  const bump = seed("release:instance:1795022489866", 1);
  assert.doesNotMatch(bump.description, /aidenhq-module:/, "the runner-era task carries no module marker");
  assert.equal((await close("codehost", bump.id)).status, 403, "no kernel.apply record: the guard refuses");
  assert.equal(bump.status, "in_review", "a refused close changes nothing");
  const shaNoCard = seed(`release:instance:${"c".repeat(40)}`, 9);
  assert.equal((await close("codehost", shaNoCard.id, { uncarded: true })).status, 403, "the uncarded path is only the runner's ms stamp");

  // The separate path the sweep uses for that one card-less task settles it, and no other module can.
  assert.equal((await close("codehost", bump.id, { uncarded: true })).status, 200, "the runner's never-carded bump is settled by the sweep's own path");
  assert.equal(bump.status, "done");
  const otherUncarded = seed("release:instance:1795022489867", 8);
  assert.equal((await close("github", otherUncarded.id, { uncarded: true })).status, 403, "never another module");

  const other = seed("dependabot:acme/app/7", 2);

  const carded = seed("release:instance:1795025189923", 3);
  card(carded.id, "codehost-github");
  assert.equal((await close("codehost", carded.id)).status, 200, "a bump whose only card is the code host's");

  // A 40-hex (train-era) bump with a code host card closes the same way: the family covers both stamps.
  const sha = seed(`release:instance:${"d".repeat(40)}`, 10);
  card(sha.id, "codehost-github");
  assert.equal((await close("codehost", sha.id)).status, 200, "a train-era bump whose card is the code host's");

  const foreign = seed("release:instance:1795025189924", 4);
  card(foreign.id, "github");
  assert.equal((await close("codehost", foreign.id)).status, 403, "never a card another module filed");
  assert.equal(foreign.status, "in_review", "a refused close changes nothing");

  const mixed = seed("release:instance:1795005121449", 5);
  card(mixed.id, "codehost-github", "github");
  assert.equal((await close("codehost", mixed.id)).status, 403, "one foreign card among them is enough to refuse");

  // A task an agent created is never the code host's, whatever its marker says.
  const agentMade = seed("release:instance:1795005121448", 6);
  agentMade.createdByAgentId = "a-cos";
  assert.equal((await close("codehost", agentMade.id)).status, 403, "never a task an agent created");

  // The listing: only the train's own family, only what is still open, and only tasks that really carry the marker.
  const prose = seed("dependabot:acme/app/8", 7);
  prose.description = "mentions release:instance: in prose only";
  const found = await (await list("codehost", "release:instance:")).json();
  assert.deepEqual(found.tasks.map((i) => i.identifier).sort(), [foreign.identifier, mixed.identifier, agentMade.identifier, shaNoCard.identifier, otherUncarded.identifier].sort(), "the carded bumps were closed above, so they are no longer open");
  assert.ok(!found.tasks.some((i) => i.id === other.id || i.id === prose.id || i.id === bump.id || i.id === carded.id || i.id === sha.id), "another family, prose, or a closed task is never listed");
  assert.equal((await list("codehost", "dependabot:")).status, 400, "no other family is listable");
  assert.equal((await list("github", "release:instance:")).status, 400, "nor by another module");
});

// Projects (projects.ts): a PR's repo puts its task in that repo's project (its product's when the instance lists it, else one of
// its own, made on first sight), only while the task has none; moving a repo into a product moves its open and recent tasks; an
// agent's name reuses a project in any case and makes one when none fits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createProjects } from "../src/projects.ts";

const NOW = Date.parse("2026-11-23T08:00:00Z");
function fake(products = {}) {
  const projects = [];
  const at = new Date(NOW - 3600_000).toISOString(), old = new Date(NOW - 10 * 86400_000).toISOString();
  const issues = {
    t1: { id: "t1", companyId: "co", projectId: null, status: "todo", updatedAt: at },
    t2: { id: "t2", companyId: "co", projectId: null, status: "done", updatedAt: at },
    t3: { id: "t3", companyId: "co", projectId: "p-set", status: "todo", updatedAt: at },
    t4: { id: "t4", companyId: "co", projectId: null, status: "done", updatedAt: old },
  };
  const owner = async (method, path, body) => {
    if (method === "GET" && path === "/api/companies/co/projects") return { status: 200, json: projects };
    if (method === "POST" && path === "/api/companies/co/projects") {
      const p = { id: `p-${projects.length + 1}`, name: body.name, archivedAt: null };
      projects.push(p);
      return { status: 201, json: p };
    }
    const i = /^\/api\/issues\/(\w+)$/.exec(path)?.[1];
    if (i && method === "GET") return { status: 200, json: issues[i] };
    if (i && method === "PATCH") return { status: 200, json: Object.assign(issues[i], body) };
    return { status: 404, json: {} };
  };
  const map = { products };
  const p = createProjects({ db: new DatabaseSync(":memory:"), owner, products: () => map.products, now: () => NOW });
  return { p, projects, issues, map, owner };
}

test("a PR's repo fills in its task's project: one per repo, a listed product's for its repos, never over a set project", async () => {
  const { p, projects, issues } = fake({ AidenHQ: ["acme/product", "acme/instance"] });
  await Promise.all([p.touch("t1", "acme/widgets"), p.touch("t2", "Acme/Widgets.git")]);
  assert.deepEqual(projects.map((x) => x.name), ["widgets"]);
  assert.deepEqual([issues.t1.projectId, issues.t2.projectId], ["p-1", "p-1"]);
  await p.touch("t3", "acme/widgets");
  assert.equal(issues.t3.projectId, "p-set");
  issues.t1.projectId = issues.t2.projectId = null;
  await p.touch("t1", "acme/instance");
  await p.touch("t2", "acme/product");
  assert.deepEqual(projects.map((x) => x.name), ["widgets", "AidenHQ"]);
  assert.deepEqual([issues.t1.projectId, issues.t2.projectId], ["p-2", "p-2"]);
  // Another org's repo of the same name gets its own project, named in full.
  issues.t1.projectId = null;
  await p.touch("t1", "partner/widgets");
  assert.equal(projects.find((x) => x.id === issues.t1.projectId).name, "partner/widgets");
});

test("moving a repo into a product moves its open and recent tasks, leaves older ones; an agent's name reuses or makes a project", async () => {
  const { p, projects, issues, map } = fake({ AidenHQ: ["acme/product"] });
  for (const t of ["t1", "t2", "t4"]) await p.touch(t, "acme/distro");
  const distro = issues.t1.projectId;
  await p.sync();
  map.products = { AidenHQ: ["acme/product", "acme/distro"] };
  await p.sync();
  const aidenhq = projects.find((x) => x.name === "AidenHQ").id;
  assert.deepEqual([issues.t1.projectId, issues.t2.projectId, issues.t4.projectId], [aidenhq, aidenhq, distro]);
  assert.ok(!projects.find((x) => x.id === distro).archivedAt);
  // Taken off the product again, the repo and its open tasks go back to its own project.
  map.products = { AidenHQ: ["acme/product"] };
  await p.sync();
  assert.deepEqual([issues.t1.projectId, issues.t4.projectId], [distro, distro]);
  map.products = { AidenHQ: ["acme/product", "acme/distro"] };
  await p.sync();
  issues.t3.projectId = null;
  await p.touch("t3", "acme/distro");
  assert.equal(issues.t3.projectId, aidenhq);
  assert.equal(await p.named("co", "  aidenhq "), aidenhq);
  const hiring = await p.named("co", "Hiring");
  assert.equal(projects.find((x) => x.id === hiring).name, "Hiring");
  projects.push({ id: "p-y", name: "hiring", archivedAt: null });
  await assert.rejects(p.named("co", "Hiring"), /2 projects are named/);

});

test("a product named like a repo's own project takes the name; that repo moves to a project named in full", async () => {
  const { p, projects, issues, map } = fake();
  await p.touch("t1", "acme/api");
  const own = issues.t1.projectId;
  assert.equal(projects.find((x) => x.id === own).name, "api");
  map.products = { API: ["acme/backend"] };
  await p.sync();
  const moved = projects.find((x) => x.id === issues.t1.projectId);
  assert.equal(moved.name, "acme/api");
  await p.touch("t3", "acme/backend");
  assert.equal(issues.t3.projectId, "p-set");
  issues.t2.projectId = null;
  await p.touch("t2", "acme/backend");
  assert.equal(projects.find((x) => x.id === issues.t2.projectId).name, "api");
});

test("tasks whose PRs came before the table are queued once and filled; a restart doesn't queue them again", async () => {
  const { owner, issues, projects } = fake();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, version TEXT, task TEXT, source TEXT, data TEXT)");
  // The previous release had remembered t1 already, without queuing it.
  db.exec("CREATE TABLE project_tasks (task TEXT PRIMARY KEY, repo TEXT NOT NULL); INSERT INTO project_tasks VALUES ('t1', 'acme/widgets')");
  const add = db.prepare("INSERT INTO facts (type, version, task, source, data) VALUES ('pr.opened', 'github/1', ?, 'live', ?)");
  add.run("t1", JSON.stringify({ repo: "Acme/Widgets" }));
  add.run("t1", JSON.stringify({ repo: "acme/other" }));
  add.run("t2", JSON.stringify({ repo: "acme/widgets" }));
  const start = () => createProjects({ db, owner, now: () => NOW });
  const pending = () => db.prepare("SELECT task, repo FROM project_pending ORDER BY task").all().map((r) => `${r.task}:${r.repo}`);
  const p = start();
  assert.deepEqual(pending(), ["t1:acme/widgets", "t2:acme/widgets"]);
  await p.sync();
  assert.deepEqual(projects.map((x) => x.name), ["widgets"]);
  assert.deepEqual([issues.t1.projectId, issues.t2.projectId], ["p-1", "p-1"]);
  assert.deepEqual(pending(), []);
  start();
  assert.deepEqual(pending(), []);
});

test("fills that keep failing go to the back of the queue, so later ones are still tried", async () => {
  const { owner, issues } = fake();
  const db = new DatabaseSync(":memory:");
  const flaky = async (m, path, body) => (/^\/api\/issues\/bad/.test(path) ? { status: 500, json: {} } : owner(m, path, body));
  const p = createProjects({ db, owner: flaky, now: () => NOW });
  for (let i = 0; i < 100; i++) p.queue(`bad${i}`, "acme/widgets");
  p.queue("t1", "acme/widgets");
  await p.sync();
  assert.equal(issues.t1.projectId, null);
  await p.sync();
  assert.equal(issues.t1.projectId, "p-1");
});

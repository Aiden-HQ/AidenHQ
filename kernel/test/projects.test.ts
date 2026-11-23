// Projects (projects.ts): a PR's repo puts its task in that repo's project (made on first sight; the kernel's own repos share
// one), only while the task has none; an agent's name reuses a project in any case and makes one when none fits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createProjects } from "../src/projects.ts";

function fake() {
  const projects = [];
  const issues = { t1: { id: "t1", companyId: "co", projectId: null }, t2: { id: "t2", companyId: "co", projectId: null }, t3: { id: "t3", companyId: "co", projectId: "p-set" } };
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
    if (method === "PATCH" && path.startsWith("/api/projects/")) return { status: 200, json: Object.assign(projects.find((p) => path.endsWith(p.id)), body) };
    if (method === "GET" && path.startsWith("/api/companies/co/issues?")) return { status: 200, json: Object.values(issues).filter((x) => path.includes(`projectId=${x.projectId}&`)) };
    return { status: 404, json: {} };
  };
  const p = createProjects({ db: new DatabaseSync(":memory:"), owner, ownRepos: () => ["Acme/Product", "acme/instance", undefined] });
  return { p, projects, issues };
}

test("a PR's repo fills in its task's project: one per repo, the kernel's own repos as one, never over a set project", async () => {
  const { p, projects, issues } = fake();
  await Promise.all([p.touch("t1", "acme/widgets"), p.touch("t2", "Acme/Widgets.git")]);
  assert.deepEqual(projects.map((x) => x.name), ["widgets"]);
  assert.deepEqual([issues.t1.projectId, issues.t2.projectId], ["p-1", "p-1"]);
  await p.touch("t3", "acme/widgets");
  assert.equal(issues.t3.projectId, "p-set");
  issues.t1.projectId = null;
  await p.touch("t1", "acme/instance");
  issues.t2.projectId = null;
  await p.touch("t2", "acme/product");
  assert.deepEqual(projects.map((x) => x.name), ["widgets", "AidenHQ"]);
  assert.deepEqual([issues.t1.projectId, issues.t2.projectId], ["p-2", "p-2"]);
});

test("an agent's name reuses a project in any case, makes one when none fits, and refuses an ambiguous one; a fold moves and archives", async () => {
  const { p, projects, issues } = fake();
  projects.push({ id: "p-x", name: "AidenHQ", archivedAt: null });
  assert.equal(await p.named("co", "  aidenhq "), "p-x");
  const hiring = await p.named("co", "Hiring");
  assert.equal(projects.find((x) => x.id === hiring).name, "Hiring");
  await p.touch("t1", "acme/distro");
  const distro = issues.t1.projectId;
  const out = await p.fold("co", "distro", "aidenhq");
  assert.deepEqual([out.repos, out.moved, issues.t1.projectId, Boolean(projects.find((x) => x.id === distro).archivedAt)], [["acme/distro"], 1, "p-x", true]);
  issues.t2.projectId = null;
  await p.touch("t2", "acme/distro");
  assert.equal(issues.t2.projectId, "p-x");
  projects.push({ id: "p-y", name: "aidenHQ", archivedAt: null });
  await assert.rejects(p.named("co", "AidenHQ"), /2 projects are named/);
});

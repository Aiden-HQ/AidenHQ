// github's routes for the ship module's watch loop: only ship's token, only the loop's own GitHub calls on a repo the fleet works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPEN_PRS_QUERY, shipRoutes } from "../service/src/ship-routes.ts";

test("ship's GitHub calls: its token only, the loop's own calls only, on a repo the fleet works; never a merge", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "ship-routes-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme/app/pull/1": { task: "ACME-1", branch: "b1" } }));
  const called = [], sent = [];
  const routes = shipRoutes({
    gh: async (method, path, body) => (called.push(`${method} ${path}`), sent.push(body), { status: 200, body: path === "/repos/acme/app" ? { default_branch: "main" } : { ok: true } }),
    flow: { closed: async () => {} }, gate: async () => undefined, cacheDir,
    allowed: (repo) => repo === "acme/app", isShip: async (auth) => auth === "Bearer ship",
  });
  const s = createServer((req, res) => void routes(req, res).then((done) => done || res.writeHead(404).end()));
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  t.after(() => s.close());
  const url = `http://127.0.0.1:${s.address().port}/internal/ship`;
  const gh = (call, auth = "Bearer ship") => fetch(`${url}/gh`, { method: "POST", headers: { authorization: auth }, body: JSON.stringify(call) });

  assert.equal((await gh({ method: "GET", path: "/repos/acme/app/pulls/1" }, "Bearer github")).status, 401, "another module's token");
  assert.deepEqual(await (await gh({ method: "PUT", path: "/repos/acme/app/pulls/1/update-branch", body: { expected_head_sha: "a1", update_method: "rebase" } })).json(), { status: 200, body: { ok: true } });
  assert.equal((await gh({ method: "PUT", path: "/repos/acme/app/pulls/1/merge", body: {} })).status, 403, "no merge");
  assert.equal((await gh({ method: "PATCH", path: "/repos/acme/app/pulls/1", body: { state: "closed", base: "x" } })).status, 403, "a close only");
  assert.equal((await gh({ method: "GET", path: "/repos/other/repo/pulls/1" })).status, 403, "a repo the fleet doesn't work");
  assert.equal((await gh({ method: "POST", path: "/graphql", body: { variables: { owner: "other", repo: "repo" } } })).status, 403, "the open PRs of a repo the fleet doesn't work");
  assert.equal((await gh({ method: "POST", path: "/graphql", body: { query: "mutation { mergePullRequest }", variables: { owner: "acme", repo: "app" } } })).status, 200);
  assert.deepEqual(called, ["PUT /repos/acme/app/pulls/1/update-branch", "POST /graphql"]);
  // A branch is deleted only as an opener's PR branch on that repo, never the default branch or anyone else's.
  assert.equal((await gh({ method: "DELETE", path: "/repos/acme/app/git/refs/heads/main" })).status, 403);
  assert.equal((await gh({ method: "DELETE", path: "/repos/acme/app/git/refs/heads/someone-else" })).status, 403);
  assert.equal((await gh({ method: "DELETE", path: "/repos/acme/app/git/refs/heads/b1" })).status, 200);
  assert.equal((await gh({ method: "DELETE", path: "/repos/acme/app/issues/1/assignees", body: { assignees: ["dev"] } })).status, 200, "removing an assignee is no branch delete");
  // Traversal: a path that normalises to another branch, or out to another repo, is refused whatever its first segment.
  for (const path of ["/repos/acme/app/git/refs/heads/b1/git/refs/heads/x/../../../../../main", "/repos/acme/app/git/refs/heads/b1/../../../../../../other/repo/git/refs/heads/main", "/repos/acme/app/git/refs/heads/b1/%2e%2e/main", "/repos/acme/app/git/refs/heads/b1/./x"])
    assert.equal((await gh({ method: "DELETE", path })).status, 403, path);
  assert.equal((await gh({ method: "GET", path: "/repos/acme/app/pulls/1/../../../../other/repo/pulls/1" })).status, 403, "no dot segment on any call");
  // A fact names a repo the fleet works.
  const flow = (args) => fetch(`${url}/flow`, { method: "POST", headers: { authorization: "Bearer ship" }, body: JSON.stringify({ fn: "closed", args }) });
  assert.equal((await flow(["other/repo", 1, "h", "2026-11-24T00:00:00Z"])).status, 403);
  assert.equal((await flow(["acme/app", 1, "h", "2026-11-24T00:00:00Z"])).status, 200);
  assert.equal(sent[1].query, OPEN_PRS_QUERY, "the one fixed query, never ship's");
  assert.deepEqual(await (await fetch(`${url}/openers`, { headers: { authorization: "Bearer ship" } })).json(), { "https://github.com/acme/app/pull/1": { task: "ACME-1", branch: "b1" } });
});

// A cleanup decides on the opener's status, then waits for the branch lock: a successor that published and was recorded while it
// waited owns the PR now, and the close (and the delete) must not run under the earlier task. The close names the task it was
// decided for, so the route can tell.
test("a close or branch delete whose PR a successor took over while the lock was held is skipped", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "ship-routes-move-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme/app/pull/6": { task: "ACME-1", branch: "b6" } }));
  const called = [];
  const routes = shipRoutes({
    // The successor's publish lands while the cleanup waits for the lock (its PR read): the route must re-read ownership after it.
    gh: async (method, path, body) => {
      if (method === "GET" && path === "/repos/acme/app/pulls/6") writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme/app/pull/6": { task: "ACME-2", branch: "b6" } }));
      called.push(`${method} ${path}`);
      return { status: 200, body: path === "/repos/acme/app" ? { default_branch: "main" } : path === "/repos/acme/app/pulls/6" ? { head: { ref: "b6" } } : { ok: true } };
    },
    flow: { closed: async () => {} }, gate: async () => undefined, cacheDir,
    allowed: (repo) => repo === "acme/app", isShip: async (auth) => auth === "Bearer ship",
  });
  const s = createServer((req, res) => void routes(req, res).then((done) => done || res.writeHead(404).end()));
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  t.after(() => s.close());
  const gh = (call) => fetch(`http://127.0.0.1:${s.address().port}/internal/ship/gh`, { method: "POST", headers: { authorization: "Bearer ship" }, body: JSON.stringify(call) });
  // Decided for ACME-1 while it still owned the PR; ACME-2 has taken it over by the time the route reads.
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme/app/pull/6": { task: "ACME-1", branch: "b6" } }));
  assert.equal((await (await gh({ method: "PATCH", path: "/repos/acme/app/pulls/6", body: { state: "closed", expectTask: "ACME-1" } })).json()).status, 409, "a successor's PR is not closed under the earlier task");
  assert.deepEqual(called.filter((c) => c.startsWith("PATCH")), [], "the close never reached GitHub");
  // The opener's own close still goes, and the field is the route's, never sent to GitHub.
  let sent;
  const own = shipRoutes({
    gh: async (method, path, body) => { sent = body; return { status: 200, body: path === "/repos/acme/app" ? { default_branch: "main" } : { ok: true } }; },
    flow: { closed: async () => {} }, gate: async () => undefined, cacheDir,
    allowed: (repo) => repo === "acme/app", isShip: async () => true,
  });
  const s2 = createServer((req, res) => void own(req, res).then((done) => done || res.writeHead(404).end()));
  await new Promise((ok) => s2.listen(0, "127.0.0.1", ok));
  t.after(() => s2.close());
  const post = (call) => fetch(`http://127.0.0.1:${s2.address().port}/internal/ship/gh`, { method: "POST", headers: { authorization: "Bearer ship" }, body: JSON.stringify(call) });
  assert.equal((await post({ method: "PATCH", path: "/repos/acme/app/pulls/6", body: { state: "closed", expectTask: "ACME-2" } })).status, 200, "the PR's current owner may close it");
  assert.deepEqual(sent, { state: "closed" }, "expectTask is the route's check, never GitHub's");
  assert.equal((await (await post({ method: "DELETE", path: "/repos/acme/app/git/refs/heads/b6", body: { expectTask: "ACME-1" } })).json()).status, 409, "a delete decided for the earlier task is skipped");
});

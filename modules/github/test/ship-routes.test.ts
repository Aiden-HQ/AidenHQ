// github's routes for the ship module's watch loop: only ship's token, only the loop's own GitHub calls on a repo the fleet works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shipRoutes } from "../service/src/ship-routes.ts";

test("ship's GitHub calls: its token only, the loop's own calls only, on a repo the fleet works; never a merge", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "ship-routes-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme/app/pull/1": { task: "ACME-1", branch: "b1" } }));
  const called = [];
  const routes = shipRoutes({
    gh: async (method, path, body) => (called.push(`${method} ${path}`), { status: 200, body: { ok: true } }),
    flow: {}, gate: async () => undefined, cacheDir,
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
  assert.equal((await gh({ method: "POST", path: "/graphql", body: { query: "mutation { mergePullRequest }", variables: { owner: "acme", repo: "app" } } })).status, 403, "no mutation");
  assert.equal((await gh({ method: "POST", path: "/graphql", body: { query: "query { repository }", variables: { owner: "acme", repo: "app" } } })).status, 200);
  assert.deepEqual(called, ["PUT /repos/acme/app/pulls/1/update-branch", "POST /graphql"]);
  assert.deepEqual(await (await fetch(`${url}/openers`, { headers: { authorization: "Bearer ship" } })).json(), { "https://github.com/acme/app/pull/1": { task: "ACME-1", branch: "b1" } });
});

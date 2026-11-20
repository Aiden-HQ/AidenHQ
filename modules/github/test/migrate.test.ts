// DELETE in the release after #1065. dropApp (migrate.ts) against a fake GitHub: the App's bypass actor and pinned checks are
// rewritten once, other rules stay, and the owner is told once to delete the App.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropApp } from "../service/src/migrate.ts";

function fakeGitHub() {
  const writes = [];
  const ruleset = {
    id: 7, name: "main protection", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "ci-required", integration_id: 99 }, { context: "lint" }] } }],
    bypass_actors: [{ actor_type: "Integration", actor_id: 99, bypass_mode: "always" }, { actor_type: "Team", actor_id: 3, bypass_mode: "pull_request" }],
  };
  const protection = { strict: true, checks: [{ context: "ci-required", app_id: 99 }, { context: "lint", app_id: null }] };
  const rest = async (method, path, body) => {
    if (method !== "GET") writes.push({ method, path, body });
    const reply = (b, status = 200) => ({ status, body: b, headers: new Headers() });
    if (path.startsWith("/repos/acme/api/rulesets?")) return reply([{ id: 7 }]);
    if (path === "/repos/acme/api/rulesets/7") return reply(method === "PUT" ? ruleset : ruleset);
    if (path === "/repos/acme/api") return reply({ default_branch: "main" });
    if (path === "/repos/acme/api/branches/main/protection/required_status_checks") return reply(method === "PATCH" ? protection : protection);
    if (path.startsWith("/repos/acme/clean/rulesets?")) return reply([]);
    if (path === "/repos/acme/clean") return reply({ default_branch: "main" });
    return reply({ message: "Not Found" }, 404);
  };
  return { rest, writes };
}

test("dropApp rewrites App rules once", async () => {
  const gh = fakeGitHub();
  const notices = [];
  const o = { file: join(mkdtempSync(join(tmpdir(), "migrate-")), "migrated-from-app.json"), org: "acme" };
  const notify = async (n) => { notices.push(n); };
  await dropApp(gh, ["acme/api", "acme/clean"], notify, o);
  const put = gh.writes.find((w) => w.method === "PUT");
  assert.deepEqual(put.body.bypass_actors, [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }, { actor_type: "Team", actor_id: 3, bypass_mode: "pull_request" }]);
  assert.deepEqual(put.body.rules[1].parameters.required_status_checks, [{ context: "ci-required" }, { context: "lint" }]);
  assert.deepEqual(put.body.rules[0], { type: "deletion" }, "other rules are untouched");
  const patch = gh.writes.find((w) => w.method === "PATCH");
  assert.deepEqual(patch.body, { strict: true, checks: [{ context: "ci-required", app_id: -1 }, { context: "lint", app_id: -1 }] });
  assert.equal(gh.writes.length, 2);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].dedupe_key, "github:app-uninstall");
  assert.equal(notices[0].text, "The GitHub App isn't used any more. Uninstall and delete it on GitHub: https://github.com/organizations/acme/settings/installations");
  await dropApp(gh, ["acme/api", "acme/clean"], notify, o);
  assert.equal(gh.writes.length, 2, "a second run writes nothing");
});

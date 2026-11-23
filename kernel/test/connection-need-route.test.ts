// POST /v1/connections/need (backplane.ts): a module's own owner-fixable need is recorded and answers 200; the request's own
// faults are 400, and a failure recording it is 5xx so the module retries rather than dropping the need.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel } from "./helpers.ts";

const modules = { modules: { github: { roles: ["kernel.owner-notice"], token: "github_token" } } };
const secrets = { github_token: "github-key", gh_key: "gh-key" };
// The connection named "github" is the github module's, so a need reported as github is a known connection.
const connections = { github: { url: "http://127.0.0.1:9/mcp", auth_secret: "gh_key", module: "github", returns: "untrusted", tools: { read: [], write: [], destructive: [] } } };
const need = { cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid", detail: "acme restricts OAuth apps" };

function fault(db, then) {
  db.exec("DROP TRIGGER IF EXISTS need_fault");
  if (then) db.exec("CREATE TRIGGER need_fault BEFORE INSERT ON connection_state BEGIN SELECT RAISE(ABORT, 'kernel.db is locked'); END");
}

test("a module's need is recorded and answers 200, once per cause and org", async (t) => {
  const k = await kernel(t, { connect: true, modules, secrets, connections });
  const post = (body) => k.v1("POST", "/v1/connections/need", body, "github-key");
  assert.equal((await post({ connection: "github", need })).status, 200);
  assert.equal((await post({ connection: "github", need })).status, 200);
  assert.equal(k.records.db.prepare("SELECT COUNT(*) AS n FROM connection_state").get().n, 1);
});

test("the request's own faults are 400, and an unknown connection is a 400", async (t) => {
  const k = await kernel(t, { connect: true, modules, secrets, connections });
  const post = (body) => k.v1("POST", "/v1/connections/need", body, "github-key");
  assert.equal((await post({ connection: "github", need: { ...need, cause: "unreachable" } })).status, 400, "a cause the owner can't fix");
  assert.equal((await post({ need })).status, 400, "no connection");
  assert.equal((await post({ connection: "github" })).status, 400, "no need");
  assert.equal((await post({ connection: "slack", need })).status, 400, "a connection of another module");
  assert.equal((await k.v1("POST", "/v1/connections/need", { connection: "github", need }, "gh-key")).status, 403, "a connection's own key holds none of the module's roles");
});

test("a failure recording the need is a 5xx, never a 400, so the module retries it", async (t) => {
  const k = await kernel(t, { connect: true, modules, secrets, connections });
  fault(k.records.db, true);
  t.after(() => fault(k.records.db, false));
  const r = await k.v1("POST", "/v1/connections/need", { connection: "github", need }, "github-key");
  assert.ok(r.status >= 500, `expected a 5xx, got ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.error.type, "unavailable");
  assert.match(r.json.error.message, /could not be recorded: kernel\.db is locked/);
  // When it can be recorded again, the same request is taken.
  fault(k.records.db, false);
  assert.equal((await k.v1("POST", "/v1/connections/need", { connection: "github", need }, "github-key")).status, 200);
});

test("POST /v1/connections/ok clears one org's need for its module, and refuses a bad body or another module's connection", async (t) => {
  const k = await kernel(t, { connect: true, modules, secrets, connections });
  const post = (body, token = "github-key") => k.v1("POST", "/v1/connections/ok", body, token);
  assert.equal((await k.v1("POST", "/v1/connections/need", { connection: "github", need }, "github-key")).status, 200);
  const row = k.records.db.prepare("SELECT key FROM connection_state").get() as { key: string } | undefined;
  assert.equal(row?.key, "github:restricted:acme");
  assert.equal((await post({ connection: "github", org: "ACME" })).status, 200);
  assert.equal(k.records.db.prepare("SELECT COUNT(*) AS n FROM connection_state").get()!.n, 0, "the org's row is gone, whatever its casing");
  assert.equal((await post({ connection: "github", org: "Acme" })).json.woken, 0);
  assert.equal((await post({ connection: "github" })).status, 400, "no org");
  assert.equal((await post({ connection: "github", org: "not an org" })).status, 400, "a malformed org");
  assert.equal((await post({ org: "acme" })).status, 400, "no connection");
  assert.equal((await post({ connection: "slack", org: "acme" })).status, 400, "a connection of another module");
  assert.equal((await post({ connection: "github", org: "acme" }, "gh-key")).status, 403, "a connection's own key holds none of the module's roles");
});

test("a need on an org no longer configured is not in the digest, and the connection tick clears it", async (t) => {
  // github_orgs (modules.json repos.orgs) holds acme only: the removed org is not in the configured list. The owner channel
  // reads the digest (kernel.notify), as in production.
  const configured = { modules: { ...modules.modules, "owner-channel": { roles: ["kernel.notify"], token: "router_token" } }, repos: { orgs: ["acme"] } };
  const k = await kernel(t, { connect: true, modules: configured, secrets: { ...secrets, router_token: "router-key" }, connections });
  const need2 = { ...need, org: "removed" };
  assert.equal((await k.v1("POST", "/v1/connections/need", { connection: "github", need }, "github-key")).status, 200);
  assert.equal((await k.v1("POST", "/v1/connections/need", { connection: "github", need: need2 }, "github-key")).status, 200);
  // A digest line only lists a row once it has lasted 10 minutes (CONFIRMED): age both, as a need reported a while ago.
  k.records.db.exec("UPDATE connection_state SET since = since - 700000");
  assert.deepEqual((await k.v1("GET", "/v1/connections/needs", undefined, "router-key")).json.lines, [
    "Github isn't connected (acme restricts outside apps): https://github.com/settings/connections/applications/cid",
  ]);
  k.connectionState.tick();
  assert.deepEqual(k.records.db.prepare("SELECT key FROM connection_state ORDER BY key").all().map((r) => r.key), ["github:restricted:acme"]);
});

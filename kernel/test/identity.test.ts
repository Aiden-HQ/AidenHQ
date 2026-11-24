// A module with a token of its own holds its roles by that token alone: its connection's service key (github-mcp, which reads
// untrusted text) is the module with no role, tagged with its service host (the outcome check: backplane.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdentity } from "../src/identity.ts";

test("a connection's key holds no role of a module that has its own token; the token holds them", async () => {
  const secrets = { github_service_key: "svc", codehost_github_token: "own", chat_service_key: "chat" };
  const whoami = createIdentity({
    grants: () => ({}), jobcaps: () => ({}), secret: (n) => secrets[n] ?? "",
    connections: () => ({ github: { url: "http://github-mcp:8086/mcp", auth_secret: "github_service_key", module: "github" }, lane: { url: "http://lane:8090/mcp", auth_secret: "chat_service_key", module: "chat-lane" } }),
    modules: () => ({ github: { roles: ["kernel.apply", "kernel.tasks"], token: "codehost_github_token" }, "chat-lane": { roles: ["kernel.wake"] } }),
  });
  const conn = await whoami("svc");
  assert.deepEqual([conn.module, conn.roles, conn.connection], ["github", [], "github-mcp"]);
  const own = await whoami("own");
  assert.deepEqual([own.module, own.roles, own.connection], ["github", ["kernel.apply", "kernel.tasks"], undefined]);
  // A module with no token of its own keeps its roles on its connection's key.
  assert.deepEqual((await whoami("chat")).roles, ["kernel.wake"]);
});

test("a job token is checked before any connection secret is read", async () => {
  const reads = [];
  const whoami = createIdentity({ grants: () => ({}), jobcaps: () => ({}), connections: () => ({ a: { url: "http://a:1/mcp", auth_secret: "a_key", module: "a" } }), secret: (n) => { reads.push(n); return "x"; } });
  await assert.rejects(whoami("ahqj_nonsense"));
  assert.deepEqual(reads, ["gateway_job_secret"]);
});

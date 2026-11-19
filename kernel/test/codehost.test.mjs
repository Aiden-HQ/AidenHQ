// The kernel brokers the GitHub code host's operations: one grant check here, the code host's own key on the call, the answer
// passed back as it came; no code host → 404.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createCodehost } from "../src/codehost.ts";

async function setup(t, { enabled = true, localSnapshot } = {}) {
  const seen = [];
  const host = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "ghs_x" }));
    });
  });
  await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${host.address().port}`;
  const op = createCodehost({
    grants: () => [{ module: "github", token: { repos: ["*/*"], perms: { issues: "write", contents: "read" } } }, { module: "apps-platform", token: { repos: ["acme-agents/x"], perms: { contents: "read" } }, clone: { repos: ["acme-agents/*"] } }, { module: "registry", token: { repos: ["@instance", "@product"], perms: { contents: "write" } }, snapshot: { repos: ["@agents/*"] } }, { module: "reviewer", snapshot: { repos: ["local/*", "acme-agents/*"] } }],
    repos: () => ({ instance: "acme-agents/aidenhq-instance", agentsOrg: "acme-agents" }),
    kind: () => (enabled ? { module: "codehost-github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "codehost_github_token" } } : undefined),
    secret: (n) => (n === "codehost_github_token" ? "ch-key" : ""),
    resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} },
    ...(localSnapshot ? { localSnapshot: () => localSnapshot } : {}),
    workspace: async (module, task) => { if (module !== "apps-platform" || task !== "t-1") throw Object.assign(new Error("not yours"), { status: 403 }); return { workspace: "TASK-1" }; },
  });
  t.after(() => host.close());
  // The backplane's side: the caller's module (resolved from its token there) and the op, then whatever op answers.
  const kernel = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => op.op(req.headers["x-module"], req.url.slice(1), JSON.parse(body), res).catch((e) => res.writeHead(e.status ?? 500).end(JSON.stringify({ error: e.message }))));
  });
  await new Promise((ok) => kernel.listen(0, "127.0.0.1", ok));
  t.after(() => kernel.close());
  const call = async (module, name, body) => {
    const r = await fetch(`http://127.0.0.1:${kernel.address().port}/${name}`, { method: "POST", headers: { "x-module": module }, body: JSON.stringify(body) });
    const j = await r.json();
    return r.status === 200 ? { status: 200, body: j } : { status: r.status, error: j.error };
  };
  return { call, seen };
}

test("a module's ops go to the code host with its key, only within the module's grant", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("apps-platform", "token", { repo: "acme-agents/y", perms: { contents: "read" } })).status, 403);
  assert.equal((await call("apps-platform", "token", { repo: "acme-agents/x", perms: { contents: "write" } })).status, 403);
  assert.equal((await call("apps-platform", "token", { repo: "acme-agents/*", perms: { contents: "read" } })).status, 403); // org-wide needs owner/*
  assert.equal((await call("nobody", "snapshot", { repo: "acme-agents/x", ref: "main" })).status, 403);
  assert.equal(seen.length, 0);
  const ok = await call("github", "token", { repo: "acme/*", perms: { issues: "write" } });
  assert.deepEqual(ok, { status: 200, body: { token: "ghs_x" } });
  assert.deepEqual(seen.at(-1), { path: "/ops/token", auth: "Bearer ch-key", body: { module: "github", repo: "acme/*", perms: { issues: "write" } } });
  // clone: the task's workspace, as the kernel's dispatcher binding names it.
  assert.equal((await call("apps-platform", "clone", { repo: "acme-agents/x", ref: "main", into: "t-2" })).status, 403);
  assert.equal((await call("apps-platform", "clone", { repo: "acme-agents/x", ref: "main", into: "t-1" })).status, 200);
  assert.deepEqual(seen.at(-1).body, { module: "apps-platform", repo: "acme-agents/x", ref: "main", into: "TASK-1" });
});

test("prototype names, dot-only repo segments and hostile refs never reach the code host", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("github", "token", JSON.parse('{"repo":"acme/x","perms":{"__proto__":"read"}}'))).status, 403);
  assert.equal((await call("github", "token", { repo: "acme/x", perms: { constructor: "read" } })).status, 403);
  assert.equal((await call("github", "token", { repo: "acme/x", perms: { issues: "constructor" } })).status, 403);
  assert.equal((await call("github", "token", { repo: "acme/..", perms: { issues: "read" } })).status, 400);
  assert.equal((await call("apps-platform", "clone", { repo: "acme-agents/x", ref: "-x", into: "t-1" })).status, 400);
  assert.equal((await call("apps-platform", "clone", { repo: "acme-agents/x", ref: "a..b", into: "t-1" })).status, 400);
  assert.equal((await call("apps-platform", "clone", { repo: "acme-agents/x", ref: "main@{1}", into: "t-1" })).status, 400);
  assert.equal(seen.length, 0);
});

test("@instance and @agents resolve from the kernel's own repos; an @ name the kernel lacks covers nothing", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("registry", "token", { repo: "acme-agents/aidenhq-instance", perms: { contents: "write" } })).status, 200);
  assert.equal((await call("registry", "token", { repo: "acme-agents/other", perms: { contents: "write" } })).status, 403);
  assert.equal((await call("registry", "token", { repo: "acme/product", perms: { contents: "write" } })).status, 403); // no @product here
  assert.equal((await call("registry", "snapshot", { repo: "acme-agents/app", ref: "main" })).status, 200);
  assert.equal(seen.length, 2);
});

test("@agents follows the kernel's AIDENHQ_GITHUB_AGENTS_ORG only: a changed setting never moves it", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /^const agentsOrg = env\("AIDENHQ_GITHUB_AGENTS_ORG"\) \|\| undefined;$/m);
  assert.doesNotMatch(main, /github_agents_org|instance_name/);
  const { covers } = await import("../src/codehost.ts");
  assert.equal(covers("acme-agents/app", ["@agents/*"], {}), false); // unset: @agents names nothing
  assert.equal(covers("acme-agents/app", ["@agents/*"], { agentsOrg: "acme-agents" }), true);
});

test("without codehost-github there is no GitHub code host: 404", async (t) => {
  const { call } = await setup(t, { enabled: false });
  const r = await call("github", "token", { repo: "acme/x", perms: { issues: "write" } });
  assert.equal(r.status, 404);
  assert.match(r.error, /no GitHub code host/);
});

test("no grant can ask for Administration: the schema doesn't list it", async () => {
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../schemas/codehost.json", import.meta.url), "utf8"));
  assert.equal("administration" in schema.properties.token.properties.perms.properties, false);
});

test("with both code hosts, each repo goes to its own: local/… to this server's, the agents org's to GitHub", async (t) => {
  const local = [];
  const { call, seen } = await setup(t, { localSnapshot: async (repo, ref) => (local.push({ repo, ref }), Object.assign(Readable.from([Buffer.from('{"local":true}')]), { statusCode: 200, headers: { "content-type": "application/json" } })) });
  assert.equal((await call("reviewer", "snapshot", { repo: "local/old-app", ref: "main" })).status, 200);
  assert.deepEqual(local, [{ repo: "local/old-app", ref: "main" }]);
  assert.equal(seen.length, 0, "a local repo never reaches GitHub's code host");
  assert.equal((await call("reviewer", "snapshot", { repo: "acme-agents/new-app", ref: "main" })).status, 200);
  assert.equal(seen.at(-1).path, "/ops/snapshot");
  assert.equal(local.length, 1);
});

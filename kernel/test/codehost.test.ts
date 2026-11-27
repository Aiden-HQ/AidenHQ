// The kernel brokers the GitHub code host's operations: one grant check here, the code host's own key on the call, the answer
// passed back as it came; no code host → 404. The owner's token is never an op: the code host holds it and runs each op itself.
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import { test } from "node:test";
import { createCodehost } from "../src/codehost.ts";

async function setup(t, { enabled = true, localSnapshot } = {}) {
  const seen = [];
  const host = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${host.address().port}`;
  const op = createCodehost({
    grants: () => [
      { module: "github", fetch: { repos: ["*/*"] }, read: { repos: ["*/*"] }, comment: { repos: ["*/*"] }, commit: { repos: ["@instance"], paths: ["apps.yaml"] }, runner: { orgs: ["acme", "@agents", "@orgs"] }, snapshot: { repos: ["*/*"] } },
      { module: "code-review", setup: { repos: ["*/*"], paths: [".deepsec/data/*/INFO.md", ".deepsec/package.json"] } },
      { module: "apps-platform", fetch: { repos: ["acme-agents/x"] }, clone: { repos: ["acme-agents/*"] } },
      { module: "registry", fetch: { repos: ["@instance", "@product"] }, snapshot: { repos: ["@agents/*"] } },
      { module: "sessions", read: { repos: ["*/*"] } },
      { module: "reviewer", snapshot: { repos: ["local/*", "acme-agents/*"] } },
    ],
    repos: () => ({ instance: "acme-agents/aidenhq-instance", agentsOrgs: ["acme-agents"], orgs: ["partner"] }),
    kind: () => (enabled ? { module: "github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "codehost_github_token" } } : undefined),
    secret: (n) => (n === "codehost_github_token" ? "ch-key" : ""),
    resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} },
    ...(localSnapshot ? { local: () => ({ snapshot: localSnapshot }) } : {}),
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
  return { call, seen, op };
}

test("a module's ops go to the code host with its key, only within the module's grant", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("apps-platform", "fetch", { repo: "acme-agents/y", ref: "refs/heads/main" })).status, 403);
  assert.equal((await call("apps-platform", "fetch", { repo: "acme-agents/*", ref: "refs/heads/main" })).status, 400, "owner/* names no repository");
  assert.equal((await call("nobody", "snapshot", { repo: "acme-agents/x", ref: "main" })).status, 403);
  assert.equal((await call("apps-platform", "read", { repo: "acme-agents/x", kind: "prs" })).status, 403, "a fetch grant isn't a read grant");
  assert.equal(seen.length, 0);
  const ok = await call("apps-platform", "fetch", { repo: "acme-agents/x", ref: "refs/pull/12/head" });
  assert.deepEqual(ok, { status: 200, body: { ok: true } });
  assert.deepEqual(seen.at(-1), { path: "/ops/fetch", auth: "Bearer ch-key", body: { module: "apps-platform", repo: "acme-agents/x", ref: "refs/pull/12/head" } });
  assert.equal((await call("github", "read", { repo: "acme/x", kind: "pr", number: 7 })).status, 200);
  assert.deepEqual(seen.at(-1).body, { module: "github", repo: "acme/x", kind: "pr", number: 7 });
  assert.equal((await call("github", "comment", { repo: "acme/x", number: 7, body: "hi", id: 5, evil: "dropped" })).status, 200);
  assert.deepEqual(seen.at(-1).body, { module: "github", repo: "acme/x", number: 7, body: "hi", id: 5 }, "only the op's own fields are forwarded");
  // No op writes a workspace: a box clones a repo itself from the kernel's bundle (`aidenhq clone`).
  assert.equal((await call("apps-platform", "clone", { repo: "acme-agents/x", ref: "main", into: "t-1" })).status, 404);
});

test("fetch needs the fetch grant: @agents/* covers the fleet org's repos only", async (t) => {
  const { call, op } = await setup(t);
  // `registry` has fetch on @instance and @product only; the fleet org's repos are no one's unless granted.
  assert.equal((await call("registry", "fetch", { repo: "acme-agents/aidenhq-instance", ref: "refs/heads/main" })).status, 200);
  assert.equal((await call("registry", "fetch", { repo: "acme-agents/other", ref: "refs/heads/main" })).status, 403);
  const { covers } = await import("../src/codehost.ts");
  assert.equal(covers("acme/app1", ["@agents/*"], { agentsOrgs: ["acme"] }), true);
  assert.equal(covers("other/app1", ["@agents/*"], { agentsOrgs: ["acme"] }), false);
  assert.ok(op);
});

test("commit refuses an unlisted path, a stale parent shape and a missing grant", async (t) => {
  const { call, seen } = await setup(t);
  const body = { repo: "acme-agents/aidenhq-instance", branch: "feat", path: "apps.yaml", content: "a: 1\n", parent: "a".repeat(40), message: "tune" };
  assert.equal((await call("github", "commit", { ...body, path: "instance.yaml" })).status, 403);
  assert.equal((await call("github", "commit", { ...body, parent: "main" })).status, 400);
  assert.equal((await call("apps-platform", "commit", body)).status, 403);
  assert.equal((await call("github", "commit", { ...body, repo: "acme/other" })).status, 403, "the grant's repos");
  assert.equal(seen.length, 0);
  assert.equal((await call("github", "commit", body)).status, 200);
  assert.deepEqual(seen.at(-1).body, { module: "github", ...body });
});

test("runner_token: only the granted orgs, and only the org goes to the code host", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("github", "runner_token", { org: "other" })).status, 403);
  assert.equal((await call("apps-platform", "runner_token", { org: "acme" })).status, 403);
  assert.equal((await call("github", "runner_token", { org: "ac me" })).status, 400);
  assert.equal(seen.length, 0);
  assert.equal((await call("github", "runner_token", { org: "acme", extra: 1 })).status, 200);
  assert.deepEqual(seen.at(-1), { path: "/ops/runner_token", auth: "Bearer ch-key", body: { module: "github", org: "acme" } });
  assert.equal((await call("github", "runner_token", { org: "acme-agents" })).status, 200, "@agents resolves to the fleet org");
  assert.equal((await call("github", "runner_token", { org: "Partner" })).status, 200, "@orgs resolves to github_orgs");
  assert.equal((await call("github", "runner_token", { org: "stranger" })).status, 403, "an org outside the grant");
});

// A running job's `aidenhq clone`: the kernel's own bundle op, under the dispatcher's clone grant; never a module's to call.
test("bundle: the kernel asks it under the clone grant; a module's call is refused", async (t) => {
  const { call, seen, op } = await setup(t);
  assert.equal((await call("apps-platform", "bundle", { repo: "acme-agents/x", ref: "HEAD" })).status, 404);
  await assert.rejects(op.ask("registry", "bundle", { repo: "acme-agents/x", ref: "HEAD" }), (e) => e.status === 403, "a snapshot grant isn't a clone grant");
  const r = await op.ask("apps-platform", "bundle", { repo: "acme-agents/x", ref: "HEAD" });
  for await (const _ of r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(seen.at(-1), { path: "/ops/bundle", auth: "Bearer ch-key", body: { module: "apps-platform", repo: "acme-agents/x", ref: "HEAD" } });
});

test("dot-only repo segments and hostile refs never reach the code host", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("github", "read", { repo: "acme/..", kind: "prs" })).status, 400);
  assert.equal((await call("github", "snapshot", { repo: "acme-agents/x", ref: "-x" })).status, 400);
  assert.equal((await call("github", "snapshot", { repo: "acme-agents/x", ref: "a..b" })).status, 400);
  assert.equal((await call("github", "snapshot", { repo: "acme-agents/x", ref: "main@{1}" })).status, 400);
  assert.equal(seen.length, 0);
});

test("setup passes only the grant's paths and the fields it names, to the code host", async (t) => {
  const { call, seen } = await setup(t);
  const body = { repo: "acme/widgets", files: { ".deepsec/data/w/INFO.md": "# w\n", ".deepsec/package.json": "{}" }, title: "Add deepsec", body: "Setup.", task: "T-1" };
  assert.equal((await call("code-review", "setup", { ...body, files: { "src/a.ts": "x" } })).status, 403, "a path outside the grant");
  assert.equal((await call("code-review", "setup", { ...body, files: { ".deepsec/data/../x/INFO.md": "x" } })).status, 403, "a glob star is one segment, never ..");
  assert.equal((await call("code-review", "setup", { ...body, files: { ".deepsec/data/a/b/INFO.md": "x" } })).status, 403, "a glob star is one segment");
  assert.equal((await call("github", "setup", body)).status, 403, "no setup grant");
  assert.equal((await call("code-review", "setup", { ...body, task: undefined })).status, 400, "the task the approval belongs to");
  const big = "x".repeat(450_000);
  assert.equal((await call("code-review", "setup", { ...body, files: { ".deepsec/data/a/INFO.md": big, ".deepsec/data/b/INFO.md": big } })).status, 413, "800,000 bytes in all");
  assert.equal(seen.length, 0);
  assert.equal((await call("code-review", "setup", { ...body, base: "b".repeat(40), junk: 1 })).status, 200);
  assert.deepEqual(seen.at(-1).body, { module: "code-review", repo: "acme/widgets", files: body.files, allow: [".deepsec/data/*/INFO.md", ".deepsec/package.json"], title: "Add deepsec", body: "Setup.", task: "T-1" });
});

test("a read is a PR or the open PRs, under the read grant", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("sessions", "read", { repo: "acme/x", kind: "pr", number: 7 })).status, 200);
  assert.deepEqual(seen.at(-1).body, { module: "sessions", repo: "acme/x", kind: "pr", number: 7 });
  assert.equal((await call("sessions", "read", { repo: "acme/x", kind: "prs" })).status, 200);
  assert.equal((await call("sessions", "read", { repo: "acme/x", kind: "file", path: "a.json", ref: "a".repeat(40) })).status, 400, "no other kind is a read");
  assert.equal((await call("reviewer", "read", { repo: "acme/x", kind: "pr", number: 7 })).status, 403, "a module without the read grant");
});

// The real code host's ops (modules/github/service/src/ops.ts) behind the kernel's broker, with a fake GitHub: whatever an op
// answers, success or failure, the owner's token is not in it.
test("no op answer carries the token", async (t) => {
  const { serveOps } = await import("../../modules/github/service/src/ops.ts");
  const TOKEN = "gho_SECRETSECRET";
  const calls = [];
  const access = {
    token: async () => TOKEN,
    identity: async () => ({ login: "owner", name: "Owner", email: "1+owner@users.noreply.github.com" }),
    // The chooser (github-mcp client.ts actorFor): the owner here, every write through the same fake.
    actorFor: async () => ({ kind: "owner", key: "owner", identity: () => access.identity(), rest: (m, p, b) => access.rest(m, p, b), mutate: (name, variables) => access.rest("POST", "/graphql", { query: name === "CREATE_COMMIT" ? "mutation createCommitOnBranch" : name, variables }), gitToken: async () => TOKEN }),
    rest: async (method, path, body) => {
      calls.push({ method, path, body });
      const ok = (b, status = 200) => ({ status, body: b, headers: new Headers() });
      if (path.endsWith("/branches/feat")) return ok({ commit: { sha: "a".repeat(40) } });
      // The registry commit: GitHub's own (createCommitOnBranch), bound to the branch's head.
      if (path === "/graphql" && String(body?.query).includes("createCommitOnBranch")) return body.variables.input.expectedHeadOid === "a".repeat(40) ? ok({ data: { createCommitOnBranch: { commit: { oid: "b".repeat(40) } } } }) : ok({ data: null, errors: [{ type: "STALE_DATA", message: "Expected branch to point to another head" }] });
      if (path.endsWith("/comments")) return ok({ id: 99 }, 201);
      if (path.endsWith("/registration-token")) return ok({ token: "AAAREG", expires_at: "2026-11-20T10:00:00Z" }, 201);
      if (path === "/repos/acme/x/pulls?state=open&per_page=100&page=1") return ok([{ number: 3, head: { sha: "c".repeat(40), repo: { full_name: "acme/x" } }, base: { ref: "main" } }]);
      if (path === "/repos/acme/x/pulls/3") return ok("diff --git a/f b/f\n+changed");
      return ok({ message: `Bad credentials for ${TOKEN}` }, 401); // GitHub (or a proxy) echoing the token in an error
    },
  };
  const noted = [];
  const host = createServer((req, res) => void serveOps(req, res, { access, cacheDir: "/nowhere" }).catch((e) => res.writeHead(500).end(e.message)));
  await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
  t.after(() => host.close());
  const url = `http://127.0.0.1:${host.address().port}`;
  const op = createCodehost({
    grants: () => [{ module: "m", read: { repos: ["*/*"] }, comment: { repos: ["*/*"] }, fetch: { repos: ["*/*"] }, commit: { repos: ["*/*"], paths: ["apps.yaml"] }, runner: { orgs: ["acme"] } }],
    repos: () => ({}), kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "k" } }), secret: () => "ch-key",
    resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} }, noteObject: (ref, record) => noted.push([ref, record]),
  });
  const answers = [];
  const ask = async (name, body) => {
    const r = await op.ask("m", name, body);
    let text = "";
    for await (const c of r) text += c;
    answers.push({ status: r.statusCode, headers: JSON.stringify(r.headers), text });
    return { status: r.statusCode, text };
  };
  const sha = "a".repeat(40);
  assert.equal((await ask("head", { repo: "acme/x", ref: "feat" })).status, 200);
  assert.equal((await ask("read", { repo: "acme/x", kind: "prs" })).status, 200);
  assert.equal((await ask("comment", { repo: "acme/x", number: 3, body: "hello" })).status, 200);
  assert.equal(calls.at(-1).body.body, "hello\n\n🤖 Generated by m with [AidenHQ](https://aidenhq.ai)", "the footer is added in the code host");
  // Through POST /v1/codehost/comment: a new comment's ref is remembered (so editing it is allowed), an edit adds nothing.
  const sent = { head: 0, body: "" };
  const res = { writeHead(c) { sent.head = c; return this; }, end(b) { sent.body = b; }, write() {}, on() { return this; }, once() { return this; }, emit() {} };
  await op.op("m", "comment", { repo: "acme/x", number: 3, body: "again" }, res);
  assert.deepEqual([sent.head, JSON.parse(sent.body), noted], [200, { id: 99 }, [["github:acme/x#3/comment/99", "codehost:m"]]]);
  assert.equal((await ask("commit", { repo: "acme/x", branch: "feat", path: "apps.yaml", content: "a: 1\n", parent: sha, message: "tune" })).status, 200);
  const commit = calls.find((c) => c.path === "/graphql").body.variables.input;
  assert.match(`${commit.message.headline}\n\n${commit.message.body}`, /\n\nCo-authored-by: AidenHQ m <noreply@aidenhq\.ai>$/);
  assert.equal(commit.expectedHeadOid, "a".repeat(40), "bound to the parent; no custom author");
  assert.equal((await ask("commit", { repo: "acme/x", branch: "feat", path: "apps.yaml", content: "a: 1\n", parent: "d".repeat(40), message: "tune" })).status, 409, "the branch is not at parent");
  assert.equal((await ask("runner_token", { org: "acme" })).status, 200);
  assert.equal((await ask("read", { repo: "acme/x", kind: "pr", number: 1 })).status, 502, "an error that echoed the token");
  assert.ok(answers.length >= 7);
  for (const a of answers) assert.ok(!a.text.includes(TOKEN) && !a.headers.includes(TOKEN), a.text);
  assert.match(answers.at(-1).text, /\*\*\*/, "scrubbed, not dropped");
});

// A refusal only the owner can fix (`{error, need}`, modules/github/service/src/ops.ts serveOps) is recorded as connection
// state on the path the MCP proxy uses, and the module's answer still goes back byte for byte: the runner registration's
// missing `admin:org` reached nobody before this.
test("a codehost needs_owner answer is recorded, and the answer is unchanged", async (t) => {
  const answer = JSON.stringify({ error: "GitHub needs the `admin:org` permission: reconnect GitHub on the board", need: { cause: "scope", scope: "admin:org" } });
  const host = createServer((req, res) => { req.resume().on("end", () => res.writeHead(403, { "content-type": "application/json" }).end(answer)); });
  await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
  t.after(() => host.close());
  const url = `http://127.0.0.1:${host.address().port}`;
  const needs = [];
  const cleared = [];
  const op = createCodehost({
    grants: () => [{ module: "ci", runner: { orgs: ["acme"] } }],
    repos: () => ({}), kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "k" } }),
    secret: () => "ch-key", resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} },
    recordNeed: (module, need) => needs.push([module, need]),
    clearNeed: (module) => cleared.push(module),
  });
  const sent: { head?: number; body?: string } = {};
  const res = { writeHead(c) { sent.head = c; return this; }, write(c) { sent.body = (sent.body ?? "") + c; }, end(b) { if (b) sent.body = (sent.body ?? "") + b; }, on() { return this; }, once() { return this; }, emit() {} };
  await op.op("ci", "runner_token", { org: "acme" }, res);
  assert.deepEqual(needs, [["ci", { cause: "scope", scope: "admin:org", detail: "GitHub needs the `admin:org` permission: reconnect GitHub on the board" }]]);
  assert.deepEqual([sent.head, sent.body], [403, answer], "the module's answer goes back as it came");
  assert.deepEqual(cleared, [], "a refusal clears nothing");
});

// The other half: a 2xx op proves the owner's sign-in worked, so a full need an earlier refusal recorded clears the way the
// MCP proxy's SIGNED_IN answer clears it (a scope need is partial and stays until the owner grants it).
test("a codehost 2xx answer clears a full need, and the answer is unchanged", async (t) => {
  const answer = JSON.stringify({ ok: true });
  const host = createServer((req, res) => { req.resume().on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(answer)); });
  await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
  t.after(() => host.close());
  const url = `http://127.0.0.1:${host.address().port}`;
  const cleared = [];
  const op = createCodehost({
    grants: () => [{ module: "ci", runner: { orgs: ["acme"] } }],
    repos: () => ({}), kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "k" } }),
    secret: () => "ch-key", resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} },
    clearNeed: (module) => cleared.push(module),
  });
  const sent = {};
  const res = { writeHead(c) { sent.head = c; return this; }, write(c) { sent.body = (sent.body ?? "") + c; }, end(b) { if (b) sent.body = (sent.body ?? "") + b; }, on() { return this; }, once() { return this; }, emit() {} };
  await op.op("ci", "runner_token", { org: "acme" }, res);
  assert.deepEqual(cleared, ["ci"], "the op's own module clears what it recorded");
  assert.deepEqual([sent.head, sent.body], [200, answer], "the module's answer goes back as it came");
});

// A transient cause (unreachable, rate_limited) is not the owner's to fix: it records nothing, as the MCP proxy's readNeed
// leaves it as a plain error. An unknown cause reads as not_connected, as readNeed does, so a typo never recreates a silent refusal.
test("only owner-fixable causes record a need; a transient one does not", async (t) => {
  for (const [body, expected] of [
    [{ error: "rate limited until 12:00", need: { cause: "rate_limited" } }, []],
    [{ error: "acme/x isn't reachable", need: { cause: "unreachable" } }, []],
    [{ error: "GitHub said no", need: { cause: "not_a_cause" } }, [["ci", { cause: "not_connected", detail: "GitHub said no" }]]],
  ] as const) {
    const host = createServer((req, res) => { req.resume().on("end", () => res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify(body))); });
    await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
    t.after(() => host.close());
    const url = `http://127.0.0.1:${host.address().port}`;
    const needs = [];
    const op = createCodehost({
      grants: () => [{ module: "ci", runner: { orgs: ["acme"] } }],
      repos: () => ({}), kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "k" } }),
      secret: () => "ch-key", resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} },
      recordNeed: (module, need) => needs.push([module, need]),
    });
    const res = { writeHead() { return this; }, write() {}, end() {}, on() { return this; }, once() { return this; }, emit() {} };
    await op.op("ci", "runner_token", { org: "acme" }, res);
    assert.deepEqual(needs, expected, JSON.stringify(body));
  }
});

// An error answer too big to hold whole streams through unchanged and records nothing: op() never rejects before the caller
// has its answer (a body is not a reason to fail the op), and a partial read is never parsed as a need.
test("an oversized error answer streams through unchanged and records no need", async (t) => {
  const answer = JSON.stringify({ error: "x".repeat(2 << 20), need: { cause: "scope", scope: "admin:org" } });
  const host = createServer((req, res) => { req.resume().on("end", () => res.writeHead(403, { "content-type": "application/json" }).end(answer)); });
  await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
  t.after(() => host.close());
  const url = `http://127.0.0.1:${host.address().port}`;
  const needs = [];
  const op = createCodehost({
    grants: () => [{ module: "ci", runner: { orgs: ["acme"] } }],
    repos: () => ({}), kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "k" } }),
    secret: () => "ch-key", resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} },
    recordNeed: (module, need) => needs.push([module, need]),
  });
  const chunks: Buffer[] = [];
  const res = { writeHead() { return this; }, write(c) { chunks.push(Buffer.from(c)); return true; }, end(b) { if (b) chunks.push(Buffer.from(b)); return this; }, on() { return this; }, once() { return this; }, emit() {} };
  await op.op("ci", "runner_token", { org: "acme" }, res);
  assert.deepEqual(needs, [], "a partial read never records a need");
  assert.equal(Buffer.concat(chunks).toString("utf8"), answer, "the answer reaches the caller as it came");
});

// The caller hanging up mid-answer settles the op and cancels the upstream read: a wrapper parked on a full pipe (a caller
// that stopped reading an oversized body) neither stalls op() forever nor leaves the code host's response open. The caller
// here is a real ServerResponse whose client destroys its socket after the headers.
test("a caller that disconnects mid-answer cancels the oversized stream", async (t) => {
  // A body far past NEED_BODY, written slowly, so the source stays pending until the disconnect ends it.
  let upstreamEnded = false;
  const big = Buffer.alloc(4 << 20, 0x78);
  const host = createServer((req, res) => {
    req.resume().on("end", () => {
      res.writeHead(403, { "content-type": "application/json" });
      res.write('{"error":"');
      const pump = () => { if (res.destroyed) { upstreamEnded = true; return; } if (res.write(big)) setImmediate(pump); else res.once("drain", pump); };
      res.on("close", () => { upstreamEnded = true; });
      pump();
    });
  });
  await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
  t.after(() => host.close());
  const url = `http://127.0.0.1:${host.address().port}`;
  const op = createCodehost({
    grants: () => [{ module: "ci", runner: { orgs: ["acme"] } }],
    repos: () => ({}), kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "k" } }),
    secret: () => "ch-key", resolver: { resolve: async (u) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} },
  });
  // The kernel's own side of the answer: a real response over a socket whose client hangs up after reading a little.
  const caller = createServer((req, res) => { void op.op("ci", "runner_token", { org: "acme" }, res); });
  await new Promise((ok) => caller.listen(0, "127.0.0.1", ok));
  t.after(() => caller.close());
  await new Promise<void>((ok) => {
    const req = http.request({ host: "127.0.0.1", port: caller.address().port, path: "/v1/codehost/runner_token", method: "POST" }, (r) => {
      r.once("data", () => { r.destroy(); ok(); });
    });
    req.on("error", () => ok());
    req.end("{}");
  });
  // The op's promise settles and the upstream answer is torn down, rather than a stalled write waiting on a dead caller.
  for (let i = 0; i < 200 && !upstreamEnded; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(upstreamEnded, "the disconnected caller ends the upstream answer");
});

// The kernel brokers the GitHub code host's operations: one grant check here, the code host's own key on the call, the answer
// passed back as it came; no code host → 404. The owner's token is never an op: the code host holds it and runs each op itself.
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
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((ok) => host.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${host.address().port}`;
  const op = createCodehost({
    grants: () => [
      { module: "github", fetch: { repos: ["*/*"] }, read: { repos: ["*/*"] }, evidence: { repos: ["*/*"], paths: [".github/ci/areas.json"] }, comment: { repos: ["*/*"] }, commit: { repos: ["@instance"], paths: ["apps.yaml"] }, runner: { orgs: ["acme", "@agents", "@orgs"] }, snapshot: { repos: ["*/*"] } },
      { module: "apps-platform", fetch: { repos: ["acme-agents/x"] }, clone: { repos: ["acme-agents/*"] } },
      { module: "registry", fetch: { repos: ["@instance", "@product"] }, snapshot: { repos: ["@agents/*"] } },
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

test("token op is gone", async (t) => {
  const { call, op, seen } = await setup(t);
  assert.equal((await call("github", "token", { repo: "acme/x", perms: { issues: "write" } })).status, 404);
  await assert.rejects(op.ask("github", "token", { repo: "acme/x", perms: { issues: "write" } }), (e) => e.status === 404);
  assert.equal(seen.length, 0);
});

test("fetch refs are refs/heads/*, a branch or a pull request's head; head and read check their fields", async (t) => {
  const { call, seen } = await setup(t);
  for (const ref of ["refs/heads/*", "refs/heads/feat/a", "refs/pull/9/head"]) assert.equal((await call("github", "fetch", { repo: "acme/x", ref })).status, 200, ref);
  for (const ref of ["main", "refs/tags/v1", "refs/pull/x/head", "refs/heads/a..b", "refs/heads/-x"]) assert.equal((await call("github", "fetch", { repo: "acme/x", ref })).status, 400, ref);
  assert.equal((await call("github", "head", { repo: "acme/x", ref: "main" })).status, 200);
  assert.equal((await call("github", "read", { repo: "acme/x", kind: "secrets" })).status, 400);
  assert.equal((await call("github", "read", { repo: "acme/x", kind: "job", id: "abc" })).status, 400);
  assert.equal(seen.length, 4);
});

test("a graded head's file is a read kind, behind evidence alone", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("github", "read", { repo: "acme/x", kind: "file", path: ".github/ci/areas.json", ref: "a".repeat(40) })).status, 200);
  assert.deepEqual(seen.at(-1).body, { module: "github", repo: "acme/x", kind: "file", path: ".github/ci/areas.json", ref: "a".repeat(40) });
  assert.equal((await call("github", "read", { repo: "acme/x", kind: "file", path: "../secrets", ref: "a".repeat(40) })).status, 400);
  assert.equal((await call("github", "read", { repo: "acme/x", kind: "file", path: ".github/ci/areas.json", ref: "main" })).status, 400);
  // The evidence grant is narrower: a file reaches only a path it lists.
  assert.equal((await call("apps-platform", "read", { repo: "acme-agents/x", kind: "file", path: ".github/ci/areas.json", ref: "a".repeat(40) })).status, 403);
  assert.equal((await call("github", "read", { repo: "acme/x", kind: "file", path: "apps.yaml", ref: "a".repeat(40) })).status, 403);
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

test("@instance and @agents resolve from the kernel's own repos; an @ name the kernel lacks covers nothing", async (t) => {
  const { call, seen } = await setup(t);
  assert.equal((await call("registry", "fetch", { repo: "acme-agents/aidenhq-instance", ref: "refs/heads/main" })).status, 200);
  assert.equal((await call("registry", "fetch", { repo: "acme-agents/other", ref: "refs/heads/main" })).status, 403);
  assert.equal((await call("registry", "fetch", { repo: "acme/product", ref: "refs/heads/main" })).status, 403); // no @product here
  assert.equal((await call("registry", "snapshot", { repo: "acme-agents/app", ref: "main" })).status, 200);
  assert.equal(seen.length, 2);
});

test("@agents follows the fleet org the modules file names (repos.fleet_org), read per call", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /^const fleetOrg = \(\) => modulesFile\(\)\.repos\?\.fleet_org \|\| undefined;$/m);
  assert.doesNotMatch(main, /AGENTS_ORG/);
  const { covers } = await import("../src/codehost.ts");
  assert.equal(covers("acme-agents/app", ["@agents/*"], {}), false); // unset: @agents names nothing
  assert.equal(covers("acme-agents/app", ["@agents/*"], { agentsOrgs: ["acme-agents"] }), true);
  assert.equal(covers("local/app", ["@agents/*"], { agentsOrgs: ["acme-agents", "local"] }), true); // one per code host
});

test("@orgs and @maintained cover the instance's github_orgs and maintainer_repos, nothing else", async () => {
  const { covers } = await import("../src/codehost.ts");
  const grant = ["@agents/*", "@orgs", "@maintained"], r = { agentsOrgs: ["acme-agents"], orgs: ["partner"], maintained: ["other/tool"] };
  for (const repo of ["acme-agents/a", "partner/x", "other/tool"]) assert.equal(covers(repo, grant, r), true, repo);
  for (const repo of ["other/else", "stranger/x"]) assert.equal(covers(repo, grant, r), false, repo);
  assert.equal(covers("partner/x", grant, {}), false); // the kernel lists none: they name nothing
});

test("without the github module there is no GitHub code host: 404", async (t) => {
  const { call } = await setup(t, { enabled: false });
  const r = await call("github", "read", { repo: "acme/x", kind: "prs" });
  assert.equal(r.status, 404);
  assert.match(r.error, /no GitHub code host/);
});

test("no grant names a token: the schema lists the typed ops only", async () => {
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../schemas/codehost.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(schema.properties).sort(), ["clone", "comment", "commit", "evidence", "fetch", "read", "runner", "snapshot"]);
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

// A local install's instance repo (setup's bare repo at AIDENHQ_INSTANCE_REMOTE, outside <data dir>/codehost): the kernel serves
// its branches as a bundle, and the box clones it itself (`aidenhq clone`); host git never writes the workspace.
test("the instance repo of a local install is cloned in the box from the kernel's bundle, from where setup made it", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localHost } = await import("../../modules/codehost-local/src/host.ts");
  const { localSnapshot } = await import("../../modules/codehost-local/src/snapshot.ts");
  const dir = mkdtempSync(join(tmpdir(), "local-clone-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();
  const remote = join(dir, "aidenhq-instance.git"), seed = join(dir, "seed"), box = join(dir, "box");
  for (const d of [seed, box, join(dir, "scratch")]) mkdirSync(d, { recursive: true });
  git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  git(seed, "init", "--quiet", "-b", "main"); git(seed, "commit", "--quiet", "--allow-empty", "-m", "one"); git(seed, "commit", "--quiet", "--allow-empty", "-m", "two"); git(seed, "push", "--quiet", remote, "main");
  const host = localHost({ root: join(dir, "codehost"), sources: { "local/aidenhq-instance": remote }, tasksDir: join(dir, "tasks"), scratchDir: join(dir, "scratch"), checks: async () => [] });
  const op = createCodehost({
    grants: () => [{ module: "dispatch", clone: { repos: ["@agents/*", "@instance"] } }], repos: () => ({ instance: "local/aidenhq-instance", agentsOrgs: ["local"] }),
    kind: () => undefined, secret: () => "", resolver: {}, local: () => ({ snapshot: localSnapshot({ bare: host.bare }), bundle: host.bundle }),
  });
  // The dispatcher's bundle, as the job's `aidenhq clone` gets it.
  const served = await op.ask("dispatch", "bundle", { repo: "local/aidenhq-instance", ref: "HEAD" });
  const chunks = [];
  for await (const c of served) chunks.push(c);
  writeFileSync(join(dir, "got.bundle"), Buffer.concat(chunks));
  git(box, "clone", "--quiet", join(dir, "got.bundle"), "aidenhq-instance");
  assert.deepEqual(readdirSync(join(dir, "scratch")), [], "the scratch bundle is gone once sent");
  const got = join(box, "aidenhq-instance");
  assert.equal(git(got, "rev-parse", "HEAD"), git(seed, "rev-parse", "HEAD"));
  assert.equal(git(got, "rev-list", "--count", "HEAD"), "2", "with its history, so a branch made on it lands back");
  await assert.rejects(op.ask("nobody", "bundle", { repo: "local/aidenhq-instance", ref: "HEAD" }), (e) => e.status === 403);
  await assert.rejects(op.ask("dispatch", "clone", { repo: "local/aidenhq-instance", ref: "HEAD", into: "t-1" }), (e) => e.status === 404);
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
    rest: async (method, path, body) => {
      calls.push({ method, path, body });
      const ok = (b, status = 200) => ({ status, body: b, headers: new Headers() });
      if (path.endsWith("/branches/feat")) return ok({ commit: { sha: "a".repeat(40) } });
      if (path.includes("/contents/")) return method === "PUT" ? ok({ commit: { sha: "b".repeat(40) } }, 201) : ok({ message: "Not Found" }, 404);
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
  assert.equal((await ask("read", { repo: "acme/x", kind: "diff", number: 3 })).status, 200);
  assert.equal((await ask("comment", { repo: "acme/x", number: 3, body: "hello" })).status, 200);
  assert.equal(calls.at(-1).body.body, "hello\n\n🤖 Generated by m with [AidenHQ](https://aidenhq.ai)", "the footer is added in the code host");
  // Through POST /v1/codehost/comment: a new comment's ref is remembered (so editing it is allowed), an edit adds nothing.
  const sent = { head: 0, body: "" };
  const res = { writeHead(c) { sent.head = c; return this; }, end(b) { sent.body = b; }, write() {}, on() { return this; }, once() { return this; }, emit() {} };
  await op.op("m", "comment", { repo: "acme/x", number: 3, body: "again" }, res);
  assert.deepEqual([sent.head, JSON.parse(sent.body), noted], [200, { id: 99 }, [["github:acme/x#3/comment/99", "codehost:m"]]]);
  assert.equal((await ask("commit", { repo: "acme/x", branch: "feat", path: "apps.yaml", content: "a: 1\n", parent: sha, message: "tune" })).status, 200);
  const put = calls.find((c) => c.method === "PUT").body;
  assert.match(put.message, /\n\nCo-authored-by: AidenHQ m <noreply@aidenhq\.ai>$/);
  assert.deepEqual(put.committer, { name: "Owner", email: "1+owner@users.noreply.github.com" });
  assert.equal((await ask("commit", { repo: "acme/x", branch: "feat", path: "apps.yaml", content: "a: 1\n", parent: "d".repeat(40), message: "tune" })).status, 409, "the branch is not at parent");
  assert.equal((await ask("runner_token", { org: "acme" })).status, 200);
  assert.equal((await ask("read", { repo: "acme/x", kind: "issue", number: 1 })).status, 502, "an error that echoed the token");
  assert.ok(answers.length >= 8);
  for (const a of answers) assert.ok(!a.text.includes(TOKEN) && !a.headers.includes(TOKEN), a.text);
  assert.match(answers.at(-1).text, /\*\*\*/, "scrubbed, not dropped");
});

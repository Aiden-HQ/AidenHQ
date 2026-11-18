// codehost-github's service end to end against a fake GitHub (a bare repo and an in-process API) and a fake kernel: a job's
// branch lands from a hostile workspace without any of its hooks, filters or fsmonitor running; an ops token outside the
// caller's grant is refused; a product-repo merge is refused while lands_platform_repos is off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../service/src/service.ts";
import { SAFE_GIT_ARGS } from "../src/git.mjs";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } }).trim();
const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });

async function setup(t, { grants = [], routes = () => undefined, writable = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codehost-svc-"));
  const marker = join(root, "RAN");
  // "GitHub": a bare repo with main.
  const origin = join(root, "github", "acme-agents", "widget.git");
  mkdirSync(origin, { recursive: true });
  sh(origin, "init", "--quiet", "--bare", "-b", "main");
  const seed = join(root, "seed");
  sh(root, "init", "--quiet", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "widget\n");
  sh(seed, "add", "README.md");
  sh(seed, "commit", "--quiet", "-m", "init");
  sh(seed, "push", "--quiet", origin, "main");
  // The job's workspace: a clone whose own config, hooks and attributes would run a program at every chance.
  const ws = join(root, "tasks", "TASK-1", "widget");
  sh(root, "clone", "--quiet", origin, ws);
  sh(ws, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(ws, "app.js"), "export const x = 1;\n");
  writeFileSync(join(ws, ".gitattributes"), "* filter=evil\n");
  sh(ws, "add", "app.js", ".gitattributes");
  sh(ws, "commit", "--quiet", "-m", "feature");
  const sha = sh(ws, "rev-parse", "HEAD");
  for (const h of ["post-checkout", "pre-push", "reference-transaction", "post-update", "pre-receive", "update", "push-to-checkout"]) {
    writeFileSync(join(ws, ".git", "hooks", h), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(ws, ".git", "hooks", h), 0o755);
  }
  const evil = `touch ${marker}`;
  for (const [k, v] of [["filter.evil.smudge", evil], ["filter.evil.clean", evil], ["filter.evil.process", evil], ["core.fsmonitor", evil], ["uploadpack.packObjectsHook", evil], ["core.sshCommand", evil]]) sh(ws, "config", k, v);

  const outcomes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/whoami") {
      const who = { "Bearer apps-key": "apps-platform", "Bearer github-key": "github" }[req.headers.authorization];
      return who ? res.writeHead(200).end(JSON.stringify({ kind: "module", module: who })) : res.writeHead(401).end("{}");
    }
    // The kernel's dispatcher binding: which task workspaces this caller may write into (writable: task → folder).
    if (req.url === "/v1/jobs/workspace") {
      const ws = req.headers.authorization === "Bearer apps-key" ? writable[JSON.parse(body).task] : undefined;
      return ws ? res.writeHead(200).end(JSON.stringify({ workspace: ws })) : res.writeHead(403).end("{}");
    }
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    if (m) { outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    res.writeHead(404).end("{}");
  });
  const minted = [];
  const app = { token: async (org, o) => (minted.push({ org, ...o }), "tok"), createRepo: async () => "created", identity: async () => ({ name: "acme-app[bot]", email: "1+acme-app[bot]@users.noreply.github.com" }) };
  const ghCalls = [];
  const gh = async (method, path, token, body) => (ghCalls.push({ method, path, body }), routes(method, path) ?? (method === "GET" && path === "/repos/acme-agents/widget" ? { status: 200, body: { default_branch: "main" } } : { status: 404, body: { message: "fake GitHub: no route" } }));
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir: join(root, "cache"), tasksDir: join(root, "tasks"), app, gh,
    remoteUrl: (slug) => join(root, "github", `${slug}.git`), agentsOrg: "acme-agents", instanceRepo: "acme-agents/aidenhq-instance",
    productRepo: "acme/aidenhq", modulesRepo: "acme/aidenhq-modules", landsPlatformRepos: false, grants: () => grants,
  });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (path, body, key = "ch-key") => {
    const r = await fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const raw = (path, body, key) => fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  return { root, ws, marker, origin, sha, outcomes, minted, ghCalls, call, raw };
}

test("the service's copies are the code host's own rules and git arguments", async () => {
  const dir = new URL("..", import.meta.url).pathname;
  for (const f of ["plan.mjs", "github-app.ts", "merge-gate.mjs"]) assert.equal(readFileSync(join(dir, "service/src", f), "utf8"), readFileSync(join(dir, "src", f), "utf8"), `service/src/${f} differs from src/${f}`);
  const { SAFE_GIT_ARGS: ours } = await import("../service/src/service.ts");
  assert.deepEqual(ours, SAFE_GIT_ARGS);
});

test("a job's branch lands from its workspace; no hook, filter or fsmonitor of the workspace runs", async (t) => {
  const { root, marker, origin, sha, outcomes, minted, call } = await setup(t);
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "codehost-github.push", args, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined); // an ordinary branch of an agents-org repo: Tier 0
  assert.equal(plan.json.targets["acme-agents/widget feature"].commit, sha);
  const ex = await call("/aidenhq/v1/executor/execute", { id: "k-0123456789abcdef", kind: "codehost-github.push", args, digest: "d", idempotency_key: "i" });
  assert.deepEqual(ex.json, { accepted: true });
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.equal(sh(origin, "rev-parse", "refs/heads/feature"), sha);
  assert.equal(existsSync(marker), false, "a workspace hook, filter or fsmonitor ran");
  assert.match(readFileSync(join(root, "cache", ".reviewed-refs.jsonl"), "utf8"), /"repo":"acme-agents\/widget","ref":"refs\/ws\/TASK-1\/feature"/, "the kept head is noted for pruning");
  assert.ok(minted.every((m) => m.repositories?.length === 1 && m.repositories[0] === "widget"), "every token is narrowed to the one repo");
});

test("an ops token for a repo outside the caller's grant is refused; inside it, narrowed", async (t) => {
  const { call, minted } = await setup(t, { grants: [{ module: "apps-platform", token: { repos: ["acme-agents/*"], perms: { contents: "read" } } }] });
  assert.equal((await call("/ops/token", { repo: "acme/other", perms: { contents: "read" } }, "apps-key")).status, 403);
  assert.equal((await call("/ops/token", { repo: "acme-agents/widget", perms: { contents: "write" } }, "apps-key")).status, 403);
  assert.equal((await call("/ops/token", { repo: "acme-agents/widget", perms: { contents: "read" } }, "not-a-module")).status, 401);
  const ok = await call("/ops/token", { repo: "acme-agents/widget", perms: { contents: "read" } }, "apps-key");
  assert.equal(ok.status, 200);
  assert.deepEqual(minted.at(-1), { org: "acme-agents", repositories: ["widget"], permissions: { contents: "read" }, fresh: true });
});

test("an org-wide ops token needs a grant on the whole org (or any repo); it says when it expires and which App it is", async (t) => {
  const { call, minted } = await setup(t, { grants: [{ module: "apps-platform", token: { repos: ["acme/a"], perms: { issues: "read" } } }, { module: "github", token: { repos: ["*/*"], perms: { issues: "write", organization_self_hosted_runners: "write" } } }] });
  assert.equal((await call("/ops/token", { repo: "acme/*", perms: { issues: "read" } }, "apps-key")).status, 403);
  const org = await call("/ops/token", { repo: "acme/*", perms: { organization_self_hosted_runners: "write" } }, "github-key");
  assert.equal(org.status, 200, JSON.stringify(org.json));
  assert.deepEqual(minted.at(-1), { org: "acme", permissions: { organization_self_hosted_runners: "write" }, fresh: true });
  assert.equal(org.json.app.slug, "acme-app");
  assert.ok(Date.parse(org.json.expires_at) > Date.now() + 50 * 60_000);
  assert.equal((await call("/ops/token", { repo: "other/thing", perms: { issues: "write" } }, "github-key")).status, 200);
  assert.deepEqual(minted.at(-1), { org: "other", repositories: ["thing"], permissions: { issues: "write" }, fresh: true });
});

test("a product-repo merge is refused while lands_platform_repos is off, in plan and in execute", async (t) => {
  const { call, outcomes } = await setup(t);
  const args = { prs: [{ repo: "acme/aidenhq", number: 7, head: "a".repeat(40) }] };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "codehost-github.merge", args, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(plan.status, 422);
  assert.match(plan.json.error, /lands_platform_repos/);
  await call("/aidenhq/v1/executor/execute", { id: "k-00000000000000ff", kind: "codehost-github.merge", args, digest: "d", idempotency_key: "i" });
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /lands_platform_repos/);
});

const pushArgs = (sha) => ({ workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] });
const planPush = (call, sha) => call("/aidenhq/v1/executor/plan", { kind: "codehost-github.push", args: pushArgs(sha), requester: { kind: "job", roles: [] }, task: "t1" });
const settle = async (outcomes) => { for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10)); };

test("a workspace .git with a symlink, alternates or a commondir is refused before git reads it", async (t) => {
  const { ws, sha, call } = await setup(t);
  symlinkSync("/etc", join(ws, ".git", "refs", "evil"));
  assert.match((await planPush(call, sha)).json.error, /isn't a plain file/);
  rmSync(join(ws, ".git", "refs", "evil"));
  writeFileSync(join(ws, ".git", "objects", "info", "alternates"), "/elsewhere/objects\n");
  assert.match((await planPush(call, sha)).json.error, /alternates/);
  rmSync(join(ws, ".git", "objects", "info", "alternates"));
  writeFileSync(join(ws, ".git", "commondir"), "/elsewhere\n");
  assert.match((await planPush(call, sha)).json.error, /commondir/);
});

test("a job's commit never reaches what snapshot and clone serve as GitHub's", async (t) => {
  const { root, sha, call, raw } = await setup(t, { grants: [{ module: "apps-platform", snapshot: { repos: ["acme-agents/widget"] } }] });
  assert.equal((await planPush(call, sha)).status, 200); // the job's commit is now in the service's ws cache
  assert.throws(() => sh(root, "--git-dir", join(root, "cache", "github", "acme-agents", "widget.git"), "cat-file", "-e", sha));
  assert.notEqual((await raw("/ops/snapshot", { repo: "acme-agents/widget", ref: sha }, "apps-key")).status, 200);
  const snap = await raw("/ops/snapshot", { repo: "acme-agents/widget", ref: "main" }, "apps-key");
  assert.equal(snap.status, 200);
  const tgz = join(root, "snap.tgz");
  writeFileSync(tgz, Buffer.from(await snap.arrayBuffer()));
  assert.deepEqual(execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean), ["README.md"]);
});

test("clone writes only a new folder in the workspace of a task the kernel says the caller may write into, with no credentials", async (t) => {
  const grants = [{ module: "apps-platform", clone: { repos: ["acme-agents/widget"] } }];
  const { root, call } = await setup(t, { grants, writable: { "t-1": "TASK-1", "t-2": "TASK-2", "t-3": "TASK-3", "t-4": "TASK-4" } });
  const clone = (into) => call("/ops/clone", { repo: "acme-agents/widget", ref: "main", into }, "apps-key");
  assert.equal((await clone("t-9")).status, 403); // the kernel: not a task this caller may write into
  assert.equal((await clone("t-2")).status, 400); // no such workspace: never made here
  symlinkSync(join(root, "tasks", "TASK-1"), join(root, "tasks", "TASK-3"));
  assert.equal((await clone("t-3")).status, 400);
  assert.equal((await clone("t-1")).status, 409); // TASK-1/widget is there already
  mkdirSync(join(root, "tasks", "TASK-4"));
  const ok = await clone("t-4");
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const dir = join(root, "tasks", "TASK-4", "widget");
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "widget\n");
  assert.equal(sh(dir, "remote", "get-url", "origin"), "https://github.com/acme-agents/widget.git");
  assert.doesNotMatch(readFileSync(join(dir, ".git", "config"), "utf8"), /tok|credential|extraheader/i);
});

test("kernel.apply's land: the instance commit is read and landed on main once, never forced, only with the executor key", async (t) => {
  const { root, call } = await setup(t, { routes: (m, p) => (m === "GET" && p === "/repos/acme-agents/aidenhq-instance" ? { status: 200, body: { default_branch: "main" } } : undefined) });
  const origin = join(root, "github", "acme-agents", "aidenhq-instance.git");
  mkdirSync(origin, { recursive: true });
  sh(origin, "init", "--quiet", "--bare", "-b", "main");
  const ws = join(root, "tasks", "TASK-2", "aidenhq-instance");
  sh(root, "init", "--quiet", "-b", "main", ws);
  writeFileSync(join(ws, "instance.yaml"), "product: x\n");
  sh(ws, "add", "instance.yaml");
  sh(ws, "commit", "--quiet", "-m", "init");
  sh(ws, "push", "--quiet", origin, "main");
  sh(ws, "checkout", "--quiet", "-b", "fleet/edit");
  mkdirSync(join(ws, "agents", "chaser"), { recursive: true });
  writeFileSync(join(ws, "agents", "chaser", "agent.yaml"), "trial: true\n");
  writeFileSync(join(ws, "instance.yaml"), "product: y\n");
  sh(ws, "add", "-A");
  sh(ws, "commit", "--quiet", "-m", "add chaser");
  const sha = sh(ws, "rev-parse", "HEAD");
  const src = { repo: "acme-agents/aidenhq-instance", branch: "fleet/edit", sha, workspace: "TASK-2" };
  assert.equal((await call("/aidenhq/v1/apply/land", src, "apps-key")).status, 401);
  assert.equal((await call("/aidenhq/v1/apply/read", { ...src, repo: "acme-agents/widget" })).status, 403, "the instance repo only");
  const read = await call("/aidenhq/v1/apply/read", src);
  assert.deepEqual([read.json.files.sort(), read.json.agents], [["agents/chaser/agent.yaml", "instance.yaml"], { base: {}, head: { "agents/chaser/agent.yaml": "trial: true" } }]);
  assert.deepEqual((await call("/aidenhq/v1/apply/land", src)).json, { landed: sha });
  assert.equal(sh(origin, "rev-parse", "main"), sha);
  assert.deepEqual((await call("/aidenhq/v1/apply/land", src)).json, { landed: sha, already: true }, "a second land is a no-op");
  // A commit off an older main is refused, never forced over what landed since.
  sh(ws, "checkout", "--quiet", "-b", "fleet/old", "main");
  writeFileSync(join(ws, "apps.yaml"), "apps: []\n");
  sh(ws, "add", "apps.yaml");
  sh(ws, "commit", "--quiet", "-m", "apps");
  const old = { ...src, branch: "fleet/old", sha: sh(ws, "rev-parse", "HEAD") };
  const r = await call("/aidenhq/v1/apply/land", old);
  assert.deepEqual([r.status, /moved on/.test(r.json.error)], [409, true]);
  assert.equal(sh(origin, "rev-parse", "main"), sha);
});

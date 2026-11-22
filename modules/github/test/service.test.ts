// codehost-github's service end to end against a fake GitHub (a bare repo and an in-process API) and a fake kernel: a job's
// branch lands from the bundle its box wrote in a hostile workspace without any of its hooks, filters or fsmonitor running,
// and a symlinked bundle is refused; an ops token outside the caller's grant is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createService } from "../service/src/service.ts";
import { serveOps } from "../service/src/ops.ts";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } }).trim();
/** What the in-box `aidenhq publish` does: the branch's bundle at <task>/.aidenhq/bundles/<sha>.bundle. Returns the sha. */
const boxBundle = (ws, branch) => {
  const sha = sh(ws, "rev-parse", `refs/heads/${branch}`);
  mkdirSync(join(dirname(ws), ".aidenhq", "bundles"), { recursive: true });
  sh(ws, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${sha}.bundle`), `refs/heads/${branch}`);
  return sha;
};
const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });

async function setup(t, { routes = () => undefined, maintained, connected = () => true } = {}) {
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
  const sha = boxBundle(ws, "feature");
  for (const h of ["post-checkout", "pre-push", "reference-transaction", "post-update", "pre-receive", "update", "push-to-checkout"]) {
    writeFileSync(join(ws, ".git", "hooks", h), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(ws, ".git", "hooks", h), 0o755);
  }
  const evil = `touch ${marker}`;
  for (const [k, v] of [["filter.evil.smudge", evil], ["filter.evil.clean", evil], ["filter.evil.process", evil], ["core.fsmonitor", evil], ["uploadpack.packObjectsHook", evil], ["core.sshCommand", evil]]) sh(ws, "config", k, v);

  const outcomes = [];
  const states = {};
  const oursRefs = new Set();
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    if (m) { outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    const w = /^\/v1\/writes\/([^/]+)$/.exec(req.url);
    if (w) return res.writeHead(200).end(JSON.stringify({ id: w[1], state: states[w[1]] ?? "claimed" }));
    if (req.url.startsWith("/v1/objects")) return res.writeHead(200).end(JSON.stringify({ ours: oursRefs.has(decodeURIComponent(req.url.split("ref=")[1] ?? "")) }));
    res.writeHead(404).end("{}");
  });
  const created = [];
  const ghCalls = [];
  const gh = async (method, path, body) => {
    ghCalls.push({ method, path, body });
    const m = /^\/orgs\/([^/]+)\/repos$/.exec(path);
    if (method === "POST" && m) return (created.push(`${m[1]}/${body.name}`), { status: 201, body: {} });
    return routes(method, path) ?? (method === "GET" && path === "/repos/acme-agents/widget" ? { status: 200, body: { default_branch: "main" } } : { status: 404, body: { message: "fake GitHub: no route" } });
  };
  // GitHub as the owner (github-mcp client.ts GitHubAccess), faked: the owner's login, a token, the routes above.
  const access = {
    connected, scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), token: async () => "tok",
    identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
    rest: async (method, path, body) => ({ ...(await gh(method, path, body)), headers: new Headers() }),
    graphql: async () => ({}),
  };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir: join(root, "cache"), tasksDir: join(root, "tasks"), access,
    remoteUrl: (slug) => join(root, "github", `${slug}.git`), fleetOrg: "acme-agents", instanceRepo: "acme-agents/aidenhq-instance",
    ops: serveOps, productRepo: "acme/aidenhq", allowedOrgs: ["acme-agents", "partner"], maintained, reviewGate: async () => undefined,
  });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (path, body, key = "ch-key") => {
    const r = await fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const raw = (path, body, key = "ch-key") => fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const get = (path, key = "ch-key") => fetch(`${svc.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return { root, ws, marker, origin, sha, outcomes, states, oursRefs, created, ghCalls, call, raw, get, handle };
}

test("create_repo is Tier 0 in an allowed org besides the agents org; a core repo's name, and an org nobody allowed, are refused", async (t) => {
  const { call } = await setup(t);
  const plan = (repo) => call("/aidenhq/v1/executor/plan", { kind: "github.create_repo", args: { repo }, requester: { kind: "job", roles: [] }, task: "t1" });
  const ok = await plan("partner/new-app");
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.raise, undefined);
  const own = await plan("acme-agents/aidenhq-instance");
  assert.match(own.json.error, /product or instance repo/);
  assert.match((await plan("stranger/new-app")).json.error, /outside the orgs/);
});

// Once GitHub is connected, the fleet org is where new repositories go (scripts/test/codehost-switch.test.ts): created as the
// owner, and the Engineer's first branch of the new app lands there.
test("connected: a new app's repository is created in the fleet org with the app starter on main as the owner, and its first branch lands there", async (t) => {
  const { root, outcomes, created, call } = await setup(t, { routes: (m, p) => (m === "GET" && ["/repos/acme-agents/new-app", "/repos/acme/aidenhq"].includes(p) ? { status: 200, body: { default_branch: "main" } } : undefined) });
  // "GitHub": the product, whose modules/apps-platform/starter is the app starter, and the new repo as the code host creates it (a README).
  const bare = (slug, files) => {
    const origin = join(root, "github", `${slug}.git`);
    mkdirSync(origin, { recursive: true });
    sh(origin, "init", "--quiet", "--bare", "-b", "main");
    const seed = join(root, `seed-${slug.replace("/", "-")}`);
    sh(root, "init", "--quiet", "-b", "main", seed);
    for (const [f, text] of Object.entries(files)) { mkdirSync(join(seed, f, ".."), { recursive: true }); writeFileSync(join(seed, f), text); }
    sh(seed, "add", "-A");
    sh(seed, "commit", "--quiet", "-m", "init");
    sh(seed, "push", "--quiet", origin, "main");
    return origin;
  };
  bare("acme/aidenhq", { "modules/apps-platform/starter/README.md": "the starter\n", "modules/apps-platform/starter/server.mjs": "// serve\n", "kernel/x.ts": "//\n" });
  const origin = bare("acme-agents/new-app", { "README.md": "new-app\n" });
  const readme = sh(origin, "rev-parse", "main");
  const create = { kind: "github.create_repo", args: { repo: "acme-agents/new-app" } };
  const plan = await call("/aidenhq/v1/executor/plan", { ...create, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal((await call("/aidenhq/v1/executor/execute", { id: "k-00000000000000c1", ...create, digest: "d", idempotency_key: "c" })).json.accepted, true);
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(created, ["acme-agents/new-app"]);
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /with the app starter on main/);
  // main is GitHub's README commit plus one: the starter's files exactly, nothing else of the product.
  assert.equal(sh(origin, "rev-parse", "main^"), readme);
  assert.deepEqual(sh(origin, "ls-tree", "-r", "--name-only", "main").split("\n"), ["README.md", "server.mjs"]);
  assert.equal(sh(origin, "show", "main:README.md"), "the starter");
  assert.equal(sh(origin, "log", "-1", "--format=%an <%ae>", "main"), "Owner One <1+owner1@users.noreply.github.com>");
  assert.match(sh(origin, "log", "-1", "--format=%B", "main"), /^Co-authored-by: AidenHQ code host <noreply@aidenhq\.ai>$/m);
  // The Engineer's branch of it lands.
  const ws = join(root, "tasks", "TASK-2", "new-app");
  sh(root, "clone", "--quiet", origin, ws);
  sh(ws, "checkout", "--quiet", "-b", "first");
  writeFileSync(join(ws, "app.js"), "export const y = 2;\n");
  sh(ws, "add", "app.js");
  sh(ws, "commit", "--quiet", "-m", "first");
  const sha = boxBundle(ws, "first");
  const push = { kind: "github.push", args: { workspace: "TASK-2", only: [{ repo: "acme-agents/new-app", branch: "first", sha }] } };
  const p2 = await call("/aidenhq/v1/executor/plan", { ...push, requester: { kind: "job", roles: [] }, task: "t2" });
  assert.equal(p2.json.raise, undefined, JSON.stringify(p2.json)); // an ordinary branch of an agents-org repo: Tier 0
  assert.equal((await call("/aidenhq/v1/executor/execute", { id: "k-00000000000000c2", ...push, digest: "d", idempotency_key: "p" })).json.accepted, true);
  for (let i = 0; i < 300 && outcomes.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(outcomes[1]?.ok, true, JSON.stringify(outcomes));
  assert.equal(sh(origin, "rev-parse", "refs/heads/first"), sha);
});

test("a PR to a repo outside ours is refused while its text or a commit message names our tooling", async (t) => {
  const { root, call } = await setup(t, { routes: (m, p) => (m === "GET" && p === "/repos/partner/lib" ? { status: 200, body: { default_branch: "main" } } : undefined) });
  const origin = join(root, "github", "partner", "lib.git");
  mkdirSync(origin, { recursive: true });
  sh(origin, "init", "--quiet", "--bare", "-b", "main");
  const ws = join(root, "tasks", "TASK-3", "lib");
  sh(root, "init", "--quiet", "-b", "main", ws);
  writeFileSync(join(ws, "README.md"), "lib\n");
  sh(ws, "add", "README.md");
  sh(ws, "commit", "--quiet", "-m", "init");
  sh(ws, "push", "--quiet", origin, "main");
  sh(ws, "checkout", "--quiet", "-b", "agent/TASK-3/fix");
  writeFileSync(join(ws, "lib.js"), "export const z = 3;\n");
  sh(ws, "add", "lib.js");
  sh(ws, "commit", "--quiet", "-m", "Fix the parser\n\nCo-authored-by: AidenHQ Engineer <noreply@aidenhq.ai>"); // the attribution trailer is the one allowed name
  const pr = (sha, text) => call("/aidenhq/v1/executor/plan", { kind: "github.pr", args: { workspace: "TASK-3", only: [{ repo: "partner/lib", branch: "agent/TASK-3/fix", sha }], text }, requester: { kind: "job", roles: [] }, task: "t3" });
  const clean = await pr(boxBundle(ws, "agent/TASK-3/fix"), { title: "Fix the parser", body: "Handles empty input." });
  assert.equal(clean.status, 200, JSON.stringify(clean.json));
  assert.match((await pr(boxBundle(ws, "agent/TASK-3/fix"), { title: "Fix the parser", body: "Found by the AidenHQ fleet." })).json.error, /mentions "AidenHQ"/);
  writeFileSync(join(ws, "lib.js"), "export const z = 4;\n");
  sh(ws, "commit", "--quiet", "-am", "Tweak, see /home/agent/notes");
  assert.match((await pr(boxBundle(ws, "agent/TASK-3/fix"), { title: "Fix the parser", body: "Handles empty input." })).json.error, /commit message on agent\/TASK-3\/fix mentions "\/home\/"/);
});

test("a head is the runner's own only in the repo it was pushed to: the same commit as a PR on a maintained repo is reviewed, never Tier 0", async (t) => {
  let pulls = {};
  const checks = { status: 200, body: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }], statuses: [] } };
  const { root, origin, sha, outcomes, call } = await setup(t, { maintained: ["globex/payments"], routes: (method, path) => (path in pulls ? { status: 200, body: pulls[path] } : /\/commits\/\w+\/(check-runs|status)/.test(path) ? checks : undefined) });
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] };
  assert.equal((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  await call("/aidenhq/v1/executor/execute", { id: "k-0123456789abcdee", kind: "github.push", args, digest: "d", idempotency_key: "i" });
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  // The same commit, opened as a PR on a maintained repo outside the agents org.
  const other = join(root, "github", "globex", "payments.git");
  mkdirSync(other, { recursive: true });
  sh(other, "init", "--quiet", "--bare", "-b", "main");
  sh(origin, "push", "--quiet", other, "main", `${sha}:refs/heads/feature`);
  const main = sh(origin, "rev-parse", "main");
  const pr = (repo) => ({ [`/repos/${repo}/pulls/1`]: { number: 1, head: { sha }, base: { sha: main }, changed_files: 2, user: { login: "someone" } }, [`/repos/${repo}/pulls/1/files?per_page=100`]: [{ filename: "app.js" }, { filename: ".gitattributes" }] });
  pulls = { ...pr("acme-agents/widget"), ...pr("globex/payments") };
  const merge = (repo) => call("/aidenhq/v1/executor/plan", { kind: "github.merge", args: { prs: [{ repo, number: 1, head: sha }] }, requester: { kind: "job", roles: [] }, task: "t1" });
  const own = await merge("acme-agents/widget");
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(own.json.raise, undefined, "pushed to this repo: Tier 0");
  const elsewhere = await merge("globex/payments");
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));
  assert.deepEqual([elsewhere.json.raise?.tier, elsewhere.json.raise?.rule], [1, "maintained-merge-foreign-head"]);
});

test("held write resumes on reconnect", async (t) => {
  let on = false;
  const { origin, sha, outcomes, call, handle } = await setup(t, { connected: () => on });
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] };
  assert.equal((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  assert.deepEqual((await call("/aidenhq/v1/executor/execute", { id: "k-00000000000000d1", kind: "github.push", args, digest: "d", idempotency_key: "h" })).json, { accepted: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call("/aidenhq/v1/executor/status", { id: "k-00000000000000d1" })).json.state, "running");
  assert.throws(() => sh(origin, "rev-parse", "--verify", "refs/heads/feature"), "nothing is pushed while GitHub is disconnected");
  on = true;
  await handle.stepHeld();
  await handle.stepHeld(); // a second step runs nothing again
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sh(origin, "rev-parse", "refs/heads/feature"), sha);
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes[0].ok, true);
  assert.equal((await call("/aidenhq/v1/executor/status", { id: "k-00000000000000d1" })).json.state, "done");
});


// codehost-github's service end to end against a fake GitHub (a bare repo and an in-process API) and a fake kernel: a job's
// branch lands from the bundle its box wrote in a hostile workspace without any of its hooks, filters or fsmonitor running,
// and a symlinked bundle is refused; an ops token outside the caller's grant is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createService, workflowNeedError, workflowRefusal } from "../service/src/service.ts";
import { serveOps } from "../service/src/ops.ts";
import { render, validate } from "../../../kernel/src/writes.ts";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } }).trim();
/** What the in-box `aidenhq publish` does: the branch's bundle at <task>/.aidenhq/bundles/<sha>.bundle. Returns the sha. */
const boxBundle = (ws, branch) => {
  const sha = sh(ws, "rev-parse", `refs/heads/${branch}`);
  mkdirSync(join(dirname(ws), ".aidenhq", "bundles"), { recursive: true });
  sh(ws, "update-ref", `refs/aidenhq/publish/${sha}`, sha);
  sh(ws, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${sha}.bundle`), `refs/aidenhq/publish/${sha}`);
  return sha;
};
const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });

async function setup(t, { routes = () => undefined, maintained, connected = () => true, scopes = () => ["repo"], remoteHooks = "" } = {}) {
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
  // A second branch whose change is a workflow file: GitHub refuses it without the `workflow` scope (the typed need below).
  sh(ws, "checkout", "--quiet", "-b", "workflow", "feature");
  mkdirSync(join(ws, ".github", "workflows"), { recursive: true });
  writeFileSync(join(ws, ".github", "workflows", "ci.yml"), "name: ci\non: push\n");
  sh(ws, "add", ".github/workflows/ci.yml");
  sh(ws, "commit", "--quiet", "-m", "ci: add the workflow");
  const wfSha = boxBundle(ws, "workflow");
  sh(ws, "checkout", "--quiet", "feature");
  // A pre-receive script a test writes: "GitHub" refusing a push for a reason it gives (the workflow scope refusal). Installed
  // after the fixture's own pushes, which it would refuse.
  if (remoteHooks) {
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "pre-receive"), remoteHooks);
    chmodSync(join(root, "hooks", "pre-receive"), 0o755);
    sh(origin, "config", "core.hooksPath", join(root, "hooks"));
  }
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
  const reported = [];
  const reportNeed = async (need, detail) => { reported.push({ need, detail }); };
  // GitHub as the owner (github-mcp client.ts GitHubAccess), faked: the owner's login, a token, the routes above.
  const access = {
    connected, scopes, status: () => ({ scopes: scopes(), problems: [] }), token: async () => "tok",
    identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
    rest: async (method, path, body) => ({ ...(await gh(method, path, body)), headers: new Headers() }),
    graphql: async () => ({}),
  };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir: join(root, "cache"), tasksDir: join(root, "tasks"), access,
    reportNeed,
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
  return { root, ws, marker, origin, sha, wfSha, outcomes, states, reported, oursRefs, created, ghCalls, call, raw, get, handle };
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

// A republish sends the PR's text as a full PATCH, so a blank body coming from the CLI (no --body-file) used to replace the
// description with the footer alone. An absent or blank body is left out of the PATCH, a blank title too, and when no text
// remains no PATCH is issued at all: the head is pushed and the PR stays as it is. A real body still replaces it, footered once.
test("an open PR keeps its description when a republish sends a blank body; a real body still replaces it once", async (t) => {
  const url = "https://github.com/acme-agents/widget/pull/7";
  const open = "/repos/acme-agents/widget/pulls?state=open&head=acme-agents%3Afeature";
  const { sha, outcomes, ghCalls, call } = await setup(t, {
    routes: (m, p) =>
      m === "GET" && p === open ? { status: 200, body: [{ number: 7, html_url: url, head: { sha } }] }
        : m === "PATCH" && p === "/repos/acme-agents/widget/pulls/7" ? { status: 200, body: { number: 7, html_url: url } }
          : undefined,
  });
  const patches = () => ghCalls.filter((c) => c.method === "PATCH" && c.path === "/repos/acme-agents/widget/pulls/7");
  let n = 0;
  const republish = async (text) => {
    const id = `k-${String(++n).padStart(16, "0")}`;
    const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }], text };
    assert.deepEqual((await call("/aidenhq/v1/executor/execute", { id, kind: "github.pr", args, digest: "d", idempotency_key: id })).json, { accepted: true });
    for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
    const out = outcomes.shift();
    assert.equal(out?.ok, true, JSON.stringify(out));
    return out;
  };

  // The title updates; the blank body is not a field of the PATCH, so GitHub's description is untouched.
  await republish({ title: "fix(widget): keep the description", body: "" });
  assert.equal(patches().length, 1);
  assert.deepEqual(patches()[0].body, { title: "fix(widget): keep the description" }, "a blank body is left out of the PATCH");
  // Whitespace-only is blank the same way.
  await republish({ title: "fix(widget): keep the description", body: "  \n\t" });
  assert.deepEqual(patches()[1].body, { title: "fix(widget): keep the description" });
  // Nothing of the text remains: no text PATCH at all, and the PR that already exists is returned.
  const before = patches().length;
  const out = await republish({ title: " ", body: "" });
  assert.equal(patches().length, before, "no title and no body: no PATCH is issued");
  assert.match(out.text, /https:\/\/github\.com\/acme-agents\/widget\/pull\/7/);
  // A real body replaces the description, carrying the footer exactly once.
  await republish({ title: "fix(widget): keep the description", body: "Why it changed." });
  const sent = patches().at(-1).body;
  assert.equal(sent.title, "fix(widget): keep the description");
  assert.match(sent.body, /^Why it changed\./);
  assert.equal(sent.body.split("[AidenHQ](https://aidenhq.ai)").length - 1, 1, "one footer");
});

// An open PR keeps its description, but a new PR still opens with the asking agent's footer alone: that is its attribution.
test("a new PR with a blank body still opens with the asking agent's footer", async (t) => {
  const url = "https://github.com/acme-agents/widget/pull/8";
  const { sha, outcomes, ghCalls, call } = await setup(t, {
    routes: (m, p) =>
      m === "GET" && p === "/repos/acme-agents/widget/pulls?state=open&head=acme-agents%3Afeature" ? { status: 200, body: [] }
        : m === "POST" && p === "/repos/acme-agents/widget/pulls" ? { status: 201, body: { number: 8, html_url: url, head: { sha } } }
          : undefined,
  });
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }], text: { title: "fix(widget): new PR", body: "" } };
  await call("/aidenhq/v1/executor/execute", { id: "k-0000000000000123", kind: "github.pr", args, digest: "d", idempotency_key: "new" });
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  const post = ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme-agents/widget/pulls");
  assert.equal(post?.body.title, "fix(widget): new PR");
  assert.equal(post?.body.body.split("[AidenHQ](https://aidenhq.ai)").length - 1, 1, "the new PR carries one footer");
});

// The same head may have an open PR into another base (a release branch); that one is not what this publish planned, so a
// publish into the default branch opens its own PR rather than editing the release PR.
test("an open PR into another base is not reused by a publish into the default branch", async (t) => {
  const url = "https://github.com/acme-agents/widget/pull/9";
  const { sha, outcomes, ghCalls, call } = await setup(t, {
    routes: (m, p) =>
      m === "GET" && p === "/repos/acme-agents/widget/pulls?state=open&head=acme-agents%3Afeature"
        ? { status: 200, body: [{ number: 6, html_url: "https://github.com/acme-agents/widget/pull/6", base: { ref: "release/1.x" } }] }
        : m === "POST" && p === "/repos/acme-agents/widget/pulls" ? { status: 201, body: { number: 9, html_url: url, head: { sha } } }
          : undefined,
  });
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }], text: { title: "fix(widget): main only", body: "Why." } };
  await call("/aidenhq/v1/executor/execute", { id: "k-0000000000000124", kind: "github.pr", args, digest: "d", idempotency_key: "base" });
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.equal(ghCalls.some((c) => c.method === "PATCH"), false, "the release PR is left alone");
  assert.equal(ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme-agents/widget/pulls")?.body.base, "main");
});

// The CLI now sends `text` without `body` when there is no --body-file; the kernel's strict args schema must accept it, or
// the fix would be refused before the service's guard ever runs.
test("the pr args schema accepts a text without a body", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/pr.json", import.meta.url), "utf8"));
  validate(schema, { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha: "a".repeat(40) }], text: { title: "fix(widget): keep the description" } });
});

test("a PR's card carries the branch's diff for the reviewer (#744): every kind renders its plan's facts", async (t) => {
  let pulls = {};
  const { sha, ws, origin, call } = await setup(t, { routes: (method, path) => (path in pulls ? { status: 200, body: pulls[path] } : /\/commits\/\w+\/(check-runs|status)/.test(path) ? { status: 200, body: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }], statuses: [] } } : undefined) });
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.pr", args, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  // The manifest's card (one template for every kind), rendered as the kernel files it.
  const manifest = readFileSync(new URL("../module.yaml", import.meta.url), "utf8");
  for (const k of ["push", "pr", "merge", "close", "create_repo"]) assert.match(manifest, new RegExp(`^  ${k}: \\{.*card: [&*]card`, "m"));
  const template = Object.fromEntries([.../(\w+): "(\{\{\w+\}\})"/g[Symbol.matchAll](/card: &card \{([^}]*\}\}[^}]*)*\}/.exec(manifest)[0])].map((m) => [m[1], m[2]]));
  const card = render(template, { ...args, ...plan.json.facts });
  assert.equal(card.target, "acme-agents/widget `feature`");
  assert.match(card.details, /^\+export const x = 1;$/m);

  // Its merge's card carries the PR's diff at its head, read from GitHub.
  sh(origin, "fetch", "--quiet", ws, `${sha}:refs/heads/feature`);
  const main = sh(origin, "rev-parse", "main");
  pulls = { "/repos/acme-agents/widget/pulls/1": { number: 1, head: { sha }, base: { sha: main }, changed_files: 2, user: { login: "acme-app[bot]" } }, "/repos/acme-agents/widget/pulls/1/files?per_page=100": [{ filename: "app.js" }, { filename: ".gitattributes" }] };
  const merge = await call("/aidenhq/v1/executor/plan", { kind: "github.merge", args: { prs: [{ repo: "acme-agents/widget", number: 1, head: sha }] }, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(merge.status, 200, JSON.stringify(merge.json));
  assert.match(merge.json.facts.diff, /^\+export const x = 1;$/m);
});

test("a job's branch lands from its workspace; no hook, filter or fsmonitor of the workspace runs", async (t) => {
  const { root, marker, origin, sha, outcomes, call } = await setup(t);
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined); // an ordinary branch of an agents-org repo: Tier 0
  assert.equal(plan.json.targets["acme-agents/widget feature"].commit, sha);
  const ex = await call("/aidenhq/v1/executor/execute", { id: "k-0123456789abcdef", kind: "github.push", args, digest: "d", idempotency_key: "i" });
  assert.deepEqual(ex.json, { accepted: true });
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.equal(sh(origin, "rev-parse", "refs/heads/feature"), sha);
  assert.equal(existsSync(marker), false, "a workspace hook, filter or fsmonitor ran");
  assert.match(readFileSync(join(root, "cache", ".reviewed-refs.jsonl"), "utf8"), /"repo":"acme-agents\/widget","ref":"refs\/ws\/TASK-1\/feature"/, "the kept head is noted for pruning");
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

test("ops answer the kernel only; the token op is gone", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("/ops/snapshot", { module: "apps-platform", repo: "acme-agents/widget", ref: "main" }, "apps-key")).status, 401);
  assert.equal((await call("/ops/token", { module: "apps-platform", repo: "acme-agents/widget", perms: { contents: "read" } })).status, 404);
});

// A runner-token refusal with no usable X-Accepted-OAuth-Scopes header (GitHub leaves it off some 403s) is still the
// owner's missing runner permission when the sign-in's own scopes say admin:org is absent: the op derives the typed need
// itself, so the kernel records a scope need instead of a silent error. With the scope granted, the same 403 stays plain.
test("runner_token derives the admin:org need from the known scopes when GitHub gives no header", async (t) => {
  const refused = () => ({ status: 403, body: { message: "Forbidden", documentation_url: "https://docs.github.com/rest/actions/self-hosted-runners" } });
  const noScope = await setup(t, { routes: (method, path) => (path.endsWith("/registration-token") ? refused() : undefined) });
  const missing = await noScope.call("/ops/runner_token", { module: "ci", org: "acme-agents" });
  assert.equal(missing.status, 403, JSON.stringify(missing.json));
  assert.deepEqual(missing.json.need, { cause: "scope", scope: "admin:org" }, "the owner-fixable need the kernel records");
  assert.match(missing.json.error, /admin:org/);
  // Scopes that could not be read (an empty list) say nothing about admin:org: the refusal stays the plain error it was.
  const unknownScopes = await setup(t, { scopes: () => [], routes: (method, path) => (path.endsWith("/registration-token") ? refused() : undefined) });
  const unread = await unknownScopes.call("/ops/runner_token", { module: "ci", org: "acme-agents" });
  assert.equal(unread.status, 502, "an unknown scope list is not a missing admin:org");
  assert.equal(unread.json.need, undefined);
  const hasScope = await setup(t, { scopes: () => ["repo", "admin:org"], routes: (method, path) => (path.endsWith("/registration-token") ? refused() : undefined) });
  const other = await hasScope.call("/ops/runner_token", { module: "ci", org: "acme-agents" });
  assert.equal(other.status, 502, "a 403 the scopes do not explain is still a plain error");
  assert.equal(other.json.need, undefined);
  assert.match(other.json.error, /403 Forbidden/);
});

// The refusal's shape, as the push path builds it: a 403 (the status ops.ts gives a scope need) carrying the typed need, and
// GitHub's own words recognised in a git child's stderr.
test("the workflow refusal is read from GitHub's words and raised as the typed scope need", () => {
  const stderr = "Command failed: git push\nremote: refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope\n ! [remote rejected] main -> main (pre-receive hook declined)\n";
  assert.equal(workflowRefusal(new Error(stderr)), true);
  assert.equal(workflowRefusal(new Error("error: failed to push some refs to 'https://github.com/acme/widget.git'")), false);
  const err = workflowNeedError();
  assert.equal(err.status, 403);
  assert.deepEqual(err.need, { cause: "scope", scope: "workflow" });
  assert.equal(err.message, "GitHub needs the `workflow` permission: reconnect GitHub on the board (Settings, Connections)");
});

// GitHub refuses any commit that creates or updates a workflow file when the OAuth grant lacks `workflow`; its words in the git
// child's stderr are the only signal. The push path turns them into the typed need, hands it to the retrying need queue, and
// fails with the same 403 a scope need gets, never a bare git failure.
test("a push GitHub refuses for the missing workflow scope is the typed scope need, and the need queue hears it", async (t) => {
  const { origin, wfSha, outcomes, reported, call } = await setup(t, {
    // The sign-in's scopes cannot be read here, so only git's own refusal can name the need.
    scopes: () => [],
    remoteHooks: "#!/bin/sh\necho \"refusing to allow an OAuth App to create or update workflow '.github/workflows/ci.yml' without 'workflow' scope\" >&2\nexit 1\n",
  });
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "workflow", sha: wfSha }] };
  assert.equal((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  assert.deepEqual((await call("/aidenhq/v1/executor/execute", { id: "k-00000000000000e1", kind: "github.push", args, digest: "d", idempotency_key: "wf" })).json, { accepted: true });
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(outcomes[0]?.ok, false, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /GitHub needs the `workflow` permission: reconnect GitHub on the board \(Settings, Connections\)/);
  assert.throws(() => sh(origin, "rev-parse", "--verify", "refs/heads/workflow"), "the refused branch is not on GitHub");
  // The need goes through github-mcp's queue, which keeps and retries it when the kernel can't take it.
  assert.deepEqual(reported, [{ need: { cause: "scope", scope: "workflow" }, detail: "GitHub needs the `workflow` permission: reconnect GitHub on the board (Settings, Connections)" }]);
});

// An existing workflow file that the branch does not change is not a reason to refuse: GitHub accepts the push without the scope,
// so the code host must attempt it rather than infer the need from a scope list. The typed need comes only from GitHub's refusal.
test("a workflow that already exists on the branch is pushed without the scope, and only GitHub's refusal names the need", async (t) => {
  const remoteHooks = (marker) => `#!/bin/sh\ntouch ${marker}\necho \"refusing to allow an OAuth App to create or update workflow '.github/workflows/ci.yml' without 'workflow' scope\" >&2\nexit 1\n`;
  const acceptedMarker = join(mkdtempSync(join(tmpdir(), "codehost-wf-")), "PUSHED");
  const accepted = await setup(t, { scopes: () => ["repo", "read:org", "project"], remoteHooks: `#!/bin/sh\ntouch ${acceptedMarker}\nexit 0\n` });
  const args = (wfSha) => ({ workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "workflow", sha: wfSha }] });
  assert.equal((await accepted.call("/aidenhq/v1/executor/plan", { kind: "github.push", args: args(accepted.wfSha), requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  assert.equal((await accepted.call("/aidenhq/v1/executor/execute", { id: "k-00000000000000e2", kind: "github.push", args: args(accepted.wfSha), digest: "d", idempotency_key: "wf2" })).json.accepted, true);
  for (let i = 0; i < 300 && !accepted.outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(accepted.outcomes[0]?.ok, true, JSON.stringify(accepted.outcomes));
  assert.equal(existsSync(acceptedMarker), true, "GitHub's answer decided it: the push was attempted");
  assert.equal(accepted.reported.length, 0, "nothing missing");

  const refusedMarker = join(mkdtempSync(join(tmpdir(), "codehost-wf-")), "PUSHED");
  const missing = await setup(t, { scopes: () => ["repo", "read:org", "project"], remoteHooks: remoteHooks(refusedMarker) });
  assert.equal((await missing.call("/aidenhq/v1/executor/plan", { kind: "github.push", args: args(missing.wfSha), requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  assert.equal((await missing.call("/aidenhq/v1/executor/execute", { id: "k-00000000000000e2", kind: "github.push", args: args(missing.wfSha), digest: "d", idempotency_key: "wf2" })).json.accepted, true);
  for (let i = 0; i < 300 && !missing.outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(missing.outcomes[0]?.ok, false, JSON.stringify(missing.outcomes));
  assert.match(missing.outcomes[0].text, /GitHub needs the `workflow` permission/);
  assert.deepEqual(missing.reported, [{ need: { cause: "scope", scope: "workflow" }, detail: "GitHub needs the `workflow` permission: reconnect GitHub on the board (Settings, Connections)" }]);
  assert.equal(existsSync(refusedMarker), true, "GitHub was asked, and its refusal named the need");
  assert.throws(() => sh(missing.origin, "rev-parse", "--verify", "refs/heads/workflow"), "the branch is not on GitHub");

  // The scope granted: the same branch pushes, and GitHub accepts it.
  const granted = await setup(t, { scopes: () => ["repo", "read:org", "workflow", "project"] });
  assert.equal((await granted.call("/aidenhq/v1/executor/plan", { kind: "github.push", args: args(granted.wfSha), requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  assert.equal((await granted.call("/aidenhq/v1/executor/execute", { id: "k-00000000000000e3", kind: "github.push", args: args(granted.wfSha), digest: "d", idempotency_key: "wf3" })).json.accepted, true);
  for (let i = 0; i < 300 && !granted.outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(granted.outcomes[0]?.ok, true, JSON.stringify(granted.outcomes));
  assert.equal(sh(granted.origin, "rev-parse", "refs/heads/workflow"), granted.wfSha);
  assert.equal(granted.reported.length, 0, "nothing missing");
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

test("held write is re-checked on reconnect", async (t) => {
  let on = false;
  const { root, origin, ws, sha, outcomes, call, handle } = await setup(t, { connected: () => on });
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] };
  assert.equal((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  await call("/aidenhq/v1/executor/execute", { id: "k-00000000000000d2", kind: "github.push", args, digest: "d", idempotency_key: "h2" });
  await new Promise((r) => setTimeout(r, 50));
  // While GitHub was away the task's workspace went: the approved head's bundle is no longer there to read.
  rmSync(join(dirname(ws), ".aidenhq"), { recursive: true });
  const held = JSON.parse(readFileSync(join(root, "cache", "held.json"), "utf8"))["k-00000000000000d2"];
  assert.deepEqual([held.asker.requester, held.asker.task], [{ kind: "job", roles: [] }, "t1"], "held with the requester who asked");
  on = true;
  await handle.stepHeld();
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.throws(() => sh(origin, "rev-parse", "--verify", "refs/heads/feature"), "the moved branch is not pushed");
  assert.equal(outcomes[0]?.ok, false, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /changed while GitHub was disconnected; ask again/);
});

test("a held write whose record was cancelled while held does not run", async (t) => {
  let on = false;
  const { origin, sha, outcomes, states, call, handle } = await setup(t, { connected: () => on });
  const args = { workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] };
  assert.equal((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  await call("/aidenhq/v1/executor/execute", { id: "k-00000000000000d3", kind: "github.push", args, digest: "d", idempotency_key: "h3" });
  await new Promise((r) => setTimeout(r, 50));
  states["k-00000000000000d3"] = "cancelled";
  on = true;
  await handle.stepHeld();
  for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.throws(() => sh(origin, "rev-parse", "--verify", "refs/heads/feature"), "a cancelled record is not pushed");
  assert.equal(outcomes[0]?.ok, false, JSON.stringify(outcomes));
});

test("editing a comment is allowed only for one the kernel recorded as ours", async (t) => {
  const { call, oursRefs, ghCalls } = await setup(t, { routes: (m, p) => (m === "PATCH" && p === "/repos/acme-agents/widget/issues/comments/55" ? { status: 200, body: { id: 55 } } : undefined) });
  const edit = { repo: "acme-agents/widget", number: 3, id: 55, body: "x" };
  assert.equal((await call("/ops/comment", edit)).status, 403);
  assert.equal(ghCalls.some((c) => c.method === "PATCH"), false);
  oursRefs.add("github:acme-agents/widget#3/comment/55");
  assert.equal((await call("/ops/comment", edit)).status, 200);
});

test("reading a job: a missing one is null, a permission refusal stays a 403 and any other failure a 502", async (t) => {
  const { call } = await setup(t, { routes: (m, p) => (p === "/repos/acme/gone/actions/jobs/1" ? { status: 404, body: {} } : p === "/repos/acme/denied/actions/jobs/1" ? { status: 403, body: { message: "Resource not accessible by integration" } } : p === "/repos/acme/down/actions/jobs/1" ? { status: 500, body: {} } : undefined) });
  const job = (repo) => call("/ops/read", { kind: "job", repo, id: 1 });
  assert.equal((await job("acme/gone")).status, 200);
  assert.equal((await job("acme/denied")).status, 403);
  assert.equal((await job("acme/down")).status, 502);
});

test("the owner's commit identity for job boxes; 503 while GitHub isn't connected", async (t) => {
  let on = true;
  const { get } = await setup(t, { connected: () => on });
  assert.equal((await get("/aidenhq/v1/identity", "apps-key")).status, 401);
  const me = await get("/aidenhq/v1/identity");
  assert.deepEqual(await me.json(), { name: "Owner One", email: "1+owner1@users.noreply.github.com" });
  on = false;
  const off = await get("/aidenhq/v1/identity");
  assert.deepEqual([off.status, (await off.json()).error], [503, "GitHub isn't connected"]);
});

const pushArgs = (sha) => ({ workspace: "TASK-1", only: [{ repo: "acme-agents/widget", branch: "feature", sha }] });
const planPush = (call, sha) => call("/aidenhq/v1/executor/plan", { kind: "github.push", args: pushArgs(sha), requester: { kind: "job", roles: [] }, task: "t1" });
const settle = async (outcomes) => { for (let i = 0; i < 300 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10)); };

test("a symlinked bundle, or a bundles folder that leads out of the task, is refused before git reads it; the clone's .git is never read", async (t) => {
  const { root, ws, sha, call } = await setup(t);
  const bundles = join(root, "tasks", "TASK-1", ".aidenhq", "bundles"), file = join(bundles, `${sha}.bundle`);
  const outside = join(root, "elsewhere");
  mkdirSync(outside);
  execFileSync("cp", [file, join(outside, `${sha}.bundle`)]);
  rmSync(file);
  symlinkSync(join(outside, `${sha}.bundle`), file);
  assert.match((await planPush(call, sha)).json.error, /symlink/);
  rmSync(bundles, { recursive: true });
  symlinkSync(outside, bundles);
  assert.match((await planPush(call, sha)).json.error, /isn't a regular file inside task TASK-1/);
  rmSync(bundles);
  // No bundle: the branch isn't read from the clone's .git, however plain it is.
  assert.match((await planPush(call, sha)).json.error, /has no bundle/);
  assert.ok(existsSync(join(ws, ".git", "HEAD")));
});

test("a job's commit never reaches what snapshot and bundle serve as GitHub's", async (t) => {
  const { root, sha, call, raw } = await setup(t);
  assert.equal((await planPush(call, sha)).status, 200); // the job's commit is now in the service's ws cache
  assert.throws(() => sh(root, "--git-dir", join(root, "cache", "github", "acme-agents", "widget.git"), "cat-file", "-e", sha));
  assert.notEqual((await raw("/ops/snapshot", { repo: "acme-agents/widget", ref: sha })).status, 200);
  const snap = await raw("/ops/snapshot", { repo: "acme-agents/widget", ref: "main" });
  assert.equal(snap.status, 200);
  const tgz = join(root, "snap.tgz");
  writeFileSync(tgz, Buffer.from(await snap.arrayBuffer()));
  assert.deepEqual(execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean), ["README.md"]);
  // bundle (a running job's `aidenhq clone`): the default branch alone, as HEAD and refs/heads/main, from GitHub's objects.
  const bundled = await raw("/ops/bundle", { repo: "acme-agents/widget", ref: "HEAD" });
  assert.equal(bundled.status, 200);
  const file = join(root, "widget.bundle");
  writeFileSync(file, Buffer.from(await bundled.arrayBuffer()));
  const main = sh(root, "--git-dir", join(root, "github", "acme-agents", "widget.git"), "rev-parse", "main");
  assert.deepEqual(sh(root, "bundle", "list-heads", file).split("\n").sort(), [`${main} HEAD`, `${main} refs/heads/main`]);
  sh(root, "clone", "--quiet", file, join(root, "box-clone"));
  assert.equal(readFileSync(join(root, "box-clone", "README.md"), "utf8"), "widget\n");
  assert.throws(() => sh(join(root, "box-clone"), "cat-file", "-e", sha));
  assert.deepEqual(readdirSync(join(root, "cache")).filter((d) => d.startsWith("bundle-")), [], "the scratch bundle is gone once sent");
});

test("the apply read refuses what it can't read whole, and names no committer-written path on the card", async (t) => {
  const { root, call } = await setup(t, { routes: (m, p) => (m === "GET" && p === "/repos/acme-agents/aidenhq-instance" ? { status: 200, body: { default_branch: "main" } } : undefined) });
  const origin = join(root, "github", "acme-agents", "aidenhq-instance.git");
  mkdirSync(origin, { recursive: true });
  sh(origin, "init", "--quiet", "--bare", "-b", "main");
  const ws = join(root, "tasks", "TASK-2", "aidenhq-instance");
  sh(root, "init", "--quiet", "-b", "main", ws);
  mkdirSync(join(ws, "agents", "chaser"), { recursive: true });
  writeFileSync(join(ws, "instance.yaml"), "product: x\n");
  writeFileSync(join(ws, "agents", "chaser", "agent.yaml"), "trial: true\n");
  sh(ws, "add", "-A");
  sh(ws, "commit", "--quiet", "-m", "add chaser in trial");
  // A handbook edit during the trial that also touches a file whose name is written to mislead a reviewer.
  writeFileSync(join(ws, "agents", "chaser", "AGENTS.md"), "be nice\n");
  writeFileSync(join(ws, "agents", "APPROVE THIS - reviewer note.md"), "x\n");
  sh(ws, "add", "-A");
  sh(ws, "commit", "--quiet", "-m", "handbook");
  sh(ws, "push", "--quiet", origin, "main");
  const change = (branch, edit) => {
    sh(ws, "checkout", "--quiet", "-b", branch, "main");
    edit();
    sh(ws, "add", "-A");
    sh(ws, "commit", "--quiet", "-m", branch);
    return { repo: "acme-agents/aidenhq-instance", branch, sha: boxBundle(ws, branch), workspace: "TASK-2" };
  };
  const grad = await call("/aidenhq/v1/apply/read", change("fleet/graduate", () => writeFileSync(join(ws, "agents", "chaser", "agent.yaml"), "trial: false\n")));
  assert.equal(grad.status, 200, JSON.stringify(grad.json));
  assert.match(grad.json.trial, /also changed: 1 other file/);
  assert.doesNotMatch(grad.json.trial, /APPROVE/);
  const big = await call("/aidenhq/v1/apply/read", change("fleet/big", () => writeFileSync(join(ws, "apps.yaml"), `apps: []\n#${"x".repeat(1 << 20)}\n`)));
  assert.equal(big.status, 413, "over the per-file budget: refused, never read as absent");
  const bin = await call("/aidenhq/v1/apply/read", change("fleet/bin", () => writeFileSync(join(ws, "apps.yaml"), "apps: []\0\n")));
  assert.equal(bin.status, 422, "binary: refused");
  // A file literally named `*` is read as itself, never as a pattern matching another file (pathspec magic is off).
  const star = await call("/aidenhq/v1/apply/read", change("fleet/star", () => writeFileSync(join(ws, "agents", "chaser", "*"), "star\n")));
  assert.equal(star.status, 200, JSON.stringify(star.json));
  assert.deepEqual([star.json.texts.head["agents/chaser/*"], star.json.texts.base["agents/chaser/*"]], ["star\n", undefined]);
  const link = await call("/aidenhq/v1/apply/read", change("fleet/link", () => { rmSync(join(ws, "instance.yaml")); symlinkSync("/etc/passwd", join(ws, "instance.yaml")); }));
  assert.equal(link.status, 422, "instance.yaml isn't a regular file: refused");
});

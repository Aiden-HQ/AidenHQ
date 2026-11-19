// codehost-github's service end to end against a fake GitHub (a bare repo and an in-process API) and a fake kernel: a job's
// branch lands from a hostile workspace without any of its hooks, filters or fsmonitor running; an ops token outside the
// caller's grant is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../service/src/service.ts";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } }).trim();
const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });

async function setup(t, { routes = () => undefined } = {}) {
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
    productRepo: "acme/aidenhq", allowedOrgs: ["acme-agents", "partner"],
  });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (path, body, key = "ch-key") => {
    const r = await fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const raw = (path, body, key = "ch-key") => fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  return { root, ws, marker, origin, sha, outcomes, minted, ghCalls, call, raw };
}

test("create_repo is Tier 0 in an allowed org besides the agents org; a core repo's name, and an org nobody allowed, are refused", async (t) => {
  const { call } = await setup(t);
  const plan = (repo) => call("/aidenhq/v1/executor/plan", { kind: "codehost-github.create_repo", args: { repo }, requester: { kind: "job", roles: [] }, task: "t1" });
  const ok = await plan("partner/new-app");
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.raise, undefined);
  const own = await plan("acme-agents/aidenhq-instance");
  assert.match(own.json.error, /product or instance repo/);
  assert.match((await plan("stranger/new-app")).json.error, /outside the orgs/);
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
  // The head is the task that planned it first; another task re-publishing it, noted or pushed without a note, never takes it.
  const by = () => JSON.parse(readFileSync(join(root, "cache", "pushed-by.json"), "utf8"));
  assert.deepEqual(by(), { [sha]: { task: "t1", platform: false } });
  await call("/aidenhq/v1/executor/plan", { kind: "codehost-github.push", args, requester: { kind: "job", roles: [] }, task: "t2" });
  assert.equal(by()[sha].task, "t1");
  writeFileSync(join(root, "cache", "pushed-by.json"), "{}");
  await call("/aidenhq/v1/executor/plan", { kind: "codehost-github.push", args, requester: { kind: "job", roles: [] }, task: "t2" });
  assert.deepEqual(by(), {});
});

test("ops answer the kernel only (it checks each module's grant); a token is narrowed to its repo, or org-wide for owner/*", async (t) => {
  const { call, minted } = await setup(t);
  assert.equal((await call("/ops/token", { module: "apps-platform", repo: "acme-agents/widget", perms: { contents: "read" } }, "apps-key")).status, 401);
  const ok = await call("/ops/token", { module: "apps-platform", repo: "acme-agents/widget", perms: { contents: "read" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(minted.at(-1), { org: "acme-agents", repositories: ["widget"], permissions: { contents: "read" }, fresh: true });
  const org = await call("/ops/token", { module: "ci", repo: "acme/*", perms: { organization_self_hosted_runners: "write" } });
  assert.equal(org.status, 200, JSON.stringify(org.json));
  assert.deepEqual(minted.at(-1), { org: "acme", permissions: { organization_self_hosted_runners: "write" }, fresh: true });
  assert.equal(org.json.app.slug, "acme-app");
  assert.ok(Date.parse(org.json.expires_at) > Date.now() + 50 * 60_000);
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
  const { root, sha, call, raw } = await setup(t);
  assert.equal((await planPush(call, sha)).status, 200); // the job's commit is now in the service's ws cache
  assert.throws(() => sh(root, "--git-dir", join(root, "cache", "github", "acme-agents", "widget.git"), "cat-file", "-e", sha));
  assert.notEqual((await raw("/ops/snapshot", { repo: "acme-agents/widget", ref: sha })).status, 200);
  const snap = await raw("/ops/snapshot", { repo: "acme-agents/widget", ref: "main" });
  assert.equal(snap.status, 200);
  const tgz = join(root, "snap.tgz");
  writeFileSync(tgz, Buffer.from(await snap.arrayBuffer()));
  assert.deepEqual(execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean), ["README.md"]);
});

test("clone writes only a new folder in the task workspace the kernel resolved, with no credentials", async (t) => {
  const { root, call } = await setup(t);
  const clone = (into) => call("/ops/clone", { module: "apps-platform", repo: "acme-agents/widget", ref: "main", into });
  assert.equal((await clone("../TASK-1")).status, 400);
  assert.equal((await clone("TASK-2")).status, 400); // no such workspace: never made here
  symlinkSync(join(root, "tasks", "TASK-1"), join(root, "tasks", "TASK-3"));
  assert.equal((await clone("TASK-3")).status, 400);
  assert.equal((await clone("TASK-1")).status, 409); // TASK-1/widget is there already
  mkdirSync(join(root, "tasks", "TASK-4"));
  // HEAD: the default branch by its name (as the kernel asks for an Engineer's clones).
  const ok = await call("/ops/clone", { module: "apps-platform", repo: "acme-agents/widget", ref: "HEAD", into: "TASK-4" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const dir = join(root, "tasks", "TASK-4", "widget");
  assert.match(sh(dir, "rev-parse", "--verify", "refs/remotes/origin/main"), /^[0-9a-f]{40}$/);
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
  const NONE = { official: { from: null, to: null } };
  assert.equal((await call("/aidenhq/v1/apply/land", { ...src, ...NONE }, "apps-key")).status, 401);
  assert.equal((await call("/aidenhq/v1/apply/read", { ...src, repo: "acme-agents/widget" })).status, 403, "the instance repo only");
  // The workspace makes the same sha resolve to other content (a replace ref to another commit): the code host reads the commit
  // through its own fsck-checked copy with replace objects off, never the live workspace, so the read is the commit itself.
  sh(ws, "checkout", "--quiet", "-b", "evil", "main");
  writeFileSync(join(ws, "instance.yaml"), "product: z\n");
  sh(ws, "commit", "--quiet", "-am", "evil");
  sh(ws, "replace", sha, sh(ws, "rev-parse", "HEAD"));
  sh(ws, "checkout", "--quiet", "fleet/edit");
  const read = await call("/aidenhq/v1/apply/read", src);
  assert.deepEqual([read.json.files.sort(), read.json.texts], [["agents/chaser/agent.yaml", "instance.yaml"], { base: { "instance.yaml": "product: x\n" }, head: { "agents/chaser/agent.yaml": "trial: true\n", "instance.yaml": "product: y\n" } }]);
  assert.match(read.json.diff, /\+product: y/);
  // The kernel names the official modules' pin on both sides, or nothing lands; a marketplace pin that appears or moves is
  // refused before anything is pushed (the official modules come with the product pin).
  assert.equal((await call("/aidenhq/v1/apply/land", src)).status, 400, "no pin named: refused");
  const pinAt = (repo, c) => ({ repo, sha: c.repeat(40) });
  assert.equal((await call("/aidenhq/v1/apply/land", { ...src, official: { from: null, to: pinAt("acme/aidenhq-modules", "a") } })).status, 422);
  assert.equal((await call("/aidenhq/v1/apply/land", { ...src, official: { from: pinAt("acme/aidenhq-modules", "a"), to: pinAt("evil/modules", "a") } })).status, 422);
  assert.notEqual(sh(origin, "rev-parse", "main"), sha, "nothing was pushed");
  assert.deepEqual((await call("/aidenhq/v1/apply/land", { ...src, ...NONE })).json, { landed: sha });
  assert.equal(sh(origin, "rev-parse", "main"), sha);
  assert.deepEqual((await call("/aidenhq/v1/apply/land", { ...src, ...NONE })).json, { landed: sha, already: true }, "a second land is a no-op");
  // A commit off an older main is refused, never forced over what landed since.
  sh(ws, "checkout", "--quiet", "-b", "fleet/old", "main");
  writeFileSync(join(ws, "apps.yaml"), "apps: []\n");
  sh(ws, "add", "apps.yaml");
  sh(ws, "commit", "--quiet", "-m", "apps");
  const old = { ...src, branch: "fleet/old", sha: sh(ws, "rev-parse", "HEAD") };
  const r = await call("/aidenhq/v1/apply/land", { ...old, ...NONE });
  assert.deepEqual([r.status, /moved on/.test(r.json.error)], [409, true]);
  assert.equal(sh(origin, "rev-parse", "main"), sha);
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
    return { repo: "acme-agents/aidenhq-instance", branch, sha: sh(ws, "rev-parse", "HEAD"), workspace: "TASK-2" };
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

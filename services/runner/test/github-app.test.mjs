import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IDENTITY, WRITE, identityEnv, appClient, appSlugOf, appJwt, appRemoteUrl, ghOptions, withGitToken } from "../src/github-app.mjs";
import { git, setGitAuth } from "../src/git.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

// Installed on aidenhq-demo (all repos) and Acme (only `selected`).
function fakeGitHub({ repos = [], refuseCreationPerm = false, status } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body, auth: init.headers.authorization });
    const res = (status, json) => ({ status, json: async () => json });
    if (path === "/app") return res(200, { slug: "aidenhq-demo" });
    if (path === "/users/aidenhq-demo%5Bbot%5D") return res(200, { id: 99 });
    if (path.startsWith("/app/installations?")) return res(200, [{ id: 42, account: { login: "aidenhq-demo" } }, { id: 7, account: { login: "Acme" } }]);
    if (path === "/app/installations/42/access_tokens" || path === "/app/installations/7/access_tokens") {
      if (refuseCreationPerm && body?.permissions?.repository_creation) return res(422, { message: "unknown permission" });
      if (path.includes("/7/") && body?.repositories?.some((r) => r !== "selected")) return res(422, { message: "not installed" });
      return res(201, { token: `ghs_${++n}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (init.method === "GET" && path.startsWith("/repos/")) return res(status ?? (repos.includes(path.slice(7)) ? 200 : 404), {});
    if (path === "/orgs/aidenhq-demo/repos") return res(201, {});
    return res(404, {});
  };
  return { calls, app: appClient({ appId: 123, key: privateKey, fetch }) };
}

describe("GitHub App", () => {
  it("signs an RS256 JWT the public key verifies, issued 60s back, valid 9 minutes", () => {
    const now = 1_800_000_000_000;
    const [h, p, sig] = appJwt(123, privateKey, now).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "123" });
    assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig, "base64url"));
  });

  it("mints tokens narrowed to the repo and permissions, cached per (repos, perms)", async () => {
    const { app, calls } = fakeGitHub();
    const a = await app.token("aidenhq-demo", { repositories: ["x"], permissions: WRITE });
    assert.equal(await app.token("aidenhq-demo", { repositories: ["x"], permissions: WRITE }), a);
    assert.notEqual(await app.token("aidenhq-demo", { repositories: ["x"], permissions: { contents: "read" } }), a);
    const mints = calls.filter((c) => c.path.endsWith("/access_tokens"));
    assert.equal(mints.length, 2);
    assert.deepEqual(mints[0].body, { repositories: ["x"], permissions: WRITE });
    assert.equal(calls.filter((c) => c.path.startsWith("/app/installations?")).length, 1);
  });

  it("covers a repo only where an installation includes it", async () => {
    const { app } = fakeGitHub();
    assert.equal(await app.covers("aidenhq-demo/anything"), true);
    assert.equal(await app.covers("Acme/selected"), true);
    assert.equal(await app.covers("Acme/other"), false);
    assert.equal(await app.covers("someone/else"), false);
  });

  it("never creates a repo it is only asked about; only createRepo (an approved card) creates one", async () => {
    const creates = (calls) => calls.filter((c) => (c.method === "POST" && c.path.endsWith("/repos")) || c.body?.permissions?.repository_creation);
    // Naming, adding or detecting a repo only checks it (WOR-4611, WOR-4650: twelve repos were created that way).
    const missing = fakeGitHub();
    for (const name of ["apps", "nonexistent-probe-xyz", "zzz-fake-8f3a2b"]) assert.equal(await missing.app.repoExists(`aidenhq-demo/${name}`), false);
    assert.deepEqual(creates(missing.calls), [], "no create call, no creation token");
    assert.equal(await fakeGitHub({ repos: ["aidenhq-demo/old"] }).app.repoExists("aidenhq-demo/old"), true);
    // GitHub having a bad minute is never "doesn't exist".
    await assert.rejects(fakeGitHub({ status: 502 }).app.repoExists("aidenhq-demo/old"), /502/);
    // The approved card's one path: private, with a creation-only token; an existing repo is left alone.
    const { app, calls } = fakeGitHub();
    assert.equal(await app.createRepo("aidenhq-demo/new-app"), "created");
    assert.deepEqual(calls.find((c) => c.method === "POST" && c.path.endsWith("/repos")).body, { name: "new-app", private: true, auto_init: true });
    assert.deepEqual(calls.filter((c) => c.path.endsWith("/access_tokens")).at(-1).body, { permissions: { repository_creation: "write" } });
    const old = fakeGitHub({ repos: ["aidenhq-demo/old"] });
    assert.equal(await old.app.createRepo("aidenhq-demo/old"), "exists");
    assert.deepEqual(creates(old.calls), []);
    // A refused creation permission fails loudly; never a wider token.
    const refused = fakeGitHub({ refuseCreationPerm: true });
    await assert.rejects(refused.app.createRepo("aidenhq-demo/new-app"), /422/);
    assert.ok(!refused.calls.some((c) => c.method === "POST" && c.path.endsWith("/repos")));
  });

  it("the runner creates a repo only in createRepoApproved; cloning a missing one is an error", () => {
    const main = readFileSync(join(import.meta.dirname, "../src/main.mjs"), "utf8");
    const fn = (name) => main.slice(main.indexOf(`async function ${name}(`)).split("\n}\n")[0];
    assert.equal(main.split("\n").filter((l) => l.includes("createRepo(")).length, 1);
    assert.ok(fn("createRepoApproved").includes("await app.createRepo(slug)"));
    assert.ok(fn("addRepo").includes("if (await missingRepo(repo.slug)) throw new UserError(missingRepoText(repo.slug));"));
  });

  it("commits as the App's bot, resolved once; never the owner's identity", async () => {
    const { app, calls } = fakeGitHub();
    const who = { name: "aidenhq-demo[bot]", email: "99+aidenhq-demo[bot]@users.noreply.github.com" };
    assert.deepEqual(await app.identity(), who);
    assert.deepEqual(await app.identity(), who);
    assert.equal(calls.filter((c) => c.path === "/app").length, 1);
    assert.deepEqual(identityEnv(DEFAULT_IDENTITY), { GIT_AUTHOR_NAME: "AidenHQ agent", GIT_AUTHOR_EMAIL: "agent@aidenhq.invalid", GIT_COMMITTER_NAME: "AidenHQ agent", GIT_COMMITTER_EMAIL: "agent@aidenhq.invalid" });
  });

  it("gives gh the token only through that child's env, and only for the agents org", async () => {
    const { app } = fakeGitHub();
    const opts = await ghOptions(app, "aidenhq-demo/x", WRITE, { cwd: "/w" });
    assert.match(opts.env.GH_TOKEN, /^ghs_/);
    assert.equal(opts.cwd, "/w");
    assert.equal(process.env.GH_TOKEN, undefined);
    assert.deepEqual(await ghOptions(undefined, "Acme/x", WRITE, { cwd: "/w" }), { cwd: "/w" });
    assert.deepEqual(await ghOptions(undefined, "aidenhq-demo/x", WRITE), {});
  });
});

describe("git with the App's token", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-app-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  // The VM's global rewrites: clone over https, push over ssh deploy keys.
  const global = join(dir, "gitconfig");
  writeFileSync(global, '[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n[url "git@github.com:"]\n\tpushInsteadOf = https://github.com/\n[credential]\n\thelper = !echo username=host-login; echo password=host-token; true\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (args, opts = {}) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", ...opts });

  it("pushes to the x-access-token URL over https (no ssh rewrite); the plain https URL would be rewritten", () => {
    g(["init", "-q", "r"]);
    g(["-C", "r", "remote", "add", "app", appRemoteUrl("aidenhq-demo/x")]);
    g(["-C", "r", "remote", "add", "plain", "https://github.com/aidenhq-demo/x.git"]);
    assert.equal(g(["-C", "r", "remote", "get-url", "--push", "app"]).trim(), "https://x-access-token@github.com/aidenhq-demo/x.git");
    assert.equal(g(["-C", "r", "remote", "get-url", "--push", "plain"]).trim(), "git@github.com:aidenhq-demo/x.git");
  });

  it("the credential helper answers github.com from env only, and nothing for any other host", () => {
    const { args, env: e } = withGitToken(["credential", "fill"], env, "ghs_secret");
    assert.ok(!args.join(" ").includes("ghs_secret"));
    const fill = (host) => execFileSync("git", args, { cwd: dir, env: { ...e, GIT_TERMINAL_PROMPT: "0" }, input: `protocol=https\nhost=${host}\n\n`, encoding: "utf8" });
    assert.match(fill("github.com"), /username=x-access-token\npassword=ghs_secret/);
    assert.throws(() => fill("evil.example"));
  });

  it("tokens run only in the runner's cache clone, hardened; a planted workspace config never sees the token", async () => {
    // A GitHub "remote" on disk: the App URL resolves to it through a global insteadOf (offline).
    g(["init", "-q", "--bare", "-b", "main", "remote.git"]);
    g(["-C", "r", "commit", "-q", "--allow-empty", "-m", "one"]);
    g(["-C", "r", "push", "-q", join(dir, "remote.git"), "HEAD:refs/heads/main"]);
    const url = appRemoteUrl("aidenhq-demo/x");
    const global2 = join(dir, "global2");
    writeFileSync(global2, `[url "${join(dir, "remote.git")}"]\n\tinsteadOf = ${url}\n`);
    // Hooks and an fsmonitor that record the token if they ever run with it.
    const leak = join(dir, "leak");
    const evil = join(dir, "evil");
    mkdirSync(evil);
    const spy = (drain) => `#!/bin/sh\necho "x$AIDENHQ_GIT_TOKEN" >> ${leak}\n${drain ? "cat >/dev/null 2>&1\n" : ""}exit 0\n`;
    for (const h of ["pre-push", "post-checkout", "fsmonitor"]) writeFileSync(join(evil, h), spy(false), { mode: 0o755 });
    writeFileSync(join(evil, "reference-transaction"), spy(true), { mode: 0o755 });
    const plant = (repo) => {
      g(["-C", repo, "config", "core.hooksPath", evil]);
      g(["-C", repo, "config", "core.fsmonitor", join(evil, "fsmonitor")]);
    };
    const was = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global2;
    const asked = [];
    setGitAuth({ cacheRoot: join(dir, "repos"), token: async (slug, write) => (asked.push([slug, write]), slug === "aidenhq-demo/x" ? "ghs_t" : undefined) });
    try {
      mkdirSync(join(dir, "repos", "aidenhq-demo"), { recursive: true });
      const cache = join(dir, "repos", "aidenhq-demo", "x");
      await git(join(dir, "repos", "aidenhq-demo"), "clone", "--quiet", url, cache);
      plant(cache);
      const ws = join(dir, "ws");
      g(["clone", "-q", cache, ws]);
      g(["-C", ws, "remote", "set-url", "origin", url]);
      plant(ws);
      await git(ws, "fetch", "--quiet", "--prune", "origin");
      assert.match(await git(ws, "ls-remote", "--heads", "origin"), /refs\/heads\/main/);
      g(["-C", ws, "commit", "-q", "--allow-empty", "-m", "two"]);
      await git(ws, "push", "--no-verify", url, "HEAD:refs/heads/feature");
      assert.equal(g(["--git-dir", join(dir, "remote.git"), "rev-parse", "feature"]).trim(), g(["-C", ws, "rev-parse", "HEAD"]).trim());
      await git(ws, "fetch", "--quiet", "origin", "+refs/heads/feature:refs/remotes/origin/feature");
      assert.equal(g(["-C", ws, "rev-parse", "refs/remotes/origin/feature"]).trim(), g(["-C", ws, "rev-parse", "HEAD"]).trim());
      assert.ok(asked.every(([slug]) => slug === "aidenhq-demo/x"));
      assert.ok(asked.some(([, write]) => write));
    } finally {
      setGitAuth(undefined);
      if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = was;
    }
    const seen = readFileSync(leak, "utf8");
    assert.match(seen, /^x$/m); // the planted hooks did run (in the workspace)...
    assert.ok(!seen.includes("ghs_t")); // ...but never with the token
    assert.equal(appSlugOf("http://github.com/a/b"), undefined);
    assert.equal(appSlugOf("git@github.com:a/b.git"), undefined);
    assert.equal(appSlugOf("https://x-access-token@github.com/a/b.git"), "a/b");
  });

  it("the helper refuses plain http", () => {
    const { args, env: e } = withGitToken(["credential", "fill"], env, "ghs_secret");
    assert.throws(() => execFileSync("git", args, { cwd: dir, env: { ...e, GIT_TERMINAL_PROMPT: "0" }, input: "protocol=http\nhost=github.com\n\n", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }));
  });
});

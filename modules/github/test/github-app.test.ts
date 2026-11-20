import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IDENTITY, READ, WRITE, identityEnv, appClient, appSlugOf, appJwt, appRemoteUrl, ghOptions, mergePermissions, pushPermissions, withGitToken } from "../service/src/github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

// Installed on aidenhq-demo (all repos) and Acme (only `selected`).
function fakeGitHub({ repos = [], refuseCreationPerm = false, status, botStatus } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body, auth: init.headers.authorization });
    const res = (status, json) => ({ status, json: async () => json });
    if (path === "/app") return res(200, { id: 123, slug: "aidenhq-demo" });
    // The bot user, read with an installation token (GET /user) or publicly (/users/<slug>[bot]).
    if (path === "/user" || path === "/users/aidenhq-demo%5Bbot%5D") return botStatus ? res(botStatus, { message: "refused" }) : res(200, { id: 99, login: "aidenhq-demo[bot]" });
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

  it("a push asks for Workflows: write on the agents org and the product repo, Contents only elsewhere", () => {
    // The App declares Workflows: write, but a token that narrows it away is refused by GitHub when the push touches
    // .github/workflows/: the product repo's own CI could not land.
    const perms = (slug, write = true) => pushPermissions(write, slug, "acme-agents", "acme/aidenhq");
    assert.deepEqual(perms("acme/aidenhq"), { contents: "write", workflows: "write" }, "the product repo");
    assert.deepEqual(perms("ACME/AidenHQ"), { contents: "write", workflows: "write" }, "the same repo, any case");
    assert.deepEqual(perms("acme-agents/app"), { contents: "write", workflows: "write" }, "the agents org, as before");
    assert.deepEqual(perms("acme/other"), { contents: "write" }, "another repo in the product's org");
    assert.deepEqual(perms("someone/app"), { contents: "write" }, "another org: its own CI standard gates workflow files");
    assert.deepEqual(perms("acme/aidenhq", false), { contents: "read" }, "a read token never gains Workflows");
    assert.deepEqual(perms(undefined, false), { contents: "read" }, "nor without a repo");
    // A merge and a branch update create a commit on the base branch, so the product repo needs it on those paths too.
    assert.deepEqual(mergePermissions("acme/aidenhq", "acme/aidenhq"), { ...WRITE, workflows: "write" });
    assert.deepEqual(mergePermissions("acme-agents/app", "acme/aidenhq"), WRITE);
    assert.deepEqual(mergePermissions("someone/app", "acme/aidenhq"), WRITE);
    assert.deepEqual(mergePermissions("acme/aidenhq", undefined), WRITE);
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

  it("commits as the App's bot, resolved once; never the owner's identity", async () => {
    const { app, calls } = fakeGitHub();
    const who = { name: "aidenhq-demo[bot]", email: "99+aidenhq-demo[bot]@users.noreply.github.com" };
    assert.deepEqual(await app.identity(), who);
    assert.deepEqual(await app.identity(), who);
    assert.equal(calls.filter((c) => c.path === "/app").length, 1);
    assert.equal(calls.filter((c) => c.path === "/users/aidenhq-demo%5Bbot%5D").length, 0, "the authenticated read answered first");
    assert.deepEqual(identityEnv(DEFAULT_IDENTITY), { GIT_AUTHOR_NAME: "AidenHQ agent", GIT_AUTHOR_EMAIL: "agent@aidenhq.invalid", GIT_COMMITTER_NAME: "AidenHQ agent", GIT_COMMITTER_EMAIL: "agent@aidenhq.invalid" });
  });

  it("commits as the App's bot with the fallback email when GitHub refuses the bot user, and doesn't cache the miss", async () => {
    const fallback = { name: "aidenhq-demo[bot]", email: "aidenhq-demo[bot]@users.noreply.github.com" };
    for (const botStatus of [403, 500]) {
      const { app, calls } = fakeGitHub({ botStatus });
      assert.deepEqual(await app.identity(), fallback, `bot user read answered ${botStatus}`);
      const botReads = () => calls.filter((c) => c.path === "/user" || c.path.startsWith("/users/")).length;
      assert.equal(botReads(), 4, "one retry each on GET /user and the public route");
      // A failed lookup isn't cached as a success: the next call reads again.
      assert.deepEqual(await app.identity(), fallback);
      assert.equal(botReads(), 8);
      assert.equal(calls.filter((c) => c.path === "/app").length, 1, "GET /app is still read once");
    }
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

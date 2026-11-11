import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repoAccess } from "../src/repos.mjs";

function fake({ exists = [], owner = "ownerdev", routed = "" } = {}) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === "/user") return { status: 200, body: { login: owner } };
    if (method === "GET") return { status: exists.includes(path.replace("/repos/", "")) ? 200 : 404, body: {} };
    return { status: 201, body: {} };
  };
  const sh = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return cmd === "git" ? routed : "";
  };
  return { calls, access: repoAccess({ token: "t", script: "/s.sh", api, sh }) };
}

describe("repoAccess", () => {
  it("creates a missing repo in the token owner's account, private, and never elsewhere", async () => {
    const f = fake();
    assert.equal(await f.access.ensureExists("ownerdev/new-app"), "created");
    assert.deepEqual(f.calls.find((c) => c[0] === "POST"), ["POST", "/user/repos", { name: "new-app", private: true, auto_init: true }]);
    const g = fake();
    assert.equal(await g.access.ensureExists("Acme/new-app"), "missing");
    assert.ok(!g.calls.some((c) => c[0] === "POST"));
    const h = fake({ exists: ["ownerdev/old"] });
    assert.equal(await h.access.ensureExists("ownerdev/old"), "exists");
  });

  it("adds a deploy key before a push only when the repo has no push route yet", async () => {
    const f = fake();
    await f.access.ensureWritable("ownerdev/new-app");
    assert.ok(f.calls.some((c) => c[0] === "bash" && c[1] === "/s.sh" && c[2] === "ownerdev/new-app"));
    const g = fake({ routed: "url.git@github-ownerdev-new-app:ownerdev/new-app.pushinsteadof https://github.com/ownerdev/new-app\n" });
    await g.access.ensureWritable("ownerdev/new-app");
    assert.ok(!g.calls.some((c) => c[0] === "bash"));
    const none = repoAccess({ token: "", script: "/s.sh", api: async () => assert.fail(), sh: async () => assert.fail() });
    assert.equal(await none.ensureExists("ownerdev/x"), "unknown");
    await none.ensureWritable("ownerdev/x");
  });
});

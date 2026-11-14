import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repoAccess } from "../src/repos.mjs";

function fake({ routed = "" } = {}) {
  const calls = [];
  const sh = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return cmd === "git" ? routed : "";
  };
  return { calls, access: repoAccess({ token: "t", script: "/s.sh", sh }) };
}

describe("repoAccess", () => {
  it("adds a deploy key before a push only when the repo has no push route yet", async () => {
    const f = fake();
    await f.access.ensureWritable("ownerdev/new-app");
    assert.ok(f.calls.some((c) => c[0] === "bash" && c[1] === "/s.sh" && c[2] === "ownerdev/new-app"));
    const g = fake({ routed: "url.git@github-ownerdev-new-app:ownerdev/new-app.pushinsteadof https://github.com/ownerdev/new-app\n" });
    await g.access.ensureWritable("ownerdev/new-app");
    assert.ok(!g.calls.some((c) => c[0] === "bash"));
    const none = repoAccess({ token: "", script: "/s.sh", sh: async () => assert.fail() });
    await none.ensureWritable("ownerdev/x");
  });
});

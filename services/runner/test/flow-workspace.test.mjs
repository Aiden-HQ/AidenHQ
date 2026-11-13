// End to end (see flow-harness.mjs): a task workspace a runner restart keeps, with the empty, read-only `.git` a job's
// sandbox mounts over its root left behind. The runner's own git refused every clone in such a task, so its next turn
// could do nothing and read as "Done, nothing changed".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

describe("flow-workspace", () => {
  const t = flow();

  it("clones into a task workspace a job left with an empty root .git, and never fails it as a no-op", async () => {
    const { waitFor, partComments, claudeRuns, toolRuns, step, say, reviews, running, settled } = t;
    await settled();
    const ws = join(t.dir, "work/tasks/PEN-2");
    // A repository the task hasn't cloned yet, and the mount point a job's sandbox leaves at the workspace root.
    git(t.dir, "clone", "-q", "--bare", join(t.dir, "src/acme/app"), join(t.dir, "github/acme/extra.git"));
    mkdirSync(join(ws, ".git"), { recursive: true });
    chmodSync(join(ws, ".git"), 0o555);
    const replies = reviews().length;
    step("none\naidenhq repo acme/extra");
    say("Clone the extra repository and say where it is.");
    await waitFor("the turn's reply", () => reviews().length > replies, 60_000);
    await waitFor("quiet", () => !running());
    const tool = toolRuns().findLast((r) => r.line === "aidenhq repo acme/extra");
    assert.ok(tool, "the agent cloned it in its turn");
    assert.equal(tool.code, 0, tool.out);
    assert.match(tool.out, /acme\/extra is at .*default branch main/, "the clone that was refused before now works");
    assert.equal(existsSync(join(ws, ".git")), false, "the empty mount point is cleared");
    assert.ok(!partComments().some((c) => /isn't a valid git directory|Runner error/.test(c)), "no refusal, no runner error");
    assert.ok(!partComments().some((c) => /Done, nothing changed/.test(c)), "never passed off as a no-op");
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});

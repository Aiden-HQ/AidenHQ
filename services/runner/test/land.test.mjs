import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { landOnMain } from "../src/git.mjs";

const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "land-"));
  sh(dir, "init", "-q", "--bare", "origin.git");
  const work = join(dir, "work");
  sh(dir, "clone", "-q", "origin.git", "work");
  sh(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "a.md"), "one\ntwo\nthree\n");
  writeFileSync(join(work, "b.md"), "b\n");
  sh(work, "add", "."), sh(work, "commit", "-qm", "base");
  sh(work, "push", "-q", "origin", "main");
  return work;
}

describe("landing the shown commit on main", () => {
  it("applies the shown change onto a main that moved on", async () => {
    const w = repo();
    sh(w, "checkout", "-q", "-b", "task");
    writeFileSync(join(w, "a.md"), "ONE\ntwo\nthree\n");
    sh(w, "commit", "-qam", "feat: shout");
    const shown = sh(w, "rev-parse", "HEAD");
    sh(w, "checkout", "-q", "main");
    writeFileSync(join(w, "b.md"), "b2\n");
    sh(w, "commit", "-qam", "unrelated");
    sh(w, "push", "-q", "origin", "main");
    const mainTip = sh(w, "rev-parse", "HEAD");
    const sha = await landOnMain(w, "main", shown, "Applied by the owner's words on WOR-1");
    assert.equal(sh(w, "rev-parse", `${sha}^`), mainTip);
    assert.equal(sh(w, "show", `${sha}:a.md`), "ONE\ntwo\nthree");
    assert.equal(sh(w, "show", `${sha}:b.md`), "b2");
    assert.equal(sh(w, "--git-dir=../origin.git", "rev-parse", "main"), sha);
    assert.match(sh(w, "log", "-1", "--format=%B", sha), /feat: shout[\s\S]*Applied by the owner/);
  });

  it("refuses a change that conflicts with main", async () => {
    const w = repo();
    sh(w, "checkout", "-q", "-b", "task");
    writeFileSync(join(w, "a.md"), "mine\ntwo\nthree\n");
    sh(w, "commit", "-qam", "mine");
    const shown = sh(w, "rev-parse", "HEAD");
    sh(w, "checkout", "-q", "main");
    writeFileSync(join(w, "a.md"), "theirs\ntwo\nthree\n");
    sh(w, "commit", "-qam", "theirs");
    sh(w, "push", "-q", "origin", "main");
    assert.equal(await landOnMain(w, "main", shown, "x"), null);
    assert.equal(readFileSync(join(w, "a.md"), "utf8"), "theirs\ntwo\nthree\n");
  });
});

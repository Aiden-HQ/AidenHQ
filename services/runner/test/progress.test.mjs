import { test } from "node:test";
import assert from "node:assert/strict";
import { namedRefs } from "../src/progress.ts";

test("a brief's commits and branches are found", () => {
  assert.deepEqual(namedRefs("rebase onto commit `0123456789abcdef`, work on branch `feat/x` in 1234567 files"), { shas: ["0123456789abcdef"], branches: ["feat/x"] });
  assert.deepEqual(namedRefs("start from branch `feat/x`").branches, ["feat/x"]);
});

test("a hostile ref in a brief runs nothing", async () => {
  const { staleRef } = await import("../src/progress.ts");
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "progress-"));
  execFileSync("git", ["init", "-q", dir]);
  const marker = join(dir, "ran");
  const brief = `rebase on branch \`--upload-pack=touch${marker}\` after commit \`0123456789abcdef\``;
  assert.match(await staleRef(brief, [dir]), /isn't in the repository/);
  assert.match(await staleRef(`from branch \`--upload-pack=touch${marker}\``, [dir]), /isn't a branch name/);
  assert.match(await staleRef("onto branch `a..b`", [dir]), /isn't a branch name/);
  assert.equal(existsSync(marker), false);
});

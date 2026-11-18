// A repo's fast check run where its dispatcher says (a box job: its own box), its failure going back as the refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastChecks } from "../src/fastcheck.ts";

test("the fast check runs through the given jail, and its failure is the refusal", async () => {
  const path = mkdtempSync(join(tmpdir(), "fastcheck-"));
  const g = (...a) => execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { "aidenhq:fast-check": "echo type error here; exit 3" } }));
  g("add", ".");
  g("commit", "-qm", "x");
  g("checkout", "-qb", "work");
  const ran = [];
  const refused = await fastChecks({ cfg: {}, log: () => {}, git: async (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim(), jail: (argv, at) => (ran.push([argv.join(" "), at]), argv) }, [{ repo: "acme/app", branch: "work", path, baseRef: "main" }]);
  assert.deepEqual(ran, [["true", path], ["npm run --silent aidenhq:fast-check", path]]);
  assert.match(refused, /fast check .* failed \(exit 3\)[\s\S]*type error here/);
});

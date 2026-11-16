// What a turn costs in git must not grow with the old branches a task has piled up: each is answered from what never changes
// (commit counts between two commits) or from the refs as they were, and only a branch that moved is looked at again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseRef, branchChanges, findBranches } from "../../../modules/codehost-github/src/workspace.ts";

const ID = ["-c", "user.name=t", "-c", "user.email=t@example.com"];

/** A clone with `old` branches, each pushed (no PR), looked at once; then one new branch. Returns the git calls that costs. */
async function newBranchCost(old) {
  const dir = mkdtempSync(join(tmpdir(), "turn-cost-"));
  const g = (cwd, ...a) => execFileSync("git", [...ID, ...a], { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  g(dir, "init", "-q", "--bare", "-b", "main", origin);
  g(dir, "clone", "-q", origin, work);
  writeFileSync(join(work, "README.md"), "x\n");
  g(work, "add", ".");
  g(work, "commit", "-qm", "init");
  g(work, "push", "-q", "origin", "main");
  const branch = (name) => {
    g(work, "switch", "-q", "-c", name, "main");
    writeFileSync(join(work, `${name.replace("/", "-")}.txt`), `${name}\n`);
    g(work, "add", ".");
    g(work, "commit", "-qm", `feat: ${name}`);
    g(work, "push", "-q", "origin", name);
  };
  for (let i = 0; i < old; i++) branch(`feat/old${i}`);
  g(work, "switch", "-q", "main");
  const turn = async () => {
    const names = g(work, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter((b) => b !== "main");
    const found = await findBranches(work, { base: "main", known: names });
    for (const b of found) await branchChanges(work, { branch: b.branch, base: b.base, taskBranches: names }), await baseRef(work, { branch: b.branch, base: b.base, taskBranches: names });
    return found.length;
  };
  await turn(); // an earlier turn saw the old branches
  branch("feat/new");
  g(work, "switch", "-q", "main");
  // From here every git process the runner starts is counted.
  const log = join(dir, "calls.log");
  const real = execFileSync("which", ["git"]).toString().trim();
  writeFileSync(join(dir, "git"), `#!/bin/sh\necho x >> "${log}"\nexec ${real} "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  writeFileSync(log, "");
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    assert.equal(await turn(), old + 1, "every branch is still found");
  } finally {
    process.env.PATH = path;
  }
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  rmSync(dir, { recursive: true, force: true });
  return calls;
}

test("a turn's git calls don't grow with the old branches a task has (one new branch beside 2, or beside 10)", async () => {
  const few = await newBranchCost(2);
  const many = await newBranchCost(10);
  assert.ok(many - few <= 6, `${few} git calls with 2 old branches, ${many} with 10`);
});
